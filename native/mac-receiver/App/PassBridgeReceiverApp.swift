import AuthenticationServices
import os
import SwiftUI

private let logger = Logger(subsystem: "passbridge.receiver", category: "import")

/// Appends summary lines to receiver-log.txt in the app container.
private func appendToLogFile(_ lines: [String]) {
    guard let dir = try? FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    else { return }
    let url = dir.appendingPathComponent("receiver-log.txt")
    let text = lines.joined(separator: "\n") + "\n"
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(Data(text.utf8))
        try? handle.close()
    } else {
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }
}

@MainActor
final class ReceiverModel: ObservableObject {
    @Published var status = "Waiting for an export."

    func receive(_ activity: NSUserActivity) async {
        guard let token = activity.userInfo?[ASCredentialImportToken] as? UUID else {
            status = "Activity had no import token."
            return
        }
        do {
            let data = try await ASCredentialImportManager().importCredentials(token: token)
            let lines = CredentialSummary(data).lines
            for line in lines { logger.info("\(line, privacy: .public)") }
            appendToLogFile(lines)
            status = lines.joined(separator: "\n")
        } catch {
            logger.error("import failed: \(String(describing: type(of: error)), privacy: .public)")
            status = "Import failed: \(error.localizedDescription)"
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: ReceiverModel?

    func application(_ application: NSApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void) -> Bool {
        guard userActivity.activityType == ASCredentialExchangeActivity else { return false }
        Task { @MainActor in await model?.receive(userActivity) }
        return true
    }
}

@main
struct PassBridgeReceiverApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = ReceiverModel()

    var body: some Scene {
        WindowGroup {
            Text(model.status)
                .textSelection(.enabled)
                .padding()
                .frame(minWidth: 360, minHeight: 160)
                .onAppear { delegate.model = model }
                .onContinueUserActivity(ASCredentialExchangeActivity) { activity in
                    Task { await model.receive(activity) }
                }
        }
    }
}
