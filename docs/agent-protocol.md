# Agent sign-in protocol

A program on the same computer, such as Claude Code, can ask PassBridge to fill a saved login into a browser tab. This page is for whoever writes such a client. The reference client is `native/passbridge-agent-cli.py`.

No reply ever contains a password or a code. The extension drops any key named `password`, `pass`, `code`, `otp`, `secret` or `token` from every reply, at any depth.

## Platforms

macOS and Windows. The request and reply format is the same on both; only how a client connects differs (see Socket and named pipe).

WSL: the vault is only reachable from the Windows side, so a client in WSL on the same PC runs the reference CLI, which detects WSL (`/proc/sys/kernel/osrelease` contains `microsoft`) and re-runs itself through the Windows Python (`py.exe -3`, else `python.exe`) with WSL interop. The named pipe and `agent.key` stay Windows-only, and stdin and the exit code pass through. A client of your own in WSL does the same, or talks to the pipe from a Windows process. Set `PASSBRIDGE_NO_WSL_REEXEC=1` to turn the re-run off. A Linux machine with no Windows or macOS browser has no vault to reach.

## Turning it on

1. Run the helper's installer: `install.sh` on macOS (1.4.0 or later), `install.ps1` on Windows (needs Python). It registers the native host `com.passbridge.agent`.
2. Quit and reopen the browser.
3. In PassBridge Settings, on the Agents tab, turn on Allow agent sign-in. It is off by default.
4. Optional: to let a program add new logins, turn on Allow agents to save new logins on the same tab (needs Allow agent sign-in; off by default). It can only add, never read or overwrite a login.
5. Optional: after that, the save bar shows "Allow agents to sign in on <site>" when you save a login for a site that is not on the allowlist. It starts checked only for a password PassBridge generated; ticking it and saving adds the site (the registrable domain, or the full host on shared hosts such as Workday tenants) to the allowlist.

While it is off, the extension doesn't start the host, so the socket or pipe below doesn't exist.

## Socket (macOS)

- Path: `~/Library/Application Support/PassBridge/agent.sock`. If `PASSBRIDGE_APPDIR` is set in the host's environment, the socket is `$PASSBRIDGE_APPDIR/agent.sock` instead.
- Type: a Unix domain stream socket. The folder is mode 0700 and the socket is 0600, so only the same macOS user can connect.
- The browser starts the host. It exists only while the browser is running and agent sign-in is on, and it is removed when the browser quits. If the connection fails, report `no_host`: the browser is closed, the setting is off, or the helper isn't installed.

## Named pipe (Windows)

- Pipe: `\\.\pipe\passbridge-agent-<username>`, opened with Python's `multiprocessing.connection` (`Client(pipe, family="AF_PIPE", authkey=key)`).
- Key: 32 random bytes, made by the host on first start in `%LOCALAPPDATA%\PassBridge\agent.key` (or `%PASSBRIDGE_APPDIR%\agent.key`). A pipe's default access list is wider than a 0600 socket, so a client without the key is refused in the connection handshake. Read the key file from the same Windows user only.
- Send and read with `send_bytes` and `recv_bytes` only, never `send()` or `recv()`, which use pickle. Each message is one JSON object, with no trailing newline: one request, one reply.
- The app folder is `%LOCALAPPDATA%\PassBridge`. The reference client is `py "%LOCALAPPDATA%\PassBridge\passbridge-agent-cli.py"`. If the connection fails, report `no_host`.

## One relay per user

Every browser profile with agent sign-in on starts its own host, but only one relay per OS user owns the socket or pipe: the first one takes a lock on `agent.lock` in the app folder, and the others wait and take over when the owner closes. A waiting relay tells its extension `{"event":"standby"}` (and `{"event":"active"}` once it owns the endpoint); the Agents tab then says another browser or profile is answering. Requests go to the owning browser's extension, so use its tab ids.

## Framing

The macOS socket uses newline-delimited JSON; the Windows pipe uses one message per request (see above). Send one JSON object per line and read one JSON line back per request. A connection can carry several requests in a row. Inside, the host talks to the extension over Chrome's native messaging, which is 4-byte length-prefixed. Clients never see that layer.

## Pairing

There is no per-client pairing of the socket. On macOS any process of the same user that can open the socket may send requests; on Windows any process of the same user that can read `agent.key`. What protects you:
- the setting is off by default;
- only allowlisted sites can be filled, unless the user also turns on Allow every site (*) (see below);
- `sign_in`, `save`, `pair_start` and `pair_pin` are rate limited;
- each password read still needs your approval in Apple's Passwords (Touch ID);
- every request except `status` is logged in the extension; `pair_pin` is logged without the digits. The log (Agents > Activity) is kept in session storage only, so it clears when the browser closes.

"Paired" means the extension itself is paired with Apple's Passwords. That is the 6-digit code shown on the Mac, entered in the PassBridge popup, or sent through the agent with `pair_start` and `pair_pin` (below). If it isn't paired, `status` shows `"paired": false` and the other requests fail with `needs_user`. After the extension reloads, it reports `paired: false` until you open the popup once.

## Requests

Every request has an `id` (any non-empty string, echoed back) and an `op`.

| op | fields | what it does |
|---|---|---|
| `status` | none | reports the state, touches no tab |
| `logins` | `tabId` (number), `site` (optional string) | lists the saved usernames for that tab's site |
| `sign_in` | `tabId` (number), `username` (optional string), `site` (optional string) | fills that login into the tab's sign-in form |
| `pair_start` | none | asks Apple's Passwords to show a pairing code. Replies `{"ok":true,"state":"paired"}` when already paired, else `{"ok":true,"state":"needs_pin"}` (a new code, or the one already on screen) |
| `pair_pin` | `pin` (string, exactly 6 digits) | checks the code shown on the Mac. Replies `{"ok":true,"state":"paired"}`, or `wrong_pin` |
| `verify_code` | `tabId` (number), `site` (optional string), `username` (optional string) | macOS and Windows. Enters a verification code in that tab: on an Apple sign-in page it presses Allow on Apple's prompt and reads the 6 digits; on any other site it uses the one-time code Apple Passwords offers for the site (`username` picks one). The reply holds no digits (see Verification codes below) |
| `unlock` | none | Windows only. Pairs a locked store (`paired:false`) with no person: asks Apple's Passwords for a code, reads it on this computer and enters it. Replies `{"ok":true,"state":"paired"}` (also when already paired, with nothing read). See Unlock below |
| `save` | `tabId` (number) or `url` (string, `https://`), not both; `username` (string), `password` (string), `site` (optional string) | adds a new login for the tab's site, or for the site of `url` when no tab is named. Add-only: if that username already has a login for the site, the reply is `exists` and nothing changes |

`pair_start` and `pair_pin` need Allow agent sign-in but no tab and no allowlist, and both count toward the rate limit. After 5 wrong codes in a row, `pair_pin` answers `locked` until a `pair_start` issues a fresh code. The pin is never in a reply or the Activity list.

On Windows, iCloud for Windows shows the code in a window that is excluded from screen capture, so remote desktop shows a black box there. `native/windows/read-pair-code.ps1` reads the code from that window's accessibility text and prints just the 6 digits (exit 1 when no code window is open), for sending to the device you pair from. It writes nothing to disk; never run it where its output is logged.

`save` needs Allow agents to save new logins, not the allowlist. The tab, or the `url`, must be `https:` and not a local host. Send exactly one of `tabId` and `url`; both or neither is `bad_request`, and so is a `url` that does not parse; a `url` that is not `https:` is `not_allowed`. Only `save` takes `url`: `logins` and `sign_in` with a `url` are `bad_request`. The Activity list keeps the origin of a `url`, never its path or query. The password is sent in the request, is never in a reply, and is never written to the Activity list (it keeps the op, tab, site and username). Apple's Passwords may show its own prompt for the new login; if nobody answers it in time, the reply is `needs_user`. The extension shows a notification for each saved login. `save` counts toward the `sign_in` rate limit.

`site` is the site the client believes the tab is on, a host or a URL. If the tab's host is not that site or a subdomain of it, the reply is `not_allowed` with `reason: "site_mismatch"`. A client that leaves `site` out still works. Send it, so a tab that navigated away between your steps is refused.

## Verification codes (macOS and Windows)

Off by default, and only on macOS and Windows. In Settings, on the Agents tab, the user turns on Allow agents to read verification codes and verify for you. The setting is per browser profile and lives in `chrome.storage.local`, so it is never synced to another device. It only does anything while Allow agent sign-in is on.

`verify_code` takes `tabId`, an optional `site` and an optional `username`. It has two code sources, chosen by the tab's host:

| site | where the code comes from |
|---|---|
| Apple sign-in hosts (`appleid.apple.com`, `account.apple.com`, `idmsa.apple.com`, `www.icloud.com`, `icloud.com`, matched exactly) | Apple's trusted-device prompt, read by the code reader. Needs the agent allowlist; Allow every site (*) does not apply |
| every other site | the one-time codes Apple Passwords offers for that tab: authenticator codes saved for the site (macOS and Windows), plus codes from Messages and Mail that macOS offers (macOS only). Needs the agent allowlist, or Allow every site (*) with its rules |
| emailed or SMS codes otherwise | not served here: use Keytray |

The Apple prompt reader never runs on another site, because it would put an Apple Account code into that site. The request works in this order, and each step that fails ends it with the error shown:

1. the setting is on, else `not_allowed` with `reason: "code_reader_off"`; the platform is macOS or Windows, else `not_allowed` with `reason: "mac_only"`;
2. `url` is not accepted (`bad_request`); the tab exists (`no_tab`); `site` matches the tab (`site_mismatch`); the host is not blocked, and PassBridge may fill there (`not_allowed`). An Apple sign-in host must also be on the allowlist. Any other host must be on the allowlist, or Allow every site (*) must be on and the tab must be `https:` and not a local or dev host (`not_allowed`);
3. fewer than 3 `verify_code` requests succeeded the field probe in the last 10 minutes (`rate_limited`), counted across both sources;
4. the page has a code field (`no_field`). Nothing is spent and no code is read before this probe passes. On another site only the tab's top frame is probed;
5. the code is read. Apple sign-in host: the reader presses Allow on Apple's prompt on this computer, with no tap from the user, and reads the 6 digits. Any other site: PassBridge lists the one-time codes Apple Passwords offers for the tab and keeps the authenticator codes saved for the tab's own site (or a parent of it). With `username` it picks that one, else it needs exactly one. With none, it takes a single Messages or Mail code (if that code names a site, the site must match). An authenticator code is read fresh, and Apple Passwords may ask for approval;
6. the extension checks the code again (6 digits from the prompt, 4 to 10 digits from Apple Passwords), checks the setting is still on (switching it off mid-read cancels the read), and enters the code only in the field it probed. The digits go to that field and nowhere else: not to the agent, not to the Activity list, not to a log.

Success on an Apple sign-in host is `{"id":"…","ok":true,"domain":"appleid.apple.com","filled":true}`. On another site it also carries `source`, `"totp"` or `"messages"`: `{"id":"…","ok":true,"domain":"github.com","filled":true,"source":"totp"}`. A notification names the site each time, whether or not the code was entered. `verify_code` does not submit the page; the client clicks the page's own button.

Your own sign-ins use the same switch (Auto-fill verification codes (you and agents)). When you focus an empty code field on an exact Apple sign-in host (the list above), PassBridge reads the prompt the same way and enters the code in that field only, with no agent and without Allow agent sign-in, the agent allowlist or an Activity row. Every failure is silent. It counts at most 3 per 10 minutes, apart from `verify_code`, and shows the same notification. The page gets no reply with a result, and the code is never stored or logged. Codes sent by SMS or email are not read here: Keytray fills those.

Errors from Apple Passwords (other sites): `no_code` (no code offered for this site; the reply carries `hint`: "No code for this site in Apple Passwords. Emailed and SMS codes: use Keytray."), `several_codes` (more than one and no matching `username`; the reply may list `usernames`, never a code), `needs_user` (not paired, or the approval was refused or timed out) and `reader_failed` (anything else, or a code that is not 4 to 10 digits).

Errors from the Apple prompt reader: `busy` (another read is running), `no_prompt` (no Apple prompt appeared), `several_prompts` (more than one, so nothing is pressed), `not_configured` (this build has no recorded prompt description), `reader_missing` (the code reader app or the relay support for it is missing), `reader_failed` (it crashed, timed out or sent something that was not 6 digits), and `needs_user` with `reason: "reader_permission"` (PassBridge Code Reader has no Accessibility access, macOS only). The Python relay passes the code reader work to a signed app, `PassBridge Code Reader`, over a private socket in the app folder. The one-time nonce is in a `0600` file next to that socket (never in argv), the socket closes after the first connection, and a read is cancelled when the extension or the setting goes away.

The reader presses Allow on Apple's prompt, reads the 6 digits, then presses Done on that prompt. It refuses to run (presses nothing, sends nothing) unless the socket it is given is a `reader-*.sock` directly in the PassBridge app folder and the process listening on it, found through the socket's peer pid, was started with the relay script installed in that folder (`passbridge-agent.py`). The self-test (`--self-test`) covers a foreign script, a foreign socket path, a wrong socket name and an unreadable peer.

On Windows there is no signed app and no socket. The relay starts `code-reader.ps1` from the app folder with PowerShell (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, for that one file only), as the signed-in user and without admin rights. The script reads iCloud for Windows' windows with UI Automation, presses Allow once, reads the 6 digits, presses Done and prints one JSON line on stdout, which is a pipe private to the relay (stdin and stderr are discarded). Accessibility access is not needed on Windows. `code-reader.json` next to the script names the iCloud helper's processes, the Allow and Done AutomationIds, the code pattern and the timeout; it ships with `TODO-DESCRIBE` values, so the reader answers `not_configured` and presses nothing until the real prompt is recorded. Only windows of the named processes count. Output that is not JSON, not 6 digits, a non-zero exit or a crash is `reader_failed`; a missing script or config is `reader_missing`. A cancel or the total time limit kills the child. The self-test is `powershell -File native/windows/code-reader.ps1 -SelfTest test-harness/code-reader-fixtures-win`.

Residual limit: PassBridge is not a barrier against other programs running as the same user. Such a program can start a copy of the relay script from the app folder, or change the process arguments it shows, and so pass the reader's check. The reader cannot see the extension's setting, the allowlist or the rate limit; those are enforced only on the path through the extension. The claim that digits are never returned to an agent holds for requests through the relay, not against a hostile same-user program.

Between the extension and the relay (not seen by clients) the relay's `active` and `standby` events carry `"code":true` when it supports the reader. The extension sends `{"cmd":"read_code","rid":"…"}` and `{"cmd":"cancel_code","rid":"…"}`; the relay answers with `{"event":"code","rid":"…",…}` events and the extension ignores any whose `rid` does not match. Without `"code":true` (an old relay), `verify_code` replies `reader_missing` at once.

## Unlock (Windows)

Off by default. It uses the same switch as the code reader (Settings, Agents tab, Allow agents to read verification codes and verify for you; per browser profile, never synced) and only does anything while Allow agent sign-in is on. Mac is not supported yet: it answers `not_allowed` with `reason: "win_only"` and starts nothing.

`unlock` takes no tab and no site, so the allowlist does not apply. Order: the switch is on, else `not_allowed` / `code_reader_off`; the platform is Windows, else `not_allowed` / `win_only`; already paired answers `paired` and reads nothing; after 5 wrong codes in a row it answers `locked` until a `pair_start`; more than 3 `unlock` requests in 10 minutes is `rate_limited`. Then it asks Apple for a code, the relay runs `read-pair-code.ps1` from the app folder (a UI Automation read of iCloud for Windows' window, retried for up to 20 s), and the extension passes the 6 digits to the pairing step. Errors: `no_prompt` (no code window appeared), `reader_missing` (script or relay support missing; a relay older than this version never gets the request, since it would not know the request is for a pairing code), `busy`, `reader_failed`, `wrong_pin`. The digits stay in the relay and in one variable of the extension: never in a reply, the Activity list, storage or a log. Switching the setting off during a read cancels it.

Trade-off: Apple's pairing code is a proof that a person is at the computer. With this switch on, a program running as the same user can have the code read and entered without a person, so it can unlock the store (each later password read is still approved in Apple's Passwords). That is why it is off by default, per profile, and rate limited. `read-pair-code.ps1` takes the first window text of the iCloud helper that looks like 6 digits.

## Allow every site (*)

Off by default. In Settings, on the Agents tab, the user can turn on Allow every site (*). The switch only does anything while Allow agent sign-in is on. Listed sites behave as before. For any other site:

- the tab must be `https:`; plain HTTP is refused even if Fill and save on HTTP pages is on, and so are `localhost`, `127.0.0.1`, `[::1]`, `.localhost` and `.test` hosts;
- a site in the user's blocked domains is refused (on listed sites too);
- `logins` and `sign_in` only see logins saved for the tab's own site, a subdomain of it, or its `www.` form. A login saved only for another domain, such as a college's SSO domain, is not offered. A login saved for a sibling host on the same site (for example `billing.example.com` when the tab is on `auth.example.com`) is not offered either; on a miss it is listed in `near`, for information only, and never filled;
- the password is read fresh each time and refused (`not_allowed`) unless the record read is itself saved for the site;
- only the page's own frames on the same origin are filled, never an allowlisted frame from another site;
- each password read still needs the user's approval in Apple's Passwords.

`tabId` is Chrome's tab id, the same id Claude in Chrome's tab tools use. `sign_in` only fills the fields; it doesn't submit the form. The client clicks the page's own sign-in button afterwards. It also fills allowlisted sign-in frames inside the page, such as idmsa.apple.com under apple.com.

If `username` is left out and the site has exactly one login, that login is used. With several logins, the reply is `choose_login` with the list. Usernames are matched without regard to case or surrounding spaces.

When the page already shows a fixed account (a password-only step: a hidden or read-only username, an account chip or the address in the text near the password field), only that account is filled. With no `username`, the saved login matching it is picked; a `username` for a different account, or no saved login for it, is `username_mismatch` and nothing is filled.

## Replies

Success:

```json
{"id":"…","ok":true,"paired":true,"enabled":true,"allowlist":["github.com","google.com","vercel.com","apple.com"],"allowAll":false,"save":false}
{"id":"…","ok":true,"domain":"github.com","usernames":["octocat"]}
{"id":"…","ok":true,"domain":"github.com","username":"octocat"}
```

The three lines are `status`, `logins` and `sign_in`. `save` succeeds with `{"id":"…","ok":true,"domain":"github.com","username":"octocat"}`.

### Misses: `lookedUp`, `near`, `nearSites`

When nothing is offered (`logins` with an empty `usernames`, or `sign_in` ending in `no_login`, whether the site has no login or none matches `username`), the reply may say why. These fields never appear on a success, never carry a password or code, and nothing named in them is ever filled:

- `lookedUp`: the hosts PassBridge asked Apple about, the tab's host first.
- `near`: with Allow every site (*), logins that were found but not offered because they are saved for another host of the same registrable domain, as `[{"site":"billing.example.com","usernames":["octocat"]}]`. Omitted when there are none.
- `nearSites`: sites with a similar spelling (two letters swapped or one dropped in the site name, with and without `www.`) that do have a login. Site names only, no usernames. PassBridge makes at most 12 extra lookups for this, only on a miss, and each asks only for usernames. Omitted when there are none.

`sign_in` with a `username` that is not saved, on a site that has other logins, also carries `usernames`.

Failure: `{"id":"…","ok":false,"error":"<code>"}`. `choose_login` and `username_mismatch` also carry `usernames`. `not_allowed` may carry `reason`; the values are `site_mismatch` and `save_off`, and the Agents > Activity list shows it.

| error | meaning |
|---|---|
| `not_enabled` | agent sign-in is off in Settings |
| `unknown_op` | the op isn't `status`, `pair_start`, `pair_pin`, `unlock`, `logins`, `sign_in`, `save` or `verify_code` |
| `bad_request` | the line isn't a JSON object, or `id` or `op` is missing, or `save` has no `username` or `password`, or `save` names both or neither of `tabId` and `url`, or `url` does not parse, or `logins` or `sign_in` has a `url` |
| `bad_pin` | `pair_pin`: `pin` is not exactly 6 digits |
| `wrong_pin` | `pair_pin`: Apple rejected the code |
| `locked` | `pair_pin`: 5 wrong codes in a row; send `pair_start` for a fresh code |
| `exists` | `save`: a login with that username already exists for the site |
| `no_tab` | no tab with that id, or it has no URL |
| `not_allowed` | the tab's site isn't on the allowlist (and Allow every site is off), or PassBridge refuses to fill there (for example plain HTTP, a blocked domain or a dev host), or `site` doesn't match the tab (`reason: "site_mismatch"`), or `save` while Allow agents to save new logins is off (`reason: "save_off"`), or `verify_code` with the setting off (`reason: "code_reader_off"`), on a platform other than macOS and Windows (`reason: "mac_only"`) or, on an Apple sign-in host, a site that is not on the allowlist (Allow every site does not apply there) |
| `rate_limited` | more than 10 `sign_in` or `save` requests in 10 minutes, or more than 3 `verify_code` requests in 10 minutes (counted separately) |
| `needs_user` | the user has to act: the extension isn't paired, or the Passwords approval (Touch ID) was refused or not given in time |
| `no_login` | no saved login for the site, or none matching `username`; may carry `lookedUp`, `near`, `nearSites` (see Misses) |
| `choose_login` | several logins and no `username` given; pick one from `usernames` |
| `username_mismatch` | `sign_in`: the page shows a fixed account that differs from `username`, or no saved login matches it; `usernames` lists the saved ones. Go back on the page and enter the right account first |
| `fill_failed` | no sign-in form was found or the fill didn't take (`verify_code`: the code was read but not entered) |
| `no_field` | `verify_code`: the tab has no code field |
| `no_code` | `verify_code` on a non-Apple site: Apple Passwords offers no code for it; carries `hint` (use Keytray for emailed and SMS codes) |
| `several_codes` | `verify_code` on a non-Apple site: several codes and no matching `username`; may carry `usernames` |
| `busy`, `no_prompt`, `several_prompts`, `not_configured`, `reader_missing`, `reader_failed` | `verify_code`: see Verification codes (macOS and Windows); `unlock` shares `busy`, `no_prompt`, `reader_missing` and `reader_failed`, see Unlock (Windows) |
| `timeout` | the extension didn't answer within 90 s (sent by the host) |
| `extension_gone` | the browser or extension went away mid-request (sent by the host) |

The reference CLI: `status`, `pair-start`, `pair-pin` (reads the 6 digits as one line from stdin, never from the command line, for example `printf '%s
' 123456 | python3 passbridge-agent-cli.py pair-pin`), `logins <tabId>`, `sign_in <tabId> [username]`, and `save <tabId> <username>` or `save --url <https-url> <username>`, which reads the password from stdin (never from the command line), for example `printf '%s' "$PW" | python3 passbridge-agent-cli.py save 12 octocat`, or `... save --url https://github.com/login octocat`. `verify-code <tabId> [site]` runs `verify_code` (macOS and Windows only).

`logins` and `sign_in` also take, anywhere after the `tabId`, `--site <host>` (sent as `site`, so a tab that navigated away is refused) and `--wait <seconds>` (a whole number; a missing or bad value is a usage error, exit 2). With `--wait N`, `logins` asks again every 10 s (`PASSBRIDGE_WAIT_STEP` sets the step in seconds, for tests) until a username is listed or N seconds have passed, and prints the last reply. `sign_in --wait N` does the same with `logins` first, until some login is listed (or the named `username`, matched without regard to case), then sends `sign_in` once. A `logins` reply that is not `ok` is printed at once, exit 1, and no `sign_in` is sent. Each request has its own `id`. Without `--wait` one request is sent.

## Sync

PassBridge keeps no copy of the login list: every lookup asks Apple's helper live. Apple syncs logins between devices on its own schedule and offers no way to trigger a sync or to read when one last ran, so a login saved on another device a few minutes ago can be missing here until Apple copies it. `--wait` covers that: it keeps asking until the login appears or the time is up.

The reference CLI adds two codes of its own, without an `id`: `no_host`, when it can't connect, and `no_reply`, when the connection closed with no answer. Wait at least 90 s for a reply, because a Touch ID prompt can take that long. The CLI waits 100 s.

## Removed

`fill_code` (filling a one-time code the agent supplied) was removed before 1.4.0 and now returns `unknown_op`. `verify_code` is not its return: the agent never sends or receives a code.

A one-day spike on whether a program outside the browser can use Apple's helper, with its findings and a go or no-go for a desktop app, is in [desktop-app-spike.md](desktop-app-spike.md).
