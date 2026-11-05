# Passkeys: testing

## Proof 1: Apple's helper has no passkey operations

Static inspection of Apple's iCloud Passwords extension 3.4.0. See [RESEARCH.md](RESEARCH.md#proof-1-apples-helper-protocol-has-no-passkey-operations).

## Proof 2: webAuthenticationProxy

Question: can an extension answer WebAuthn requests through `chrome.webAuthenticationProxy`, with the browser still checking the origin?

Source: https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy

From the documentation: the API lets remote-desktop software intercept WebAuthn requests; it is available from Chrome 115 and, for MV3 extensions, since Chrome 148; `attach()` fails if a different extension is attached, and regular WebAuthn processing is suspended while attached; request options arrive as a JSON string and the answer is the `PublicKeyCredential.toJSON()` result; a request cannot be completed once canceled.

The documentation says nothing about `clientDataJSON` or the origin. Observed:

- The origin is passed in the request: `extensions.remoteDesktopClientOverride = {"origin": ..., "sameOriginWithAncestors": true}`, for both create and get.
- The extension builds `clientDataJSON` (type, challenge, origin, crossOrigin) and returns it in the response; Chrome passes it through unchanged. The page-side check `origin == location.origin` passed.
- Get options carry `rpId`, `allowCredentials` (with transports), `challenge` and `userVerification`; create options carry `rp`, `user`, `pubKeyCredParams`, `excludeCredentials` and `attestation`.
- `attach()` succeeded with no remote session and no special flag. It works headless, unpacked and as MV3.
- The browser rejects a relying-party ID that does not match the page origin before the extension is called (SecurityError "The relying party ID is not a registrable domain suffix of, nor equal to the current domain"). The extension's own check is defence in depth.

Result: PASS on Chrome for Testing 156.0.8078.4 and 149.0.7827.55 (MV3 needs 148 or newer). One create, then two gets, each verified in the page: ES256 DER signature checked with WebCrypto, signature counter rising (2, then 3). The wrong-RP-ID negative test returned SecurityError.

Meaning: option A is technically possible, but the proxy suspends all native WebAuthn while attached ([SECURITY.md](SECURITY.md)). Nothing from this proof is in PassBridge.

## How slice C is tested

- Unit (`pnpm test:unit`): `passkeysView(true)` returns `passkeysHelpWin`, `passkeysView(false)` returns `passkeysHelpMac`, and the link ends with `SETUP.md#passkeys`.
- Browser (`test-harness/automation/drive-options.ts`, part of `node test-harness/automation/run-all.ts`): the Browser tab lists the "Passkeys" row after "Hide passkey suggestions", shows the non-Windows text in the Linux test browser, and has a "How it works" button.
- Locale check (`pnpm test`) requires the new keys in all three locale files.

## Proof 4: Bitwarden JSON export carries passkey keys

Question: does an unencrypted Bitwarden JSON export hold the passkey private keys, and in what format, so PassBridge can import them from a file?

Sources (fetched 2026-11-03):
- Bitwarden export model: https://github.com/bitwarden/clients/blob/e6789df4f6246888e99f20c601db6485ad792e5a/libs/common/src/models/export/fido2-credential.export.ts
- It is attached to each login: https://github.com/bitwarden/clients/blob/main/libs/common/src/models/export/login.export.ts (`fido2Credentials`)
- How the key is written: https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts (`pkcs8` export, `Fido2Utils.arrayToString`)
- Credential ID forms: https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/credential-id-utils.ts (`parseCredentialId`)
- Sample export: https://github.com/bitwarden/clients/blob/main/libs/importer/src/importers/spec-data/bitwarden-json/account-encrypted-v2.json.ts
- Help page: https://bitwarden.com/help/export-your-data/ ("Only .json exports include ... Stored passkeys"; passkeys created before 2024.3.1 carry a counter that rises with each use)
- CXF 1.0 Passkey item: https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html#name-passkey-dictionary

Result: PASS. The export holds the private key, so the file must be treated as secret.

Bitwarden JSON: `items[].login.fido2Credentials[]`, each with these string fields:

| Field | Value |
|---|---|
| `credentialId` | A GUID (`e8d88789-e916-e196-3cbd-81dafae71bbc`, 16 raw bytes in GUID order) or `b64.` followed by base64url of the raw ID |
| `keyType` | `public-key` |
| `keyAlgorithm` | `ECDSA` |
| `keyCurve` | `P-256` |
| `keyValue` | PKCS#8 DER of the private key, base64url without padding |
| `rpId` | Relying party ID |
| `userHandle` | base64url of the user handle (may be absent) |
| `userName`, `userDisplayName`, `rpName` | Text (may be absent) |
| `counter` | Decimal string |
| `discoverable` | `"true"` or `"false"` |
| `creationDate` | ISO 8601 |

CXF 1.0: a `credentials[]` entry with `type: "passkey"` and `credentialId`, `rpId`, `username`, `userDisplayName`, `userHandle`, `key` (all base64url strings except the text ones). `key` MUST be PKCS#8 DER, base64url. Under the spec, a passkey with a non-zero counter is left out of the export and importers set the counter to zero. The envelope is `accounts[].items[].credentials[]`.

PassBridge only supports P-256 (ES256) keys; other algorithms are skipped with a reason.

## Browser test: passkey store end to end

`test-harness/automation/drive-passkeys.ts` (part of `run-all.ts`; the test build holds the `webAuthenticationProxy` permission up front). It stores a synthetic passkey for `localhost`, then checks in a real Chromium that a page can create a passkey, get twice with signatures verified in the page against the public key from create, is refused for another site's relying-party id, and that a site with no stored passkey is not answered by PassBridge. It prints a SKIP line only when the browser has no `chrome.webAuthenticationProxy`.
