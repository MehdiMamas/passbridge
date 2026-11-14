# round trip through the real agent relay: a fake stdio "extension" answers each forwarded request,
# the real CLI sends requests. macOS uses the unix socket, Windows the named pipe; on Windows a client
# with the wrong key must be refused.
import getpass
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RELAY = ROOT / "native" / "passbridge-agent.py"
CLI = ROOT / "native" / "passbridge-agent-cli.py"
WINDOWS = os.name == "nt"
TMP = tempfile.mkdtemp(prefix="pb-agent-")
ENV = {**os.environ, "PASSBRIDGE_APPDIR": TMP, "PASSBRIDGE_NO_WSL_REEXEC": "1"}
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


class Relay:
    # one relay process plus its fake stdio "extension": answers each forwarded request, records events
    def __init__(self, name):
        self.name = name
        self.events = []
        self.proc = subprocess.Popen([sys.executable, "-I", str(RELAY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while True:
            raw = self.proc.stdout.read(4)
            if len(raw) < 4:
                return
            (n,) = struct.unpack("<I", raw)
            req = json.loads(self.proc.stdout.read(n))
            if "id" not in req:
                self.events.append(req.get("event"))
                continue
            reply = {"id": req["id"], "ok": True, "op": req["op"], "tabId": req.get("tabId"), "site": req.get("site"), "by": self.name}
            b = json.dumps(reply).encode()
            self.proc.stdin.write(struct.pack("<I", len(b)) + b)
            self.proc.stdin.flush()

    def wait_event(self, event, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if event in self.events:
                return True
            time.sleep(0.1)
        return False


relay = Relay("A")


def cli(*args):
    r = subprocess.run([sys.executable, "-I", str(CLI), *args], capture_output=True, text=True, env=ENV, timeout=30)
    try:
        return json.loads(r.stdout), r.returncode
    except ValueError:
        return {"raw": r.stdout, "err": r.stderr}, r.returncode


reply, code = None, None
for _ in range(50):  # the relay needs a moment to start listening
    reply, code = cli("status")
    if reply.get("error") != "no_host":
        break
    time.sleep(0.2)
ok("status reaches the extension and the reply comes back", code == 0 and reply.get("ok") and reply.get("op") == "status", reply)
ok("the first relay answers", reply.get("by") == "A", reply)
relayB = Relay("B")
ok("a second relay reports standby", relayB.wait_event("standby", 10), relayB.events)
reply, code = cli("status")
ok("with two relays the first one still answers", reply.get("by") == "A", reply)
relay.proc.stdin.close()
relay.proc.wait(timeout=10)
ok("the second relay takes over within 10 s", relayB.wait_event("active", 10), relayB.events)
reply = None
for _ in range(50):
    reply, code = cli("status")
    if reply.get("ok"):
        break
    time.sleep(0.2)
ok("after the first relay exits the second one answers", reply.get("by") == "B", reply)
relay = relayB
reply, code = cli("sign_in", "7", "octocat")
ok("sign_in carries tabId through", code == 0 and reply.get("tabId") == 7 and reply.get("op") == "sign_in", reply)
reply, code = cli("logins", "x")
ok("a non-numeric tabId is refused by the CLI", code == 2)
reply, code = cli("verify-code", "5", "apple.com")
ok("CLI verify-code sends op verify_code with tabId and site", code == 0 and reply.get("op") == "verify_code" and reply.get("tabId") == 5 and reply.get("site") == "apple.com", reply)

if WINDOWS:
    from multiprocessing import AuthenticationError
    from multiprocessing.connection import Client

    pipe = r"\\.\pipe\passbridge-agent-" + getpass.getuser()
    refused = False
    try:
        Client(pipe, family="AF_PIPE", authkey=b"x" * 32).close()
    except (AuthenticationError, OSError, EOFError):
        refused = True
    ok("a client with the wrong key is refused", refused)
    reply, code = cli("status")
    ok("the right key still works after a refused client", code == 0 and reply.get("ok"), reply)
    ok("the key file is 32 bytes", os.path.getsize(os.path.join(TMP, "agent.key")) == 32)
else:
    print("SKIP wrong-key check (macOS uses a 0600 socket, no key)")
    ok("the socket is user-only", (os.stat(os.path.join(TMP, "agent.sock")).st_mode & 0o777) == 0o600)

relay.proc.stdin.close()
try:
    relay.proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    relay.proc.kill()
    ok("relay exits when the extension goes away", False)
else:
    ok("relay exits when the extension goes away", True)

# ---- the code reader: the relay is started with PASSBRIDGE_CODE_READER pointing at the fake reader ----
FAKE = ROOT / "test-harness" / "fake-code-reader.py"
DARWIN = sys.platform == "darwin"


def skip(name):
    print("SKIP " + name)


class CodeRelay:
    def __init__(self, with_reader=True, total_s=None, stdout=False):
        self.dir = tempfile.mkdtemp(prefix="pb-code-")
        env = {**os.environ, "PASSBRIDGE_APPDIR": self.dir, "PASSBRIDGE_NO_WSL_REEXEC": "1"}
        env.pop("PASSBRIDGE_CODE_READER", None)
        if total_s is not None:
            env["PASSBRIDGE_READER_TOTAL_S"] = str(total_s)
        if with_reader:
            env["PASSBRIDGE_CODE_READER"] = json.dumps([sys.executable, "-I", str(FAKE)] + (["--stdout"] if stdout else []))
            if stdout:
                env["PASSBRIDGE_READER_STDOUT"] = "1"
        self.err = open(os.path.join(tempfile.mkdtemp(prefix="pb-err-"), "stderr"), "w+b")
        self.proc = subprocess.Popen([sys.executable, "-I", str(RELAY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, env=env)
        self.msgs = []
        self.lock = threading.Lock()
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while True:
            raw = self.proc.stdout.read(4)
            if len(raw) < 4:
                return
            (n,) = struct.unpack("<I", raw)
            m = json.loads(self.proc.stdout.read(n))
            with self.lock:
                self.msgs.append(m)

    def path(self, name):
        return os.path.join(self.dir, name)

    def scenario(self, name):
        with open(self.path("fake-reader-scenario"), "w") as f:
            f.write(name)
        for n in ("fake-reader-exited", "fake-reader-connected", "fake-reader-argv", "fake-reader-beat"):
            try:
                os.unlink(self.path(n))
            except OSError:
                pass

    def send(self, obj):
        b = json.dumps(obj).encode()
        self.proc.stdin.write(struct.pack("<I", len(b)) + b)
        self.proc.stdin.flush()

    def wait_msg(self, pred, seconds):
        end = time.time() + seconds
        while time.time() < end:
            with self.lock:
                for m in self.msgs:
                    if pred(m):
                        return m
            time.sleep(0.02)
        return None

    def read(self, rid, scenario=None, seconds=15):
        if scenario:
            self.scenario(scenario)
        self.send({"cmd": "read_code", "rid": rid})
        return self.wait_msg(lambda m: m.get("event") == "code" and m.get("rid") == rid, seconds)

    def start(self, rid, scenario):
        self.scenario(scenario)
        self.send({"cmd": "read_code", "rid": rid})

    def code(self, rid, seconds=15):
        return self.wait_msg(lambda m: m.get("event") == "code" and m.get("rid") == rid, seconds)

    def wait_file(self, name, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if os.path.exists(self.path(name)):
                return True
            time.sleep(0.02)
        return False

    def beat_stops(self, within):
        # the hanging fake reader writes a heartbeat; it stops when the relay kills the process
        end = time.time() + within
        while time.time() < end:
            try:
                a = open(self.path("fake-reader-beat")).read()
            except OSError:
                a = ""
            time.sleep(0.4)
            try:
                b = open(self.path("fake-reader-beat")).read()
            except OSError:
                b = ""
            if a and a == b:
                return True
        return False

    def reader_files(self):
        return [n for n in os.listdir(self.dir) if n.startswith("reader-")]

    def stop(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def err(r):
    return r and r.get("error")


if not WINDOWS:
    cr = CodeRelay()
    ok("active event carries code: true", cr.wait_msg(lambda m: m.get("event") == "active" and m.get("code") is True, 10) is not None, cr.msgs)

    r = cr.read("ok1", "ok")
    ok("read_code ok -> code event with 6 digits", r and r.get("ok") is True and r.get("code") == "482915", r)
    r = cr.read("ok2", "ok_spaced")
    ok("read_code ok_spaced -> normalized", r and r.get("ok") is True and r.get("code") == "482915", r)
    ok("read_code wrong_nonce -> reader_failed", err(cr.read("wn", "wrong_nonce")) == "reader_failed")
    r = cr.read("bc", "bad_code")
    ok("read_code bad_code -> reader_failed", err(r) == "reader_failed" and "code" not in r, r)
    ok("read_code malformed JSON -> reader_failed", err(cr.read("mj", "malformed")) == "reader_failed")
    t0 = time.time()
    r = cr.read("cr", "crash")
    ok("read_code crash -> reader_failed in under 2 s", err(r) == "reader_failed" and time.time() - t0 < 2, (r, time.time() - t0))
    t0 = time.time()
    r = cr.read("lf", "launch_fails")
    took = time.time() - t0
    time.sleep(0.3)
    ps = subprocess.run(["ps", "-A", "-o", "ppid=,stat="], capture_output=True, text=True).stdout.split("\n")
    zombies = [ln for ln in ps if ln.split()[:1] == [str(cr.proc.pid)] and ln.split()[1:2] and ln.split()[1].startswith("Z")]
    ok("read_code launch_fails -> reader_failed in under 1 s, no zombie", err(r) == "reader_failed" and took < 1 and not zombies, (r, took, zombies))
    for sc, want in (("no_prompt", "no_prompt"), ("several_prompts", "several_prompts"), ("permission", "reader_permission"), ("not_configured", "not_configured")):
        got = err(cr.read("p-" + sc, sc))
        ok("read_code passes %s through" % sc, got == want, got)

    # never connects: the socket and nonce file exist while it waits, mode 0600, the folder is 0700, and the nonce is not in argv
    os.chmod(cr.dir, 0o755)
    t0 = time.time()
    cr.start("nc", "never_connect")
    time.sleep(0.6)
    socks = [n for n in cr.reader_files() if n.endswith(".sock")]
    nonces = [n for n in cr.reader_files() if n.endswith(".nonce")]
    sock_mode = os.stat(cr.path(socks[0])).st_mode & 0o777 if socks else None
    nonce_mode = os.stat(cr.path(nonces[0])).st_mode & 0o777 if nonces else None
    dir_mode = os.stat(cr.dir).st_mode & 0o777
    nonce_text = open(cr.path(nonces[0])).read().strip() if nonces else ""
    ok("one-shot socket mode 0600 while open, gone after", sock_mode == 0o600, sock_mode)
    ok("app folder at 0755 -> 0700 before bind", dir_mode == 0o700, oct(dir_mode))
    ok("nonce file mode 0600 while open", nonce_mode == 0o600 and len(nonce_text) == 32, (nonce_mode, nonce_text))
    argv_text = open(cr.path("fake-reader-argv")).read() if os.path.exists(cr.path("fake-reader-argv")) else ""
    ok("nonce not in the reader argv", bool(argv_text) and nonce_text not in argv_text and "--nonce" not in argv_text, argv_text)
    r = cr.code("nc", 20)
    ok("read_code never_connect -> reader_failed after about 10 s", err(r) == "reader_failed" and 9 < time.time() - t0 < 14, (r, time.time() - t0))
    time.sleep(0.2)
    ok("never_connect: socket and nonce file unlinked", cr.reader_files() == [], cr.reader_files())
    ok("one-shot socket and nonce file are gone after every outcome", cr.reader_files() == [] and socks != [], cr.reader_files())

    # the never_connect fake sleeps 12 s: let it finish before the next scenario resets the marker files
    cr.wait_file("fake-reader-exited", 5)

    # busy, cancel, a second connection
    cr.start("h1", "hang")
    ok("hang: the fake reader connected", cr.wait_file("fake-reader-connected", 5))
    argv = json.loads(open(cr.path("fake-reader-argv")).read())
    sockpath = argv[argv.index("--socket") + 1]
    import socket as _s

    c2 = _s.socket(_s.AF_UNIX, _s.SOCK_STREAM)
    refused = False
    try:
        c2.connect(sockpath)
    except OSError:
        refused = True
    c2.close()
    ok("second connection to the one-shot socket is refused", refused)
    r = cr.read("h2", "ok")
    ok("read_code while one runs -> busy", err(r) == "busy", r)
    ok("cancel with an old rid: the running read goes on", (cr.send({"cmd": "cancel_code", "rid": "stale"}), cr.code("h1", 1.0))[1] is None and not os.path.exists(cr.path("fake-reader-exited")))
    t0 = time.time()
    cr.send({"cmd": "cancel_code", "rid": "h1"})
    ok("cancel_code -> fake reader exits in under 1 s", cr.wait_file("fake-reader-exited", 1.5) and time.time() - t0 < 1, time.time() - t0)
    cr.code("h1", 3)

    # a read right after a cancel waits for the old one and runs
    cr.start("h3", "hang")
    cr.wait_file("fake-reader-connected", 5)
    cr.send({"cmd": "cancel_code", "rid": "h3"})
    cr.scenario("ok")
    cr.send({"cmd": "read_code", "rid": "after"})
    r = cr.code("after", 10)
    ok("read_code right after cancel_code -> runs, not busy", r and r.get("ok") is True and r.get("code") == "482915", r)

    # cancel while the reader is still launching: it cannot connect later
    cr.start("lc", "late_connect")
    time.sleep(0.3)
    t0 = time.time()
    cr.send({"cmd": "cancel_code", "rid": "lc"})
    r = cr.code("lc", 2)
    ok("cancel_code during launch -> reader_failed in under 1 s", err(r) == "reader_failed" and time.time() - t0 < 1, (r, time.time() - t0))
    cr.wait_file("fake-reader-exited", 6)
    ok("cancelled launch: the reader could not connect", not os.path.exists(cr.path("fake-reader-connected")) and cr.reader_files() == [])

    # a reader that connects and then hangs: the relay gives up at its total deadline (shortened here) and the reader is stopped
    cd = CodeRelay(total_s=1.5)
    t0 = time.time()
    cd.start("dl", "hang")
    r = cd.code("dl", 6)
    took = time.time() - t0
    ok("hanging reader -> reader_failed at the total deadline", err(r) == "reader_failed" and 1.2 < took < 4, (r, took))
    ok("hanging reader: the fake reader was stopped and its socket files are gone", cd.wait_file("fake-reader-exited", 3) and cd.reader_files() == [], cd.reader_files())
    cd.stop()

    # stdin closed mid-read
    cr2 = CodeRelay()
    cr2.start("m1", "hang")
    cr2.wait_file("fake-reader-connected", 5)
    t0 = time.time()
    cr2.proc.stdin.close()
    ok("relay stdin closed mid-read -> fake reader exits in under 1 s", cr2.wait_file("fake-reader-exited", 1.5) and time.time() - t0 < 1, time.time() - t0)
    cr2.stop()
    cr.stop()
    out = open(cr.err.name, "rb").read() + open(cr2.err.name, "rb").read()
    ok("relay stderr empty and code absent from the relay's stderr across all scenarios", out == b"", out)
else:
    for n in ("active event carries code: true", "read_code scenarios", "cancel and stdin-closed cases"):
        skip(n)

# ---- the stdout transport (Windows, and any OS with PASSBRIDGE_READER_STDOUT): the fake reader prints one JSON line ----
CODE = "482915"  # a made-up value
sr = CodeRelay(stdout=True)
ok("stdout: active event carries code: true", sr.wait_msg(lambda m: m.get("event") == "active" and m.get("code") is True, 10) is not None, sr.msgs)
r = sr.read("s-ok", "ok")
ok("stdout: happy path -> the 6 digits reach the extension", r and r.get("ok") is True and r.get("code") == CODE, r)
r = sr.read("s-sp", "ok_spaced")
ok("stdout: spaced digits are normalized", r and r.get("ok") is True and r.get("code") == CODE, r)
r = sr.read("s-bc", "bad_code")
ok("stdout: reader prints not 6 digits -> reader_failed", err(r) == "reader_failed" and "code" not in r, r)
ok("stdout: reader prints text that is not JSON -> reader_failed", err(sr.read("s-mj", "malformed")) == "reader_failed")
t0 = time.time()
r = sr.read("s-cr", "crash")
ok("stdout: reader crashes -> reader_failed at once", err(r) == "reader_failed" and time.time() - t0 < 3, (r, time.time() - t0))
ok("stdout: reader fails to start work and exits non-zero -> reader_failed", err(sr.read("s-lf", "launch_fails")) == "reader_failed")
r = sr.read("s-nz", "nonzero_exit")
ok("stdout: reader prints a code but exits non-zero -> reader_failed, no code", err(r) == "reader_failed" and "code" not in r, r)
for sc, want in (("no_prompt", "no_prompt"), ("several_prompts", "several_prompts"), ("permission", "reader_permission"), ("not_configured", "not_configured")):
    ok("stdout: %s is passed through" % sc, err(sr.read("s-" + sc, sc)) == want)

# busy, a stale cancel, and a real cancel that kills the child
sr.start("s-h1", "hang")
ok("stdout: hang: the fake reader started", sr.wait_file("fake-reader-connected", 5))
r = sr.read("s-h2", "ok")
ok("stdout: a second read_code while one runs -> busy", err(r) == "busy", r)
sr.scenario("hang")  # the busy read must not have disturbed the running one
sr.send({"cmd": "cancel_code", "rid": "stale"})
ok("stdout: cancel with an old rid: the running read goes on", sr.code("s-h1", 1.0) is None and not sr.beat_stops(0.9))
sr.send({"cmd": "cancel_code", "rid": "s-h1"})
r = sr.code("s-h1", 3)
ok("stdout: cancel_code -> reader_failed, no code sent", err(r) == "reader_failed" and "code" not in r, r)
ok("stdout: cancel_code kills the child", sr.beat_stops(4))

# a read right after a cancel runs
sr.start("s-h3", "hang")
sr.wait_file("fake-reader-connected", 5)
sr.send({"cmd": "cancel_code", "rid": "s-h3"})
sr.scenario("ok")
sr.send({"cmd": "read_code", "rid": "s-after"})
r = sr.code("s-after", 10)
ok("stdout: read_code right after cancel_code -> runs", r and r.get("ok") is True and r.get("code") == CODE, r)

# the code is in no argv, no file in the app folder and no stderr
argv_text = open(sr.path("fake-reader-argv")).read()
files_text = "".join(open(sr.path(n), "rb").read().decode("latin-1") for n in os.listdir(sr.dir) if os.path.isfile(sr.path(n)) and n != "agent.key")
ok("stdout: the code is in no argv and no file in the app folder, no socket files exist", CODE not in argv_text and CODE not in files_text and sr.reader_files() == [], (argv_text, sr.reader_files()))

# a reader that hangs: killed at the total deadline (shortened here)
sd = CodeRelay(total_s=1.5, stdout=True)
t0 = time.time()
sd.start("s-dl", "hang")
r = sd.code("s-dl", 8)
took = time.time() - t0
ok("stdout: reader runs longer than the total time -> reader_failed", err(r) == "reader_failed" and 1.2 < took < 5, (r, took))
ok("stdout: reader runs longer than the total time -> the child is killed", sd.beat_stops(4))
sd.stop()

# the extension goes away mid-read: the child is killed
sm = CodeRelay(stdout=True)
sm.start("s-m1", "hang")
sm.wait_file("fake-reader-connected", 5)
sm.proc.stdin.close()
ok("stdout: relay stdin closed mid-read -> the child is killed", sm.beat_stops(5))
sm.stop()
sr.stop()
out = b"".join(open(x.err.name, "rb").read() for x in (sr, sd, sm))
ok("stdout: relay stderr is empty and holds no code across all scenarios", out == b"" and CODE.encode() not in out, out)

# the relay without the test override
nr = CodeRelay(with_reader=False)
r = nr.read("n1")
if WINDOWS:
    ok("Windows: reader files missing -> reader_missing", err(r) == "reader_missing", r)
    skip("reader app missing on darwin -> reader_missing")
    skip("no PASSBRIDGE_CODE_READER on non-darwin -> mac_only")
elif DARWIN:
    ok("reader app missing on darwin -> reader_missing", err(r) == "reader_missing", r)
    skip("no PASSBRIDGE_CODE_READER on non-darwin -> mac_only")
    skip("Windows: reader files missing -> reader_missing")
else:
    ok("no PASSBRIDGE_CODE_READER on non-darwin -> mac_only", err(r) == "mac_only" and nr.reader_files() == [], r)
    skip("reader app missing on darwin -> reader_missing")
    skip("Windows: reader files missing -> reader_missing")
nr.stop()

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)
