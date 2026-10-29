# Agent sign-in protocol

A program on the same computer, such as Claude Code, can ask PassBridge to fill a saved login into a browser tab. This page is for whoever writes such a client. The reference client is `native/passbridge-agent-cli.py`.

No reply ever contains a password or a code. The extension drops any key named `password`, `pass`, `code`, `otp`, `secret` or `token` from every reply, at any depth.

## Platforms

macOS and Windows. The request and reply format is the same on both; only how a client connects differs (see Socket and named pipe).

## Turning it on

1. Run the helper's installer: `install.sh` on macOS (1.4.0 or later), `install.ps1` on Windows (needs Python). It registers the native host `com.passbridge.agent`.
2. Quit and reopen the browser.
3. In PassBridge Settings, on the Agents tab, turn on Allow agent sign-in. It is off by default.

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

There is no per-client pairing. On macOS any process of the same user that can open the socket may send requests; on Windows any process of the same user that can read `agent.key`. What protects you:
- the setting is off by default;
- only allowlisted sites can be filled;
- `sign_in` is rate limited;
- each password read still needs your approval in Apple's Passwords (Touch ID);
- every request except `status` is logged in the extension.

"Paired" means the extension itself is paired with Apple's Passwords. That is the 6-digit code shown on the Mac, entered in the PassBridge popup. If it isn't paired, `status` shows `"paired": false` and the other requests fail with `needs_user`. After the extension reloads, it reports `paired: false` until you open the popup once.

## Requests

Every request has an `id` (any non-empty string, echoed back) and an `op`.

| op | fields | what it does |
|---|---|---|
| `status` | none | reports the state, touches no tab |
| `logins` | `tabId` (number) | lists the saved usernames for that tab's site |
| `sign_in` | `tabId` (number), `username` (optional string) | fills that login into the tab's sign-in form |

`tabId` is Chrome's tab id, the same id Claude in Chrome's tab tools use. `sign_in` only fills the fields; it doesn't submit the form. The client clicks the page's own sign-in button afterwards. It also fills allowlisted sign-in frames inside the page, such as idmsa.apple.com under apple.com.

If `username` is left out and the site has exactly one login, that login is used. With several logins, the reply is `choose_login` with the list. Usernames are matched without regard to case or surrounding spaces.

## Replies

Success:

```json
{"id":"…","ok":true,"paired":true,"enabled":true,"allowlist":["github.com","google.com","vercel.com","apple.com"]}
{"id":"…","ok":true,"domain":"github.com","usernames":["octocat"]}
{"id":"…","ok":true,"domain":"github.com","username":"octocat"}
```

The three lines are `status`, `logins` and `sign_in`.

Failure: `{"id":"…","ok":false,"error":"<code>"}`. `choose_login` also carries `usernames`.

| error | meaning |
|---|---|
| `not_enabled` | agent sign-in is off in Settings |
| `unknown_op` | the op isn't `status`, `logins` or `sign_in` |
| `bad_request` | the line isn't a JSON object, or `id` or `op` is missing |
| `no_tab` | no tab with that id, or it has no URL |
| `not_allowed` | the tab's site isn't on the allowlist, or PassBridge refuses to fill there (for example plain HTTP or a blocked domain) |
| `rate_limited` | more than 10 `sign_in` requests in 10 minutes |
| `needs_user` | the user has to act: the extension isn't paired, or the Passwords approval (Touch ID) was refused or not given in time |
| `no_login` | no saved login for the site, or none matching `username` |
| `choose_login` | several logins and no `username` given; pick one from `usernames` |
| `fill_failed` | no sign-in form was found or the fill didn't take |
| `timeout` | the extension didn't answer within 90 s (sent by the host) |
| `extension_gone` | the browser or extension went away mid-request (sent by the host) |

The reference CLI adds two codes of its own, without an `id`: `no_host`, when it can't connect, and `no_reply`, when the connection closed with no answer. Wait at least 90 s for a reply, because a Touch ID prompt can take that long. The CLI waits 100 s.

## Removed

`fill_code` (filling a one-time code) was removed before 1.4.0 and now returns `unknown_op`.
