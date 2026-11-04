import AuthenticationServices
import CryptoKit
import XCTest

final class CredentialSummaryTests: XCTestCase {
    func testPasskeySummaryReportsRpIdAndKeyTypeOnly() {
        let pkcs8 = P256.Signing.PrivateKey().derRepresentation
        let passkey = ASImportableCredential.Passkey(
            credentialID: Data([0xCA, 0xFE, 0xBA, 0xBE, 0x01]),
            relyingPartyIdentifier: "webauthn.io",
            userName: "throwaway-user",
            userDisplayName: "Throwaway",
            userHandle: Data([0xDE, 0xAD, 0xBE, 0xEF, 0x02]),
            key: pkcs8)
        let item = ASImportableItem(
            id: Data([1]), title: "webauthn.io", credentials: [.passkey(passkey)])
        let account = ASImportableAccount(
            id: Data([2]), userName: "u", email: "e@example.com", collections: [], items: [item])
        let data = ASExportedCredentialData(
            accounts: [account], formatVersion: .v1,
            exporterRelyingPartyIdentifier: "com.example", exporterDisplayName: "Test", timestamp: Date())

        let text = CredentialSummary(data).lines.joined(separator: "\n")

        XCTAssertTrue(text.contains("webauthn.io"))
        XCTAssertTrue(text.contains("EC P-256"))
        XCTAssertFalse(text.contains("throwaway-user"))
        XCTAssertFalse(text.contains(pkcs8.base64EncodedString()))
        XCTAssertFalse(text.lowercased().contains(pkcs8.map { String(format: "%02x", $0) }.joined()))
        XCTAssertFalse(text.contains("cafebabe"))
        XCTAssertFalse(text.contains("deadbeef"))
    }

    func testNonP256KeyIsOther() {
        XCTAssertTrue(CredentialSummary.keyType(Data(repeating: 1, count: 40)).hasPrefix("other"))
    }
}
