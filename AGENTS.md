# AGENTS.md

## What it is
PassBridge: a Chrome extension (macOS and Windows) that fills logins from the Apple iCloud Passwords vault, with Bitwarden-style autofill. It uses Apple's native-messaging protocol and pinned upstream field lists. It is loaded unpacked (not on the Chrome Web Store). See `README.md` and `SETUP.md`.

## Setup, build, test
- Needs Node.js 22.18 or newer and pnpm 10 (`corepack enable`); the project uses pnpm, not npm. `pnpm install`, then `pnpm build` (output in `dist/`; load that folder unpacked from `chrome://extensions`). Local builds add `version_name` (`<version>+<short sha>`, `-dirty` if uncommitted; omitted without git) shown in `chrome://extensions` and the Options sidebar; `PASSBRIDGE_RELEASE=1` (set in `release.yml`) skips it. Update code keeps reading `version`.
- `pnpm typecheck` (also covers `scripts/` and `test-harness/` through `tsconfig.tools.json`), `pnpm test` (`scripts/test.ts`), `pnpm test:unit`.
- Browser tests (CI): `pnpm exec playwright install --with-deps chromium`, `node test-harness/automation/build-test-extensions.ts`, `node test-harness/automation/run-all.ts`.
- macOS helper install: `sh native/install.sh` (Windows scripts are in `native/windows`).

## End-to-end suite
`node test-harness/automation/build-test-extensions.ts`, then `xvfb-run -a node test-harness/automation/run-all.ts` runs every browser driver, including `drive-e2e-*.ts`: the real extension builds (`.builds/real-mac`, `.builds/real-win`) against a simulated Apple helper (`test-harness/fake-apple-helper`) and the agent relay. No Apple account, no person. Use `node`, never `npx`; on WSL run `env -u WAYLAND_DISPLAY xvfb-run -a ...`. `drive-e2e-auth.ts` takes about two minutes (it waits out an unanswered approval). Details: `test-harness/automation/README.md`.

## Where things live
- `src/`: extension code (`background.js`, `content.js`, `menu.js`, `autofill/`, `apple/`, `ui/`, `update/`, popup/options pages).
- `overlay/`: save and TOTP bar pages. `native/`: Python helper agent and install scripts. `manifest.json`: extension manifest (its key fixes the extension id). `native/code-reader/`: the Swift Accessibility app (PassBridge Code Reader) that presses Allow on Apple's prompt and reads the code; `sh native/code-reader/build.sh <dir>` builds it, `--self-test test-harness/code-reader-fixtures` checks it. On Windows, `native/windows/code-reader.ps1` (UI Automation, no Accessibility grant) with `code-reader.json` does the same; `powershell -File native/windows/code-reader.ps1 -SelfTest test-harness/code-reader-fixtures-win` checks it. The same reader also serves the owner's own Apple sign-ins (`handleUserCode` in `src/agent.js`); SMS and email codes are Keytray's.
- `vendor/`, `upstreams.json`, `UPSTREAMS.md`, `scripts/sync-upstream.ts`: pinned upstream code and how to update it (`pnpm sync <name> [commit]`, add `--accept` only after tests agree). `patches/site-fixes.md`: site-specific fixes.
- `test-harness/`: test pages and automated Playwright tests. `docs/`: agent protocol, releasing, Windows findings. `VERIFICATION.md`, `COMPLAINTS.md`: audit logs.

## CI and release
`.github/workflows`: `ci.yml` (typecheck, build, test), `browser-tests.yml`, `upstream-check.yml`, `release.yml` (typecheck, test, build, zip `dist`). Release steps are in `docs/releasing.md`.

## Gotchas
- Disable Apple's own iCloud Passwords extension first: both use the same extension id.
- The vault is reachable only from macOS or Windows. From WSL, `native/passbridge-agent-cli.py` re-runs itself through the Windows Python (`PASSBRIDGE_NO_WSL_REEXEC=1` turns it off; tests set it). See `docs/agent-protocol.md`.
- `dist/`, `node_modules/`, `*.zip`, `*.pem` and `test-harness/automation/.builds/` are gitignored.
