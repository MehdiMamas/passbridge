# Passkeys: implementation plan

Status: slice C shipped in this change. Option A is awaiting a decision.

## Slice C (this change)

- `passkeysView(isWindows)` in `src/ui/options-model.js` picks the help text key and the SETUP.md link.
- A "Passkeys" row in the Browser tab of the options page, right after "Hide passkey suggestions", with a "How it works" button.
- Locale strings in `en`, `zh_CN` and `zh_TW`.
- README "What stays Apple's" line and a SETUP.md "Passkeys" section.
- Tests: unit test for `passkeysView`; the options browser check lists the row and its text.
- No change to `src/passkey-guard.js`, manifest permissions or WebAuthn behaviour.

## Option A: possible future experiment

Opt-in only. Not started.

1. A macOS/iOS credential-provider app that receives passkeys from Apple Passwords through Credential Exchange (a user-started copy; see RESEARCH.md section 1).
2. End-to-end encrypted sync of that store to the Windows machine.
3. The extension attaches `chrome.webAuthenticationProxy` only while the user has opted in, and detaches otherwise (Proof 2 in [TESTING.md](TESTING.md)).

Open costs: a new private-key store to protect, a signed native app, sync and an audit, and the proxy suspends all native WebAuthn while attached ([SECURITY.md](SECURITY.md)). Mature managers already import from Apple Passwords this way ([COMPATIBILITY.md](COMPATIBILITY.md#other-password-managers)).

Decision needed: build the experiment, or stay with slice C.
