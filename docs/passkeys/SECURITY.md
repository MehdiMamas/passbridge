# Passkeys: security

Sources are in [RESEARCH.md](RESEARCH.md).

## Passkey store on Windows (opt-in)

- **Keys sit in the user's iCloud Passwords vault**, in the same place as passwords, reached through Apple's helper. PassBridge adds no server, no sync and no file. A key is read only for the request being answered, and not kept after.
- **The import file is unprotected.** A Credential Exchange export holds the private keys in clear text. The options page tells the user to delete it right after import.
- **ES256 only.** Other key types are skipped with a reason.
- **Origin and site id** come from the browser's own request details, and the extension refuses a relying-party id that is not the page's site.
- **Attached only where needed.** Because attaching suspends native WebAuthn (below), the proxy is attached only on sites with a stored passkey, and the permission is optional and removed when the switch is turned off.
- **Per-login user verification.** The UV flag is set only when the vault read itself asked for verification (Windows Hello); otherwise it is off.
- **No counter.** Signature counters are 0, which sites accept for synced passkeys.
- **Limits.** If several passkeys match a request with an empty allow list, the first is used (no chooser yet). `excludeCredentials` is not checked on create.

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
