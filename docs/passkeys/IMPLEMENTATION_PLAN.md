# Passkeys: implementation plan

Status: slice C shipped. Phase 1 (Windows passkey store in iCloud Passwords, opt-in) is built. Phase 2 is later.

## Slice C (this change)

- `passkeysView(isWindows)` in `src/ui/options-model.js` picks the help text key and the SETUP.md link.
- A "Passkeys" row in the Browser tab of the options page, right after "Hide passkey suggestions", with a "How it works" button.
- Locale strings in `en`, `zh_CN` and `zh_TW`.
- README "What stays Apple's" line and a SETUP.md "Passkeys" section.
- Tests: unit test for `passkeysView`; the options browser check lists the row and its text.
- No change to `src/passkey-guard.js`, manifest permissions or WebAuthn behaviour.

## Phase 1: Windows passkey store (built)

PassBridge keeps passkeys as logins in the user's iCloud Passwords vault and answers WebAuthn through a scoped `chrome.webAuthenticationProxy`. Design in [ARCHITECTURE.md](ARCHITECTURE.md), tests in [TESTING.md](TESTING.md). Import is from an unencrypted Bitwarden JSON or Credential Exchange file.

## Phase 2 (later)

- A macOS app that receives passkeys from Apple Passwords through Credential Exchange, so no export file is needed.
- A Windows 11 plugin credential provider, so passkeys work in every app and browser, not only Chrome.
- A chooser when several passkeys match, and `excludeCredentials` on create.

## Option A as first written: possible future experiment

1. A macOS/iOS credential-provider app that receives passkeys from Apple Passwords through Credential Exchange (a user-started copy; see RESEARCH.md section 1).
2. End-to-end encrypted sync of that store to the Windows machine.
3. The extension attaches `chrome.webAuthenticationProxy` only while the user has opted in, and detaches otherwise (Proof 2 in [TESTING.md](TESTING.md)).

Open costs: a new private-key store to protect, a signed native app, sync and an audit, and the proxy suspends all native WebAuthn while attached ([SECURITY.md](SECURITY.md)). Mature managers already import from Apple Passwords this way ([COMPATIBILITY.md](COMPATIBILITY.md#other-password-managers)).

Phase 1 above covers the opt-in store without a companion app or sync.
