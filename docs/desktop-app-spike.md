# Desktop app spike (#330)

Question: can a process outside the browser talk to Apple's helper, and do list-all, edit or delete exist? Findings only; nothing here ships. The throwaway script is `scripts/spike/non-browser-client.ts`. Nothing in this spike ran against Apple's real helper: no real prompt, unlock or sign-in, no real iCloud data.

## Verdicts

| Edge case | Verdict |
|---|---|
| Apple's helper only accepts the extension id's origin | Needs owner. The rule is a host manifest `allowed_origins` list that the browser enforces; whether Apple's helper also checks its caller is not answerable from this repo or the fake. |
| No list-all message exists | Confirmed for everything PassBridge and the pinned client references send: lookup is per site only. Whether the real helper has an undocumented list-all is only answerable on a real helper (owner checklist). |
| A step needs a real Apple prompt | Not run. Listed in the owner checklist at the end. |

## 1. What a non-browser client needs (script output)

The script (`node scripts/spike/non-browser-client.ts`) is a plain Node process. It uses `src/apple/srp.ts` for the pairing maths (it runs under plain Node, no DOM or `chrome` API) and starts `test-harness/fake-apple-helper/host.ts` itself as a child process, which is the part a browser normally does. Output of one run (the code differs each run):

```
1. capabilities (cmd 14, no pairing needed)
  -> frame 10 bytes, cmd 14
  <- frame 207 bytes, cmd 14
   {"secretSessionVersion":1,"canFillOneTimeCodes":true,"supportsSubURLs":true,"scanForOTPURI":true,"canOpenPasswordsAppToNewPasswordSheet":true,"canSaveAccountWithEmptyUserName":true}
2. lookup before pairing (no key yet, so the body is a placeholder): the helper stays silent
  -> frame 167 bytes, cmd 4
   reply: none (timed out)
3. handshake m0 (helper shows a 6-digit code on screen)
  -> frame 1197 bytes, cmd 2
  <- frame 1234 bytes, cmd 2
   code the helper is showing: 145197
4. wrong code
  -> frame 202 bytes, cmd 2
  <- frame 130 bytes, cmd 2
   reply: {"MSG":3,"ErrCode":1} (the challenge is burned)
5. new handshake, right code (unlock)
  -> frame 1197 bytes, cmd 2
  <- frame 1234 bytes, cmd 2
  -> frame 202 bytes, cmd 2
  <- frame 230 bytes, cmd 2
   reply: {"MSG":3,"ErrCode":0}, helper.paired = true
6. per-site lookup (cmd 4, ACT 5 with the page hostname)
  -> frame 283 bytes, cmd 4
  <- frame 610 bytes, cmd 4
   {"STATUS":0,"users":["mia@pb-e2e.invalid"]}
  -> frame 307 bytes, cmd 4
  <- frame 260 bytes, cmd 4
   other site: {"STATUS":3}
done: a plain Node process paired and looked up a login through the 4-byte framing.
```

What it proves, and only that: the framing (4-byte little-endian length plus JSON, `test-harness/fake-apple-helper/host.ts:20-35`), the capability call, SRP pairing with the 6-digit code (`src/apple/protocol.ts:345-380` issue, `:381-430` verify), and an encrypted per-site lookup (`src/apple/protocol.ts:454-470`) all work from a process that is not a browser.

What it cannot prove: the fake is an in-process class (`test-harness/fake-apple-helper/helper.ts`, `FakeHelper.connect`); `host.ts` never looks at who started it. So the output says nothing about whether Apple's helper accepts a caller that is not the browser. The pairing code is the helper's own 6-digit PIN used as the SRP password (`src/apple/srp.ts:1`, `:95-112`); no other credential appears in the handshake.

## 2. The extension id and the origin rule

- Apple's helper is a native-messaging host named `com.apple.passwordmanager` (`src/apple/protocol.ts:15`, `:239`). The browser starts it only for the extension ids in the host manifest's `allowed_origins`. On Windows Apple's manifest lists `pejdijmoenmkgeppbflobdenhhabjlaj` and `mfbcdcnpokpoajjciilocoachedjkima` (`docs/windows-findings.md:19-27`), and `native/windows/install.ps1:62-65` writes the same two when it replaces a broken manifest.
- PassBridge's own hosts use the same mechanism with one id: `native/install.sh:73`, `:82`, `:91` and `native/windows/install.ps1:162` (`allowed_origins` is `chrome-extension://<ext id>/`). `native/install.sh` does not write Apple's manifest on macOS; that one is Apple's.
- PassBridge's manifest key forces Apple's extension id, because "macOS only accepts Apple's extension id" (`SETUP.md:3`). That is the repo's own statement that the Mac side is tied to the id; the repo does not say whether the check is the browser's or the helper's.
- The Windows probe ran the helper as "Native-messaging client, origin `chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/`" (`docs/windows-findings.md:36`), so the helper is started with the origin as an argument; whether it looks at it is not recorded.
- On Windows this is partly answered already: a probe spawned the real helper from Node, with no browser, through the alias and the package path (`docs/windows-findings.md:32`), got `GET_CAPABILITIES` (cmd 14) back, and its client hello (`m0`) was accepted (`docs/windows-findings.md:54-64`). So on Windows a non-browser process can connect and start a handshake. That probe did not type the code, so pairing and any lookup are still unproven there.
- macOS is the open part: nothing in the repo shows a non-browser process reaching the Mac helper. The fake has no origin check (`host.ts` takes no argument), so it cannot answer it. Verdict: needs owner on macOS (checklist item 1).

## 3. Messages that exist in the protocol

Defined in the pinned client reference, which is a client, not the helper: `vendor/au2001/README.md:1` calls it "the diff baseline for Apple's helper protocol". It shows which messages are defined, not what the real helper accepts or refuses.

| Message | Defined | Sent by PassBridge | Source |
|---|---|---|---|
| `Action.DELETE = 0`, `QueryStatus.FAILED_TO_DELETE = 4` | yes | never | `vendor/au2001/src/utils/enums.ts:35-37`, `:50`; absent from `src/apple/protocol.ts:76` |
| `Action.UPDATE = 1`, `QueryStatus.FAILED_TO_UPDATE = 5` | yes | never (declared at `protocol.ts:76`, no use) | `vendor/au2001/src/utils/enums.ts:38`, `:51` |
| `Action.ADD_NEW = 3` | yes | never (declared at `protocol.ts:76`, no use) | `vendor/au2001/src/utils/enums.ts:40` |
| `Action.GHOST_SEARCH = 5` (login names for a host) | yes | yes, with `URL: hostname` | `src/apple/protocol.ts:462`, `:537`; `vendor/au2001/src/utils/api.ts:274` |
| `Action.SEARCH = 2` (one password) | yes | yes, with `URL` and `USR` | `src/apple/protocol.ts:484`, `:551`; `vendor/au2001/src/utils/api.ts:339` |
| `Action.MAYBE_ADD = 4` (add, Apple shows its own prompt) | yes | yes | `src/apple/protocol.ts:507` |
| list-all | no message, no `Action` | n/a | `vendor/au2001/src/utils/enums.ts:35-43` lists every `Action`; every query carries a hostname (`src/apple/protocol.ts:454-470`, `:472-490`) |

Commands with an encrypted query id are only 4, 5, 16 and 17 (`src/apple/protocol.ts:69-74`). `vendor/open-passwords/src/protocol.js:58` has the same `Action` list as ours (no `DELETE`).

Verdicts: delete is defined by Apple's enum but nothing here has ever sent it, so whether the helper honours it is unknown. Update is defined and never sent, same. List-all has no message at all. Search is per site only.

The agent protocol does not change this: `save` is add-only and answers `exists` rather than overwrite (`docs/agent-protocol.md:68`, `:150`), and a reply never carries a password or code (`docs/agent-protocol.md:5`). The agent reaches Apple only through the browser extension (`native/passbridge-agent.py:2`, `docs/agent-protocol.md:27`, `:42`), so it shows that a browser is needed today, not what Apple's helper needs.

## 4. Prior art (commits pinned)

All three skip Apple's native-messaging helper. They sign in to Apple's services directly and rebuild the keychain on their own machine, so they say nothing about whether a non-browser process can use Apple's helper.

- Sank6/iCloud-Keychain-for-Linux at `412766faef0776ed745ce749bca2d36e448ceb19` (2026-11-09, MIT). Registers the computer as an Apple device through GrandSlam SRP login, joins the keychain trust (Octagon) and decrypts the iCloud Keychain (`RESEARCH.md:4`, `:19-20`). Needs an anisette server (`README.md`, "What you'll need"). Its browser extension talks to its own host `icp`, not Apple's. Proves: a non-browser client is possible by replacing the whole stack, at the cost of Apple-ID password, 2FA and the device passcode (`README.md`, "Sign in"), and an unofficial path with a risk of locking keychain recovery after about 10 wrong passcodes.
- EttienneM/iCloud-Keychain-for-Omarchy at `5563e3e96e20b68e6b25b2ddd6b56eecbf91da23` (2026-08-30). A fork of the same project with Omarchy setup notes (`OMARCHY.md`); same approach, README says it only reads and changes nothing in the account. It has no licence file in its listing.
- dahlia/coffer at `ce7011940101407529122218a62d9afcbe73d7e9` (2026-09-19, GPL-3.0, Rust, GTK 4). Native Linux client; "The initial synchronization implementation is deliberately read-only" (`README.md`, "Safe before complete"); `ROADMAP.md:198` "Keep the entire remote path read-only"; a native messaging host is still an open item (`ROADMAP.md:260-262`). Proves: a Rust client against Apple's servers is being built by someone else and is read-only so far. GPL-3.0 means no code can be copied into this repo's Apache-2.0 code.

Read on 2026-11-14; each repo was reachable and had source.

## 5. Go or no-go: Tauri 2 quick-access app (search, codes, unlock, add)

Verdict: on Windows a browser-free start is shown to work as far as the hello (`docs/windows-findings.md:32`, `:54-64`); on macOS it is unknown. So: no-go for a browser-free Mac app today; go for it only after owner checklist item 1 passes on macOS, and Windows still needs the pairing step (items 2-4) checked. Without item 1, an app has to run beside a browser that has the extension, which is what the extension already is.

Cost per feature, on the protocol as PassBridge uses it (sizes are estimates, not measured):

| Feature | Needs | Cost |
|---|---|---|
| Search by site | per-site `GHOST_SEARCH` (`protocol.ts:454`), each password read still needs approval in Apple's Passwords (Touch ID) (`docs/agent-protocol.md:50`) | small if the extension stays the engine; large if the SRP and crypto in `src/apple/*` move to Rust |
| Codes | cmds 16 and 17 (`protocol.ts:534`, `:549`), or the code reader on a prompt (`docs/agent-protocol.md:78-104`) | small to medium; the reader is already a signed app |
| Unlock | the 6-digit code from Apple's app every time the session is lost (`docs/agent-protocol.md:53`) | small once connected; a person types the code, except that Windows has an opt-in `unlock` agent op that reads and enters it (`docs/agent-protocol.md:105-111`), which is not supported on macOS |
| Add | `MAYBE_ADD` plus Apple's own prompt (`protocol.ts:499-530`) | small; add-only |
| Browse all, edit, delete | no list-all message; update and delete never sent | not available; not in scope |

Signing and installers (Developer ID and notarization on Mac, a certificate on Windows) are a cost on top, as the issue research notes.

## Owner-only checklist (needs a real Apple helper, real prompts)

1. Start Apple's real helper from a process that is not a browser (macOS: the helper app's binary; Windows: `iCloudPasswordsExtensionHelper.exe` through the WindowsApps alias), pass it the origin argument the browser would, and send cmd 14 (`GET_CAPABILITIES`). Record: replies, or refuses, or exits. Repeat with no origin or a different one. This decides edge case 1.
2. If item 1 connects: run the handshake from `scripts/spike/non-browser-client.ts` against it. This shows the 6-digit code on screen (a real prompt). Record whether pairing succeeds and whether the code is needed every time.
3. If item 2 pairs: send `Action.UPDATE` and `Action.DELETE` for a throwaway test login you create for the purpose, and record the `STATUS`. Never against a real login.
4. If item 2 pairs: send a `GHOST_SEARCH` with an empty URL and with `*`, record whether any list-all comes back.
5. Record the helper and OS versions beside each result.
