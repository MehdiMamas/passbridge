# Headless test suite

Automated tests that load the extension in real headless Chrome (Playwright) and
assert the dropdown/fill/PIN behavior across scenarios. They use mock builds of the
extension (the native-helper client is replaced with a mock) so no Apple helper or
real PIN is needed.

## Run

```bash
# 0. one-time, from the repo root: Playwright comes from the repo's node_modules
pnpm install && pnpm exec playwright install chromium

# 1. build the mock extensions into .builds/<kind>
node test-harness/automation/build-test-extensions.ts

# 2. run the whole suite; it serves test-harness/ itself on a free port
node test-harness/automation/run-all.ts
```

A single driver runs on its own too, but it needs the harness pages served:

```bash
# from test-harness/ (Windows: python, macOS/Linux: python3)
python -m http.server 8799 --bind 127.0.0.1
node automation/drive-pin.ts
```

`pnpm test` (from the repo root) runs the suites that need no browser: `unit`,
`pin-session`, `windows-host`, `fake-helper` (the simulated Apple helper against the real protocol), and `native-hosts.test.py` when Python 3 is on PATH.

Nothing needs a hosts-file entry: the cross-origin host `openpw.test` is mapped to
127.0.0.1 by a Chrome launch flag. Each browser gets a throwaway profile under the
system temp folder (`pb-*`), deleted when the driver ends, even on failure.

Env vars, all optional:
- `OP_PW`: path to Playwright's `index.js` (default: the repo's `node_modules/playwright`)
- `OP_BASE`: harness base URL (default `http://127.0.0.1:8799`; `run-all.ts` serves its own when unset)
- `OP_EXT`: extension folder to load instead of the driver's first mock build
- `OP_LOCKED`: locked build for `drive.ts` (default `.builds/locked`)
- `OP_MULTI`: multi-account build for `drive-login-list.ts` (default `.builds/multi`)
- `OP_PREVIEW`: an already-served `preview.html` for `drive-ui-preview.ts` (default: it builds and serves one)
- `PB_PYTHON`: the Python `pnpm test` uses for `native-hosts.test.py`

## What each file covers

| File | Build | Checks |
|---|---|---|
| `drive.ts` | unlocked, locked | Offer on login fields; nothing on OTP/newsletter; locked shows PIN field; click does not fall through the row; shortcut focuses the login field |
| `drive-adversarial.ts` | unlocked | No dropdown on search/tag(Instagram)/comment/checkout/profile; mixed page only on login |
| `drive-bench.ts` | unlocked | The combined testbench page, positives + negatives |
| `drive-anchor.ts` | unlocked | Fill targets the field you acted on, not another form |
| `drive-clickback.ts` | unlocked | Dropdown reappears after click-away-then-back |
| `drive-events.ts` | unlocked | `input`/`change` events fire on fill (login isn't rejected) |
| `drive-clickjack.ts` | unlocked | A hidden/offscreen password field is NOT filled |
| `drive-multi.ts` | multi | Chooser lists multiple saved logins |
| `drive-pin.ts` | pinflow | A wrong 5-digit code + Enter shows an error; the right 6 digits unlock and fill with no Enter |
| `drive-iframe.ts` | unlocked | A same-origin iframe login gets the dropdown inside the frame |
| `drive-xorigin.ts` | unlocked | A cross-origin iframe (`openpw.test`) gets NO offer; fails if the frame doesn't load |
| `drive-otp.ts` | otp | Verification-code row on OTP fields; split six-box and single-field fill; no code row on login fields |
| `drive-menu.ts` | unlocked | Menu host is up with a closed shadow root, field icon shows, rows still readable |
| `drive-login-list.ts` | many, multi | Long lists: username search, scroll cap, arrow keys, search follows the field |
| `drive-ui-preview.ts` | preview | The preview renders every popup screen in light and dark, plus the update page's states |
| `drive-update-fs.ts` | none | The folder update on Chrome's own File System Access code (OPFS): swap, rollback on a refused move, recovery, a `zip -r` zip |
| `pin-session.test.ts` | none | SRP against RFC 5054 vectors and fixed leading-zero vectors; challenge lifecycle (reuse, stale, expired codes) |
| `windows-host.test.ts` | none | iCloud for Windows quirks (string MSG/ErrCode/SMSG); wrong PIN, other ErrCode and forged HAMK are rejected |
| `unit.test.ts` | none | Adapter units: fill script, port names, lookup hosts, setup links; the update check and the folder update (zip reader, swap and rollback, recovery, folder access, release lookup) |
| `native-hosts.test.py` | none | Python hosts' `--selftest` modes; Windows policy host over native messaging, including `OPENPASSWORDS_NO_ELEVATE` |

| `drive-e2e-*.ts` | `real-mac`, `real-win` | The real extension (no mock client) against the simulated Apple helper in `test-harness/fake-apple-helper`, on both platforms: pairing, fill and save, codes, passkeys (win), denied or unanswered approval and relogin, and the agent relay. No Apple account and no person. |

`shoot-readme.ts` is not a test: it retakes the README screenshots in `docs/images` (popup from the preview build, inline menu and save bar from the real extension against the simulated helper). Run it under `xvfb-run -a`; `OUT=<folder>` writes elsewhere.

## End to end against the simulated helper

`build-test-extensions.ts` also builds `.builds/real-mac` and `.builds/real-win`: the production code with an empty mock
kind and the platform fixed at build time. `drive-e2e-*.ts` start a `FakeHelper` in the driver process and register two
native-messaging hosts in the throwaway profile (`com.apple.passwordmanager` is `fake-apple-helper/host.ts`, a relay to
the helper over a unix socket named by `PB_FAKE_HELPER_SOCK`; `com.passbridge.agent` is `native/passbridge-agent.py`,
with `PASSBRIDGE_APPDIR` pointing at a temp folder). The helper's vault, the code on its screen and the Touch ID answer
(`helper.auth = "approve" | "deny" | "timeout"`) are plain properties a driver sets. Run one driver with the harness
served as above and `xvfb-run -a node automation/drive-e2e-pair.ts`; `drive-e2e-auth.ts` takes about two minutes
because it waits out an unanswered approval.

Helpers: `lib.ts` (Playwright, extension launch, results, the CDP view of the
closed-shadow menu), `srp-reference.ts` (independent SRP used by the mock helpers),
`build-test-extensions.ts` (mock builds), `run-all.ts` (runs every `.ts` above).

Outputs screenshots to `shots/` (gitignored).

## Folder update end to end (by hand)

Playwright cannot drive the folder picker or Chrome's permission prompts, so `run-all.ts` leaves this one out.
`node test-harness/automation/update-e2e.ts` walks a person through the update page in a real Chrome: it builds
an installed version and five updates with a throwaway signing key (`releaseSource` and `version` in
`buildExtension`, refused outside test builds), serves them as a fake GitHub release on 127.0.0.1, opens Chrome on
a fresh profile, says what to click, and after every round compares the extension folder with the build it
should hold. Rounds: the first update; permission again with a dropped file, a dropped folder and an added file; a
broken signature; an unsigned release; one click after a browser restart; a restart that did not land. Needs `zip`;
off macOS set `CHROME` to the Chrome binary.
