# Headless test suite

Automated tests that load the extension in real headless Chrome (Playwright) and
assert the dropdown/fill/PIN behavior across scenarios. They use mock builds of the
extension (the native-helper client is replaced with a mock) so no Apple helper or
real PIN is needed.

## Run

```bash
# 0. one-time, from the repo root: Playwright comes from the repo's node_modules
npm install && npx playwright install chromium

# 1. build the mock extensions into .builds/<kind>
node test-harness/automation/build-test-extensions.mjs

# 2. run the whole suite; it serves test-harness/ itself on a free port
node test-harness/automation/run-all.mjs
```

A single driver runs on its own too, but it needs the harness pages served:

```bash
# from test-harness/ (Windows: python, macOS/Linux: python3)
python -m http.server 8799 --bind 127.0.0.1
node automation/drive-pin.mjs
```

`npm test` (from the repo root) runs the suites that need no browser: `unit`,
`pin-session`, `windows-host`, and `native-hosts.test.py` when Python 3 is on PATH.

Nothing needs a hosts-file entry: the cross-origin host `openpw.test` is mapped to
127.0.0.1 by a Chrome launch flag. Each browser gets a throwaway profile under the
system temp folder (`pb-*`), deleted when the driver ends, even on failure.

Env vars, all optional:
- `OP_PW`: path to Playwright's `index.js` (default: the repo's `node_modules/playwright`)
- `OP_BASE`: harness base URL (default `http://127.0.0.1:8799`; `run-all.mjs` serves its own when unset)
- `OP_EXT`: extension folder to load instead of the driver's first mock build
- `OP_LOCKED`: locked build for `drive.mjs` (default `.builds/locked`)
- `OP_MULTI`: multi-account build for `drive-login-list.mjs` (default `.builds/multi`)
- `OP_PREVIEW`: an already-served `preview.html` for `drive-ui-preview.mjs` (default: it builds and serves one)
- `PB_PYTHON`: the Python `npm test` uses for `native-hosts.test.py`

## What each file covers

| File | Build | Checks |
|---|---|---|
| `drive.mjs` | unlocked, locked | Offer on login fields; nothing on OTP/newsletter; locked shows PIN field; click does not fall through the row; shortcut focuses the login field |
| `drive-adversarial.mjs` | unlocked | No dropdown on search/tag(Instagram)/comment/checkout/profile; mixed page only on login |
| `drive-bench.mjs` | unlocked | The combined testbench page, positives + negatives |
| `drive-anchor.mjs` | unlocked | Fill targets the field you acted on, not another form |
| `drive-clickback.mjs` | unlocked | Dropdown reappears after click-away-then-back |
| `drive-events.mjs` | unlocked | `input`/`change` events fire on fill (login isn't rejected) |
| `drive-clickjack.mjs` | unlocked | A hidden/offscreen password field is NOT filled |
| `drive-multi.mjs` | multi | Chooser lists multiple saved logins |
| `drive-pin.mjs` | pinflow | A wrong 5-digit code + Enter shows an error; the right 6 digits unlock and fill with no Enter |
| `drive-iframe.mjs` | unlocked | A same-origin iframe login gets the dropdown inside the frame |
| `drive-xorigin.mjs` | unlocked | A cross-origin iframe (`openpw.test`) gets NO offer; fails if the frame doesn't load |
| `drive-otp.mjs` | otp | Verification-code row on OTP fields; split six-box and single-field fill; no code row on login fields |
| `drive-menu.mjs` | unlocked | Menu host is up with a closed shadow root, field icon shows, rows still readable |
| `drive-login-list.mjs` | many, multi | Long lists: username search, scroll cap, arrow keys, search follows the field |
| `drive-ui-preview.mjs` | preview | The popup preview renders 8 screens (4 states x light/dark) |
| `pin-session.test.mjs` | none | SRP against RFC 5054 vectors and fixed leading-zero vectors; challenge lifecycle (reuse, stale, expired codes) |
| `windows-host.test.mjs` | none | iCloud for Windows quirks (string MSG/ErrCode/SMSG); wrong PIN, other ErrCode and forged HAMK are rejected |
| `unit.test.mjs` | none | Adapter units: fill script, port names, lookup hosts, setup links |
| `native-hosts.test.py` | none | Python hosts' `--selftest` modes; Windows policy host over native messaging, including `OPENPASSWORDS_NO_ELEVATE` |

Helpers: `lib.mjs` (Playwright, extension launch, results, the CDP view of the
closed-shadow menu), `srp-reference.mjs` (independent SRP used by the mock helpers),
`build-test-extensions.mjs` (mock builds), `run-all.mjs` (runs every `.mjs` above).

Outputs screenshots to `shots/` (gitignored).
