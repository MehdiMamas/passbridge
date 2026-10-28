# AGENTS.md

## What it is
PassBridge: a Chrome extension (macOS and Windows) that fills logins from the Apple iCloud Passwords vault, with Bitwarden-style autofill. It uses Apple's native-messaging protocol and pinned upstream field lists. It is loaded unpacked (not on the Chrome Web Store). See `README.md` and `SETUP.md`.

## Setup, build, test
- Needs Node.js 20 or newer. `npm install`, then `npm run build` (output in `dist/`; load that folder unpacked from `chrome://extensions`).
- `npm run typecheck`, `npm test` (`scripts/test.mjs`), `npm run test:unit`.
- Browser tests (CI): `npx playwright install --with-deps chromium`, `node test-harness/automation/build-test-extensions.mjs`, `node test-harness/automation/run-all.mjs`.
- macOS helper install: `sh native/install.sh` (Windows scripts are in `native/windows`).

## Where things live
- `src/`: extension code (`background.js`, `content.js`, `menu.js`, `autofill/`, `apple/`, `ui/`, `update/`, popup/options pages).
- `overlay/`: save and TOTP bar pages. `native/`: Python helper agent and install scripts. `manifest.json`: extension manifest (its key fixes the extension id).
- `vendor/`, `upstreams.json`, `UPSTREAMS.md`, `scripts/sync-upstream.mjs`: pinned upstream code and how to update it (`npm run sync -- <name> [commit]`, add `--accept` only after tests agree). `patches/site-fixes.md`: site-specific fixes.
- `test-harness/`: test pages and automated Playwright tests. `docs/`: agent protocol, releasing, Windows findings. `VERIFICATION.md`, `COMPLAINTS.md`: audit logs.

## CI and release
`.github/workflows`: `ci.yml` (typecheck, build, test), `browser-tests.yml`, `upstream-check.yml`, `release.yml` (typecheck, test, build, zip `dist`). Release steps are in `docs/releasing.md`.

## Gotchas
- Disable Apple's own iCloud Passwords extension first: both use the same extension id.
- `dist/`, `node_modules/`, `*.zip`, `*.pem` and `test-harness/automation/.builds/` are gitignored.
