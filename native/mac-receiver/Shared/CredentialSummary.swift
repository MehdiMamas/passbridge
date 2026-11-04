import AuthenticationServices
import Foundation

/// Summary of an import. Holds only rpId, key type and counts: never key bytes,
/// credential ids, user handles, user names or passwords.
struct CredentialSummary: Equatable {
    struct Passkey: Equatable {
        let rpId: String
        let keyType: String
    }

    var passkeys: [Passkey] = []
    var passwords = 0
    var other = 0

    init(_ data: ASExportedCredentialData) {
        for account in data.accounts {
            for item in account.items {
                for credential in item.credentials {
                    switch credential {
                    case .passkey(let p):
                        passkeys.append(Passkey(rpId: p.relyingPartyIdentifier, keyType: Self.keyType(p.key)))
                    case .basicAuthentication:
                        passwords += 1
                    default:
                        other += 1
                    }
                }
            }
        }
    }

    /// PKCS#8 algorithm OIDs: id-ecPublicKey 1.2.840.10045.2.1 and prime256v1 1.2.840.10045.3.1.7.
    static func keyType(_ pkcs8: Data) -> String {
        let ecPublicKey: [UInt8] = [0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
        let prime256v1: [UInt8] = [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07]
        let bytes = [UInt8](pkcs8)
        let isP256 = contains(bytes, ecPublicKey) && contains(bytes, prime256v1)
        return "\(isP256 ? "EC P-256" : "other"), \(bytes.count) bytes"
    }

    private static func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard haystack.count >= needle.count else { return false }
        for i in 0...(haystack.count - needle.count) where Array(haystack[i..<(i + needle.count)]) == needle {
            return true
        }
        return false
    }

    var lines: [String] {
        var out = passkeys.map { "passkey rpId=\($0.rpId) key=\($0.keyType)" }
        out.append("passwords: \(passwords)")
        out.append("other items: \(other)")
        return out
    }
}
