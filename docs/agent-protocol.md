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
4. Optional: to let a program add new logins, turn on Let agents save new logins on the same tab (needs Allow agent sign-in; off by default). It can only add, never read or overwrite a login.
5. Optional: after that, the save bar shows "Let agents sign in on <site>" when you save a login for a site that is not on the allowlist. It starts checked only for a password PassBridge generated; ticking it and saving adds the site (the registrable domain, or the full host on shared hosts such as Workday tenants) to the allowlist.

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
| `save` | `tabId` (number) or `url` (string, `https://`), not both; `username` (string), `password` (string), `site` (optional string) | adds a new login for the tab's site, or for the site of `url` when no tab is named. Add-only: if that username already has a login for the site, the reply is `exists` and nothing changes |

`pair_start` and `pair_pin` need Allow agent sign-in but no tab and no allowlist, and both count toward the rate limit. After 5 wrong codes in a row, `pair_pin` answers `locked` until a `pair_start` issues a fresh code. The pin is never in a reply or the Activity list.

`save` needs Let agents save new logins, not the allowlist. The tab, or the `url`, must be `https:` and not a local host. Send exactly one of `tabId` and `url`; both or neither is `bad_request`, and so is a `url` that does not parse; a `url` that is not `https:` is `not_allowed`. Only `save` takes `url`: `logins` and `sign_in` with a `url` are `bad_request`. The Activity list keeps the origin of a `url`, never its path or query. The password is sent in the request, is never in a reply, and is never written to the Activity list (it keeps the op, tab, site and username). Apple's Passwords may show its own prompt for the new login; if nobody answers it in time, the reply is `needs_user`. The extension shows a notification for each saved login. `save` counts toward the `sign_in` rate limit.

`site` is the site the client believes the tab is on, a host or a URL. If the tab's host is not that site or a subdomain of it, the reply is `not_allowed` with `reason: "site_mismatch"`. A client that leaves `site` out still works. Send it, so a tab that navigated away between your steps is refused.

## Allow every site (*)

Off by default. In Settings, on the Agents tab, the user can turn on Allow every site (*). The switch only does anything while Allow agent sign-in is on. Listed sites behave as before. For any other site:

- the tab must be `https:`; plain HTTP is refused even if Fill and save on HTTP pages is on, and so are `localhost`, `127.0.0.1`, `[::1]`, `.localhost` and `.test` hosts;
- a site in the user's blocked domains is refused (on listed sites too);
- `logins` and `sign_in` only see logins saved for the tab's own site, a subdomain of it, or its `www.` form. A login saved only for another domain, such as a college's SSO domain, is not offered;
- the password is read fresh each time and refused (`not_allowed`) unless the record read is itself saved for the site;
- only the page's own frames on the same origin are filled, never an allowlisted frame from another site;
- each password read still needs the user's approval in Apple's Passwords.

`tabId` is Chrome's tab id, the same id Claude in Chrome's tab tools use. `sign_in` only fills the fields; it doesn't submit the form. The client clicks the page's own sign-in button afterwards. It also fills allowlisted sign-in frames inside the page, such as idmsa.apple.com under apple.com.

If `username` is left out and the site has exactly one login, that login is used. With several logins, the reply is `choose_login` with the list. Usernames are matched without regard to case or surrounding spaces.

## Replies

Success:

```json
{"id":"…","ok":true,"paired":true,"enabled":true,"allowlist":["github.com","google.com","vercel.com","apple.com"],"allowAll":false,"save":false}
{"id":"…","ok":true,"domain":"github.com","usernames":["octocat"]}
{"id":"…","ok":true,"domain":"github.com","username":"octocat"}
```

The three lines are `status`, `logins` and `sign_in`. `save` succeeds with `{"id":"…","ok":true,"domain":"github.com","username":"octocat"}`.

Failure: `{"id":"…","ok":false,"error":"<code>"}`. `choose_login` also carries `usernames`. `not_allowed` may carry `reason`; the values are `site_mismatch` and `save_off`, and the Agents > Activity list shows it.

| error | meaning |
|---|---|
| `not_enabled` | agent sign-in is off in Settings |
| `unknown_op` | the op isn't `status`, `pair_start`, `pair_pin`, `logins`, `sign_in` or `save` |
| `bad_request` | the line isn't a JSON object, or `id` or `op` is missing, or `save` has no `username` or `password`, or `save` names both or neither of `tabId` and `url`, or `url` does not parse, or `logins` or `sign_in` has a `url` |
| `bad_pin` | `pair_pin`: `pin` is not exactly 6 digits |
| `wrong_pin` | `pair_pin`: Apple rejected the code |
| `locked` | `pair_pin`: 5 wrong codes in a row; send `pair_start` for a fresh code |
| `exists` | `save`: a login with that username already exists for the site |
| `no_tab` | no tab with that id, or it has no URL |
| `not_allowed` | the tab's site isn't on the allowlist (and Allow every site is off), or PassBridge refuses to fill there (for example plain HTTP, a blocked domain or a dev host), or `site` doesn't match the tab (`reason: "site_mismatch"`), or `save` while Let agents save new logins is off (`reason: "save_off"`) |
| `rate_limited` | more than 10 `sign_in` or `save` requests in 10 minutes |
| `needs_user` | the user has to act: the extension isn't paired, or the Passwords approval (Touch ID) was refused or not given in time |
| `no_login` | no saved login for the site, or none matching `username` |
| `choose_login` | several logins and no `username` given; pick one from `usernames` |
| `fill_failed` | no sign-in form was found or the fill didn't take |
| `timeout` | the extension didn't answer within 90 s (sent by the host) |
| `extension_gone` | the browser or extension went away mid-request (sent by the host) |

The reference CLI: `status`, `pair-start`, `pair-pin` (reads the 6 digits as one line from stdin, never from the command line, for example `printf '%s
' 123456 | python3 passbridge-agent-cli.py pair-pin`), `logins <tabId>`, `sign_in <tabId> [username]`, and `save <tabId> <username>` or `save --url <https-url> <username>`, which reads the password from stdin (never from the command line), for example `printf '%s' "$PW" | python3 passbridge-agent-cli.py save 12 octocat`, or `... save --url https://github.com/login octocat`.

The reference CLI adds two codes of its own, without an `id`: `no_host`, when it can't connect, and `no_reply`, when the connection closed with no answer. Wait at least 90 s for a reply, because a Touch ID prompt can take that long. The CLI waits 100 s.

## Removed

`fill_code` (filling a one-time code) was removed before 1.4.0 and now returns `unknown_op`.
