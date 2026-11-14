// PassBridge Code Reader: a one-shot helper. The relay launches it with --socket P, it presses Allow on Apple's
// sign-in prompt, reads the 6-digit code from the prompt, presses Done and sends the code over the socket.
// It writes nothing to stderr or disk. The code exists only in a local String and the socket write.
import AppKit
import ApplicationServices
import Foundation

// MARK: config

struct ButtonMatch: Decodable {
    var identifier: String?
    var title: String?
}

struct PromptConfig: Decodable {
    var bundleIds: [String]
    var allowButton: ButtonMatch
    var doneButton: ButtonMatch
    var codePattern: String
    var timeoutMs: Int

    // the recorded values replace the TODO-DESCRIBE placeholders; until then nothing is pressed
    var isConfigured: Bool {
        var all = bundleIds + [codePattern]
        for b in [allowButton, doneButton] {
            all.append(b.identifier ?? "")
            all.append(b.title ?? "")
        }
        return !all.contains { $0.hasPrefix("TODO-DESCRIBE") }
    }
}

// MARK: screen

struct ButtonSnap: Decodable {
    var identifier: String?
    var title: String?
}

struct WindowSnap: Decodable {
    var key: String
    var bundleId: String
    var buttons: [ButtonSnap]
    var texts: [String]
}

protocol Screen {
    func windows() -> [WindowSnap]
    func press(_ key: String, _ b: ButtonMatch) -> Bool
}

func matches(_ b: ButtonSnap, _ m: ButtonMatch) -> Bool {
    if m.identifier == nil && m.title == nil { return false }
    if let i = m.identifier, i != b.identifier { return false }
    if let t = m.title, t != b.title { return false }
    return true
}

func isCode(_ text: String, _ pattern: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(of: pattern, options: .regularExpression) != nil
}

func digitsOnly(_ s: String) -> String {
    return s.filter { $0.isNumber }
}

// MARK: decision

enum Decision: Equatable {
    case wait
    case several
    case pressAllow(String)
    case code(String, String)
    case failed
}

// fresh: windows that were not there when the request came in
func decide(fresh: [WindowSnap], config: PromptConfig) -> Decision {
    let own = fresh.filter { config.bundleIds.contains($0.bundleId) }
    var relevant: [(WindowSnap, Bool, [String])] = []
    for w in own {
        let hasAllow = w.buttons.contains { matches($0, config.allowButton) }
        var codes: [String] = []
        for t in w.texts where isCode(t, config.codePattern) {
            let d = digitsOnly(t)
            if !codes.contains(d) { codes.append(d) }
        }
        if hasAllow || !codes.isEmpty { relevant.append((w, hasAllow, codes)) }
    }
    if relevant.isEmpty { return .wait }
    if relevant.count > 1 { return .several }
    let (w, hasAllow, codes) = relevant[0]
    if codes.count >= 2 { return .failed }
    if codes.count == 1 { return .code(codes[0], w.key) }
    if hasAllow { return .pressAllow(w.key) }
    return .wait
}

enum Outcome: Equatable {
    case ok(String)
    case error(String)
    case cancelled
}

// the whole read, shared by the real screen and the fixtures. tick is 200 ms
func readCode(screen: Screen, config: PromptConfig, sleep: () -> Void, cancelled: () -> Bool) -> Outcome {
    if !config.isConfigured { return .error("not_configured") }
    let baseline = Set(screen.windows().map { $0.key })
    var pressed = Set<String>()
    var ms = 0
    while ms < config.timeoutMs {
        if cancelled() { return .cancelled }
        var fresh = screen.windows().filter { !baseline.contains($0.key) }
        // an Allow button already pressed is not a second prompt
        fresh = fresh.map { w in
            guard pressed.contains(w.key) else { return w }
            var c = w
            c.buttons = w.buttons.filter { !matches($0, config.allowButton) }
            return c
        }
        switch decide(fresh: fresh, config: config) {
        case .wait:
            break
        case .several:
            return .error("several_prompts")
        case .failed:
            return .error("reader_failed")
        case .pressAllow(let key):
            if !pressed.contains(key) {
                pressed.insert(key)
                _ = screen.press(key, config.allowButton)
            }
        case .code(let c, let key):
            _ = screen.press(key, config.doneButton)
            return .ok(c)
        }
        sleep()
        ms += 200
    }
    return .error("no_prompt")
}

// MARK: real screen (Accessibility)

final class AXScreen: Screen {
    let config: PromptConfig
    private var elements: [String: [(ButtonSnap, AXUIElement)]] = [:]
    init(config: PromptConfig) { self.config = config }

    func windows() -> [WindowSnap] {
        var out: [WindowSnap] = []
        elements = [:]
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier, config.bundleIds.contains(bid) else { continue }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw) == .success,
                  let wins = raw as? [AXUIElement] else { continue }
            for win in wins {
                let key = "\(app.processIdentifier)-\(CFHash(win))"
                var buttons: [(ButtonSnap, AXUIElement)] = []
                var texts: [String] = []
                walk(win, depth: 0) { el, role in
                    if role == "AXButton" {
                        buttons.append((ButtonSnap(identifier: attr(el, "AXIdentifier"), title: attr(el, kAXTitleAttribute as String)), el))
                    } else if role == "AXStaticText", let v = attr(el, kAXValueAttribute as String) {
                        texts.append(v)
                    }
                }
                elements[key] = buttons
                out.append(WindowSnap(key: key, bundleId: bid, buttons: buttons.map { $0.0 }, texts: texts))
            }
        }
        return out
    }

    func press(_ key: String, _ b: ButtonMatch) -> Bool {
        guard let list = elements[key] else { return false }
        for (snap, el) in list where matches(snap, b) {
            return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
        }
        return false
    }
}

func attr(_ el: AXUIElement, _ name: String) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &raw) == .success else { return nil }
    return raw as? String
}

func walk(_ el: AXUIElement, depth: Int, _ visit: (AXUIElement, String) -> Void) {
    if depth > 12 { return }
    visit(el, attr(el, kAXRoleAttribute as String) ?? "")
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &raw) == .success,
          let kids = raw as? [AXUIElement] else { return }
    for k in kids { walk(k, depth: depth + 1, visit) }
}

// MARK: fixtures (tests)

struct TimelineEntry: Decodable {
    var tick: Int
    var windows: [WindowSnap]
}

struct Expect: Decodable {
    var result: String
    var code: String?
    var pressed: [String]
}

struct Fixture: Decodable {
    var config: PromptConfig
    var timeline: [TimelineEntry]
    var expect: Expect
}

final class FixtureScreen: Screen {
    let timeline: [TimelineEntry]
    var tick = 0
    var pressed: [String] = []
    init(timeline: [TimelineEntry]) { self.timeline = timeline.sorted { $0.tick < $1.tick } }

    func windows() -> [WindowSnap] {
        var cur: [WindowSnap] = []
        for e in timeline where e.tick <= tick { cur = e.windows }
        return cur
    }

    func press(_ key: String, _ b: ButtonMatch) -> Bool {
        pressed.append("\(key):\(b.identifier ?? b.title ?? "")")
        return true
    }
}

func callerSelfTest() -> Bool {
    let app = "/Users/u/Library/Application Support/PassBridge"
    let relay = ["/usr/bin/python3", app + "/passbridge-agent.py", "--run"]
    let sock = app + "/reader-ab12.sock"
    let cases: [(String, Bool, Bool)] = [
        ("caller relay", callerIsRelay(socketPath: sock, peerArgs: relay, appDir: app), true),
        ("caller foreign script", callerIsRelay(socketPath: sock, peerArgs: ["/usr/bin/python3", "/tmp/evil.py"], appDir: app), false),
        ("caller foreign socket path", callerIsRelay(socketPath: "/tmp/reader-ab12.sock", peerArgs: relay, appDir: app), false),
        ("caller socket name", callerIsRelay(socketPath: app + "/other.sock", peerArgs: relay, appDir: app), false),
        ("caller unreadable peer", callerIsRelay(socketPath: sock, peerArgs: nil, appDir: app), false),
        ("caller script only as program", callerIsRelay(socketPath: sock, peerArgs: [app + "/passbridge-agent.py"], appDir: app), false),
    ]
    var good = true
    for (n, got, want) in cases {
        print((got == want ? "PASS " : "FAIL ") + n)
        if got != want { good = false }
    }
    return good
}

func selfTest(_ dir: String) -> Int32 {
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    var failed = names.isEmpty || !callerSelfTest()
    for n in names {
        let name = String(n.dropLast(5))
        guard let data = FileManager.default.contents(atPath: dir + "/" + n),
              let fx = try? JSONDecoder().decode(Fixture.self, from: data) else {
            print("FAIL \(name)")
            failed = true
            continue
        }
        let screen = FixtureScreen(timeline: fx.timeline)
        let out = readCode(screen: screen, config: fx.config, sleep: { screen.tick += 1 }, cancelled: { false })
        var result = ""
        var code: String? = nil
        switch out {
        case .ok(let c): result = "ok"; code = c
        case .error(let e): result = e
        case .cancelled: result = "cancelled"
        }
        let good = result == fx.expect.result && code == fx.expect.code && screen.pressed == fx.expect.pressed
        print((good ? "PASS " : "FAIL ") + name)
        if !good { failed = true }
    }
    return failed ? 1 : 0
}

// MARK: --describe (records the prompt's Accessibility tree, digits hidden)

func describe(_ filter: String?) {
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        let bid = app.bundleIdentifier ?? ""
        if let f = filter, bid != f, app.localizedName != f { continue }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw) == .success,
              let wins = raw as? [AXUIElement], !wins.isEmpty else { continue }
        print("app \(bid)")
        for win in wins { dump(win, 1) }
    }
}

func dump(_ el: AXUIElement, _ depth: Int) {
    if depth > 12 { return }
    var parts = [attr(el, kAXRoleAttribute as String) ?? "?"]
    for (label, name) in [("id", "AXIdentifier"), ("title", kAXTitleAttribute as String), ("value", kAXValueAttribute as String)] {
        if let v = attr(el, name), !v.isEmpty { parts.append("\(label)=\(v)") }
    }
    let line = String(repeating: "  ", count: depth) + parts.joined(separator: " ")
    print(String(line.map { $0.isNumber ? "•" : $0 }))
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &raw) == .success,
          let kids = raw as? [AXUIElement] else { return }
    for k in kids { dump(k, depth + 1) }
}

// MARK: socket

func connectSocket(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return nil }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    if bytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { close(fd); return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
        for (i, b) in bytes.enumerated() { p[i] = b }
        p[bytes.count] = 0
    }
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if ok != 0 { close(fd); return nil }
    return fd
}

func sendLine(_ fd: Int32, _ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(10)
    data.withUnsafeBytes { p in
        var off = 0
        while off < data.count {
            let n = write(fd, p.baseAddress!.advanced(by: off), data.count - off)
            if n <= 0 { return }
            off += n
        }
    }
}

// the relay closing its end is the cancel
func peerClosed(_ fd: Int32) -> Bool {
    var b: UInt8 = 0
    let n = recv(fd, &b, 1, MSG_PEEK | MSG_DONTWAIT)
    return n == 0
}

func loadConfig() -> PromptConfig? {
    guard let url = Bundle.main.url(forResource: "prompt", withExtension: "json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(PromptConfig.self, from: data)
}

// who may be on the other end: the socket is one the relay made in the app folder, and the process listening on it
// is the PassBridge relay script installed there. A pure function, so the self-test can try foreign callers.
func callerIsRelay(socketPath: String, peerArgs: [String]?, appDir: String) -> Bool {
    guard let args = peerArgs else { return false }
    let sock = URL(fileURLWithPath: socketPath).standardizedFileURL
    let dir = URL(fileURLWithPath: appDir).standardizedFileURL
    let name = sock.lastPathComponent
    guard sock.deletingLastPathComponent().path == dir.path, name.hasPrefix("reader-"), name.hasSuffix(".sock") else { return false }
    return args.dropFirst().contains(dir.path + "/passbridge-agent.py")
}

// the arguments of a process (the executable path is skipped), from the kernel
func processArgs(_ pid: pid_t) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    if sysctl(&mib, 3, nil, &size, nil, 0) != 0 || size < 8 { return nil }
    var buf = [UInt8](repeating: 0, count: size)
    if sysctl(&mib, 3, &buf, &size, nil, 0) != 0 { return nil }
    let argc = Int(buf[0]) | Int(buf[1]) << 8 | Int(buf[2]) << 16 | Int(buf[3]) << 24
    let parts = buf[4..<size].split(separator: 0, omittingEmptySubsequences: true)
    return parts.prefix(argc + 1).map { String(decoding: $0, as: UTF8.self) }
}

func peerPid(_ fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var len = socklen_t(MemoryLayout<pid_t>.size)
    if getsockopt(fd, 0 /* SOL_LOCAL */, 0x002 /* LOCAL_PEERPID */, &pid, &len) != 0 || pid <= 0 { return nil }
    return pid
}

func normalRun(socketPath: String) -> Int32 {
    // the nonce is in a file next to the socket, read once and removed
    let nonceFile = socketPath + ".nonce"
    guard let nonceData = FileManager.default.contents(atPath: nonceFile),
          let nonce = String(data: nonceData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !nonce.isEmpty else { return 1 }
    try? FileManager.default.removeItem(atPath: nonceFile)
    guard let fd = connectSocket(socketPath) else { return 1 }
    defer { close(fd) }
    // refuse a caller that is not the relay: no Allow is pressed and nothing is sent
    let appDir = NSHomeDirectory() + "/Library/Application Support/PassBridge"
    guard let pid = peerPid(fd), callerIsRelay(socketPath: socketPath, peerArgs: processArgs(pid), appDir: appDir) else { return 1 }
    sendLine(fd, ["nonce": nonce, "state": "started"])
    func fail(_ e: String) -> Int32 {
        sendLine(fd, ["nonce": nonce, "ok": false, "error": e])
        return 0
    }
    guard let config = loadConfig() else { return fail("not_configured") }
    if !config.isConfigured { return fail("not_configured") }
    if !AXIsProcessTrusted() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        return fail("reader_permission")
    }
    let screen = AXScreen(config: config)
    let out = readCode(screen: screen, config: config, sleep: { usleep(200_000) }, cancelled: { peerClosed(fd) })
    switch out {
    case .cancelled: return 0
    case .error(let e): return fail(e)
    case .ok(let c):
        sendLine(fd, ["nonce": nonce, "ok": true, "code": c])
        return 0
    }
}

// MARK: main

let args = CommandLine.arguments
func value(after flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if let dir = value(after: "--self-test") {
    exit(selfTest(dir))
} else if args.contains("--describe") {
    describe(value(after: "--describe"))
    exit(0)
} else if let p = value(after: "--socket") {
    exit(normalRun(socketPath: p))
} else {
    exit(2)
}
