# AGENTS.md

## What it is
PassBridge: a Chrome extension (macOS and Windows) that fills logins from the Apple iCloud Passwords vault, with Bitwarden-style autofill. It uses Apple's native-messaging protocol and pinned upstream field lists. It is loaded unpacked (not on the Chrome Web Store). See `README.md` and `SETUP.md`.

## Setup, build, test
- Needs Node.js 22.18 or newer. `npm install`, then `npm run build` (output in `dist/`; load that folder unpacked from `chrome://extensions`). Local builds add `version_name` (`<version>+<short sha>`, `-dirty` if uncommitted; omitted without git) shown in `chrome://extensions` and the Options sidebar; `PASSBRIDGE_RELEASE=1` (set in `release.yml`) skips it. Update code keeps reading `version`.
- `npm run typecheck`, `npm test` (`scripts/test.mjs`), `npm run test:unit`.
- Browser tests (CI): `npx playwright install --with-deps chromium`, `node test-harness/automation/build-test-extensions.mjs`, `node test-harness/automation/run-all.mjs`.
- macOS helper install: `sh native/install.sh` (Windows scripts are in `native/windows`).

## End-to-end suite
`node test-harness/automation/build-test-extensions.mjs`, then `xvfb-run -a node test-harness/automation/run-all.mjs` runs every browser driver, including `drive-e2e-*.mjs`: the real extension builds (`.builds/real-mac`, `.builds/real-win`) against a simulated Apple helper (`test-harness/fake-apple-helper`) and the agent relay. No Apple account, no person. Use `node`, never `npx`; on WSL run `env -u WAYLAND_DISPLAY xvfb-run -a ...`. `drive-e2e-auth.mjs` takes about two minutes (it waits out an unanswered approval). Details: `test-harness/automation/README.md`.

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
