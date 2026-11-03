# Passkeys: security

Sources are in [RESEARCH.md](RESEARCH.md).

## Slice C

- Adds no permissions and no new code in web pages. It is a static help row and a link.
- Passkey private keys stay in iCloud Keychain on the user's Apple devices.

## No `navigator.credentials` override in the page

Other managers replace `navigator.credentials.create` and `get` in the page world. RESEARCH.md section 3 records a May 2026 review of one such wrapper: it ignored Permissions-Policy, its page message channel had no per-page authentication, and page JavaScript could overwrite it. The page then decides the origin and relying-party ID instead of the browser. PassBridge keeps its page-world code to hiding conditional prompts (`src/passkey-guard.js`) and would gain nothing from an override: it has no key to sign with.

## Option A threats (if ever built)

- **New private-key store.** PassBridge or its companion app would hold copies of passkey private keys. CXF carries the key as PKCS#8 (RESEARCH.md section 1). Every copy widens what can leak.
- **The proxy suspends all native WebAuthn.** While an extension is attached to `chrome.webAuthenticationProxy`, regular processing is suspended in that browser: security keys, Windows Hello and iCloud on Mac stop working (RESEARCH.md section 3).
- **Only one extension can attach.** A second one fails, so PassBridge could block, or be blocked by, another manager.
- **Origin handling moves to the extension.** Proof 2 showed the browser still rejects a wrong relying-party ID before the extension is called, but the extension builds `clientDataJSON` and must set the origin correctly itself.
