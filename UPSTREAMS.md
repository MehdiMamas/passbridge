# Keeping PassBridge current

PassBridge is three layers. Each upstream is pinned. `npm run sync -- <name> [commit]` downloads that pin and prints which tracked files changed. Add `--accept` only after the running code and the harness agree with the diff.

| Name | Repo | What it updates | Running code |
|---|---|---|---|
| `bitwarden` | `bitwarden/clients` | Field-name lists and the autofill reference snapshot | `src/content.js` imports `AutoFillConstants` from the pinned snapshot. The menu, fill pacing, and site fixes stay in `src/content.js` (`patches/site-fixes.md`). |
| `au2001` | `au2001/icloud-passwords-firefox` | Apple helper protocol (SRP, crypto, API) | `src/apple/` |
| `open-passwords` | `ManiForoughi2/open-passwords` | The original Chrome protocol client | `src/apple/protocol.js` |

Pins live in `vendor/<name>/PINNED`. The mirrors under `vendor/` are the diff baseline, not a second runtime. Nothing from `bitwarden_license/` is included. The Bitwarden name and logo are not used.

## Weekly check

`.github/workflows/upstream-check.yml` runs every Monday (and on demand). `npm run upstream:check` does the same locally and prints a JSON summary per upstream: pinned and latest commit, changed files, files removed upstream, and a compare link. In CI (`--issues`) it opens or updates one issue labelled `upstream` per upstream whose tracked files changed. It never changes a pin; accepting stays manual.

## Autofill spike

Compiling Bitwarden's browser autofill content scripts was rejected. At `fc5de86` the content entry imports `AutofillService`, overlay abstractions, and `@bitwarden/common` vault types. Shipping that stack would pull their account and cipher services into every page, which fails the size and "pure utilities only" gate.

What is compiled instead: `vendor/bitwarden/services/autofill-constants.ts`, bundled into the content script through `src/shims/` (the three `@bitwarden/common` modules those constants import). `hasStrongIdentitySignal` treats a field `name` or `id` that matches their username or email list as a login identity. The rest of detection, including every row in `patches/site-fixes.md`, stays ours. A Bitwarden sync that changes those lists is a typecheck plus the harness, not a rewrite of the menu.

The content bundle after this change is 70,020 bytes (17,496 gzip), against a baseline of 61,195 bytes (17,506 gzip).

## When something breaks

- Bitwarden changes detection: `npm run sync -- bitwarden <commit>`. Read the diff. If `autofill-constants.ts` changed, rebuild and run the harness, then `--accept`.
- A new macOS or iCloud for Windows breaks pairing or login lookup, and au2001 or open-passwords has the fix: `npm run sync -- au2001 <commit>` (or `open-passwords`). Update `src/apple/` only where the command shape changed. `src/apple/protocol.js` is the client the background talks to.
- The popup needs a new capability: add the message to `src/background.js` first. The React UI in `src/ui/` only renders what the background answers.

## Parity

HAVE = already worked before this fork. ADD = built here. PARTIAL = built, with the Apple limit named. CANNOT = the helper or the OS blocks it.

| Area | Status | Notes |
|---|---|---|
| Inline menu on login fields, keyboard, OTP skipped | HAVE | |
| Closed shadow host, top-layer popover, in-field icon | ADD | |
| Fill sequence and site-specific rules | ADD | Site fixes stay on top of the Bitwarden name lists |
| Save / update prompt | ADD | React page in an isolated frame. Apple's sheet still confirms the write |
| Popup and settings | ADD | React and Tailwind. Not Bitwarden's Angular UI |
| Cards, identities, notes, folders | CANNOT | Not in Apple's protocol |
| Passkeys through this extension | CANNOT | Chrome on macOS already offers iCloud passkeys |
| Linux, Chrome Web Store | CANNOT | No helper on Linux. The extension id belongs to Apple |
