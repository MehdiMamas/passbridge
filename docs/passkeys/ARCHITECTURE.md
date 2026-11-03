# Passkeys: architecture

Facts and sources are in [RESEARCH.md](RESEARCH.md).

## What PassBridge does for passkeys

- Passwords come from Apple's native-messaging helper. That helper has no passkey command (Proof 1 in RESEARCH.md).
- `src/passkey-guard.js` (page world) only hides Chrome's conditional passkey prompts when the option "Hide passkey suggestions" is on. Modal sign-in and password requests pass through.
- `src/passkey-bridge.js` (extension world) tells the guard about that setting through a window event, because the page world cannot read `chrome.storage`.
- The options page (Browser tab) has a "Passkeys" row that explains the native path for this computer and links to the Passkeys section of SETUP.md.

## What PassBridge does not do

- It does not store, copy, sign or sync passkeys.
- It does not replace `navigator.credentials.create` or `get` (see [SECURITY.md](SECURITY.md)).
- It does not use `chrome.webAuthenticationProxy`.

## Options considered

| | Idea | Result |
|---|---|---|
| A | Move passkeys into a PassBridge-owned vault (Credential Exchange) and answer WebAuthn with `webAuthenticationProxy` | Possible, but a second private-key store, a native app and sync. Parked: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). |
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
