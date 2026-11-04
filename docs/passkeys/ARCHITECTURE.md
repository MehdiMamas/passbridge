# Passkeys: architecture

Facts and sources are in [RESEARCH.md](RESEARCH.md).

## What PassBridge does for passkeys

- Passwords come from Apple's native-messaging helper. That helper has no passkey command (Proof 1 in RESEARCH.md).
- `src/passkey-guard.js` (page world) only hides Chrome's conditional passkey prompts when the option "Hide passkey suggestions" is on. Modal sign-in and password requests pass through.
- `src/passkey-bridge.js` (extension world) tells the guard about that setting through a window event, because the page world cannot read `chrome.storage`.
- The options page (Browser tab) has a "Passkeys" row that explains the native path for this computer and links to the Passkeys section of SETUP.md.

## What PassBridge does not do

- On macOS it does not store, copy, sign or sync passkeys; Chrome and iCloud Keychain do that natively.
- It never replaces `navigator.credentials.create` or `get` in the page (see [SECURITY.md](SECURITY.md)).
- On Windows it uses `chrome.webAuthenticationProxy` only when the user turns the passkey store on, and only while the active tab's site has a stored passkey.

## Options considered

| | Idea | Result |
|---|---|---|
| A | Move passkeys into a PassBridge-owned vault (Credential Exchange) and answer WebAuthn with `webAuthenticationProxy` | Built as Plan B for Windows (below): the vault is the user's own iCloud Passwords, so there is no new store and no sync. The macOS Credential Exchange app is later: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). |
| B | Ask Apple's helper to sign remotely | Not possible: no passkey operation exists (Proof 1). |
| C | Use the native paths and explain them | Chosen. Keys never leave Apple, nothing in Chrome changes. |

C is chosen because it is small, adds no permissions and cannot break other sign-in methods.

## Flow, macOS (native)

```
site -> Chrome (118+, macOS 13.5+) -> iCloud Keychain (system prompt) -> signed answer -> site
PassBridge: not involved (guard only hides conditional prompts if the user turned that on)
```

## Flow, Windows (hybrid)

```
site -> Chrome passkey dialog -> "Use a phone or tablet" -> QR code
iPhone scans QR -> Bluetooth proximity + internet -> iPhone signs with its iCloud Keychain passkey -> site
PassBridge: not involved; every sign-in needs a new scan (no persistent linking on iOS)
```

## Passkey store on Windows (opt-in)

Code: `src/passkeys/` (`record.js`, `webauthn.js`, `import.js`, `store.js`, `proxy.js`), wired in `src/background.js`.

- **Storage.** Each passkey is one Apple Passwords login under the dedicated address `https://passkeys.passbridge.invalid/`. The username is `<site> · <user> · <first 8 characters of the credential id>`. The password is the base64url of a small JSON record (version, site, credential id, user handle, user name, PKCS#8 P-256 key). Passkey logins are hidden from the fill lists and the login popup.
- **Import.** The options page reads an unencrypted Credential Exchange file ([Proof 4](TESTING.md)), keeps ES256 (P-256) keys only, and sends one `passkeySave` message per passkey. Each save is confirmed by reading it back.
- **Scoped attach.** `proxy.js` attaches to `chrome.webAuthenticationProxy` only while the active tab's site has a stored passkey, and detaches on every other site, so Windows Hello and security keys keep working elsewhere. The attach state is worked out again on every service worker wake (listeners are registered at the top level).
- **Signing.** For a create or get request the extension takes the origin from `extensions.remoteDesktopClientOverride.origin`, checks the relying-party id against it, builds `clientDataJSON`, and signs with ES256 through WebCrypto. The authenticator data carries user presence, backup eligible and backup state; user verification only when the vault read asked for it; the counter is 0.
- **Settings.** The `passkeyStore` switch lives in `chrome.storage.local` (per PC). Turning it on asks for the optional permission `webAuthenticationProxy`; turning it off detaches and removes the permission.

```
site -> Chrome -> (attached, site has a stored passkey) -> PassBridge -> read record from iCloud Passwords -> sign -> site
site -> Chrome -> (no stored passkey for the site)      -> Chrome's own dialog, phone QR, Windows Hello
```
