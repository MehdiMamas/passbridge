# Setup

PassBridge fills logins from the Apple Passwords vault in Chrome on macOS and Windows. You load it unpacked. It cannot be published to the Chrome Web Store: macOS only accepts Apple's extension id, and the manifest key forces that id (`pejdijmoenmkgeppbflobdenhhabjlaj`).

Disable Apple's official iCloud Passwords extension first. Two extensions cannot share that id in one profile.

Without building it yourself: each [release](https://github.com/MehdiMamas/passbridge/releases/latest) has `passbridge.zip` (the built extension; unzip it and load that folder in place of `dist`), `passbridge-macos-helper.zip` and `passbridge-windows-helper.zip`. The helper zips hold the install and uninstall scripts below. Unzip one and run its scripts from inside that folder, where the steps below say `./native/` or `./native/windows/`.

## macOS

You need:

- macOS 14 (Sonoma) or later
- Signed into iCloud, with Passwords turned on
- Google Chrome
- [Node.js](https://nodejs.org/) 20 or newer (to build)
- Git

```bash
git clone https://github.com/MehdiMamas/passbridge.git
cd passbridge
npm install
npm run build
```

`npm run build` compiles the React popup, the settings page, and the content script into `dist/`.

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and choose the `dist` folder inside the clone (not the repo root).
4. Confirm the extension id is `pejdijmoenmkgeppbflobdenhhabjlaj`.
5. Click the toolbar icon. Your Mac shows a 6-digit code. Type it once.

Check it: open a site that has a saved login, click the username field, pick the row. macOS may ask for Touch ID. That prompt is the vault, not a bug.

### Optional macOS helper

This adds the "Hide Chrome's password manager" setting. Turning it on installs a configuration profile that you approve once in System Settings.

The helper runs on `/usr/bin/python3`, which is only a stub until the Xcode Command Line Tools are installed. Install them first if you haven't:

```bash
xcode-select --install
./native/install.sh
```

Quit Chrome with Cmd+Q and reopen it. Then open PassBridge settings.

`./native/uninstall.sh` removes the helper. If the password-manager profile is still installed, it tries to remove it and otherwise opens System Settings > General > Device Management so you can remove "PassBridge - Hide Browser Password Manager" yourself. It only says the password manager is restored once the profile is gone. It also removes older `com.openpasswords.*` registrations from before the PassBridge rename, and the pairing-code reader that earlier versions installed.

### Agent sign-in (macOS)

A local program can ask PassBridge to fill a saved login into a tab on sites you list. It gets a status back (site, username), never a password.

1. Rerun `./native/install.sh` (it installs the agent host next to the policy helper), then quit Chrome with Cmd+Q and reopen it.
2. In PassBridge settings, turn on Agent sign-in and check the allowed sites.
3. Test it with the command-line client, using a tab id from `chrome.tabs`:

```bash
P="$HOME/Library/Application Support/PassBridge"
"$P/passbridge-agent-cli.py" status
"$P/passbridge-agent-cli.py" logins <tabId>
"$P/passbridge-agent-cli.py" sign_in <tabId> [username]
```

Apple's Passwords asks for Touch ID every time a password is read (except within 15 s of the last read), so each agent sign-in needs one Touch ID approval; when no saved login exists the agent gets `no_login` and the person signs in themselves.

Errors you may see: `not_enabled`, `no_tab`, `not_allowed`, `no_login`, `choose_login`, `rate_limited` (10 per 10 minutes), `needs_user` (pair the extension or approve Touch ID), `fill_failed`. Requests are logged in the settings page.

### One-click update (macOS)

The popup's update notice always shows Update now. When the updater host (`com.passbridge.updater`, installed by `install.sh`) answers, the update runs through it: the extension downloads `passbridge.zip` and `passbridge.zip.sig` from the latest release, checks the signature against the key pinned in `src/update/verify.js` and the SHA-256 GitHub lists for the asset, then the host swaps the unpacked folder and the extension reloads. Without a `.sig` on the release the update is refused.

Maintainer: the private key is the Keychain item "PassBridge release signing key" (account `passbridge`, service `passbridge-release-signing`, the PKCS8 PEM base64 encoded on one line), with a backup in the maintainer's password manager. It never goes on GitHub. The matching public key is pinned as `PUBLIC_KEY_B64` in `src/update/verify.js`.

For each release, after the tag build uploads `passbridge.zip`: download it, then `node scripts/sign-release.mjs sign passbridge.zip` (reads the key from the Keychain, writes `passbridge.zip.sig` and checks it against the pinned key; `--key <pem file>` uses a PEM file instead), then `gh release upload vX passbridge.zip.sig`.

### Update without the helper

Without the updater host, Update now opens an update page. The first time, choose the PassBridge folder (the one loaded in `chrome://extensions`) and allow PassBridge to edit it. Chrome drops that permission whenever the extension restarts, so the next update opens the folder picker at the same folder: press Select and choose Allow on every visit, and later updates take one click. The page checks the same signature and SHA-256, writes the new files next to the old ones, swaps them in and restarts the extension. If a step fails, the previous files are put back. A browser that blocks the File System Access API gets the release link instead.

## Windows

You need:

- [iCloud for Windows](https://apps.microsoft.com/detail/9pktq5699m62) installed, with Passwords turned on
- Google Chrome
- [Node.js](https://nodejs.org/) 20 or newer
- Git

In Git Bash or PowerShell:

```bash
git clone https://github.com/MehdiMamas/passbridge.git
cd passbridge
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Load unpacked and choose the `dist` folder.
4. Confirm the id is `pejdijmoenmkgeppbflobdenhhabjlaj`.
5. Register Apple's helper for Chrome. From the repo root, in Git Bash or PowerShell:

```bash
powershell -ExecutionPolicy Bypass -File ./native/windows/install.ps1
```

Git Bash strips unquoted backslashes, so `.\native\windows\install.ps1` becomes `.nativewindowsinstall.ps1` and PowerShell cannot find the file. Forward slashes work in both shells.

6. Fully quit Chrome (check the tray) and reopen it.
7. Click the toolbar icon and type the 6-digit code iCloud for Windows shows. If the popup closes when the code appears, click the toolbar icon again. Windows Hello may ask when a password is read.

The installer points Chrome at the WindowsApps alias for `iCloudPasswordsExtensionHelper.exe`, which is more reliable than the protected package path. Details from the machine this was probed on are in [docs/windows-findings.md](docs/windows-findings.md).

`native/windows/uninstall.ps1` removes the PassBridge host keys and the older `com.openpasswords.*` keys, and clears the password-manager policy if PassBridge set it. It does not remove iCloud for Windows.

Python is needed only for the "Hide Chrome's password manager" setting. Filling passwords does not need Python. `install.ps1` ignores the Microsoft Store `python.exe` stub and says so when it finds no real Python.

On some PCs `HKCU\Software\Policies` is locked. Then the setting asks for a UAC approval and imports the policy into your own user hive, even when a different administrator account approves it.

## Is it working?

1. The toolbar icon opens a popup that says Connecting, then asks for a code, then lists logins for the current site.
2. Focusing a username or password field shows a PassBridge menu. A search box or a comment box does not.
3. Choosing a row fills the form. A one-time-code field offers a verification code only when the vault has one for that site.
4. Saving a new password shows a bar at the top of the page, then Apple's own save sheet.
5. Right-clicking a setup QR code and choosing "Scan this image for a verification code" shows a bar. After "Choose a login", PassBridge opens the Passwords app and copies nothing. "Copy setup key" copies the key only when you click it; paste it in Passwords, then clear your clipboard history. PassBridge forgets the key after the copy, a dismiss, or 2 minutes.

Shortcuts (change them at `chrome://extensions/shortcuts`):

- Ctrl+Shift+L (Command+Shift+L on Mac) fills the next saved login.
- Ctrl+Shift+. (Command+Shift+. on Mac) reopens the menu on the focused field.

## Updating

```bash
git pull
npm install
npm run build
```

Then on `chrome://extensions`, click Reload on PassBridge. You do not load the extension again unless you moved the folder.

To take a newer Bitwarden autofill snapshot, see [UPSTREAMS.md](UPSTREAMS.md).

## When something fails

**Couldn't reach Apple's password helper.** On Mac, Passwords has to be on and the id has to match. On Windows, install iCloud for Windows, turn Passwords on, run `install.ps1`, and fully quit the browser.

**The code is incorrect.** A code belongs to one handshake. If two prompts are visible, use the newest. In the popup, choose Request a new code. Codes expire after about 3 minutes.

**The menu never appears.** Another copy of this id (Apple's extension, or a second unpacked copy) is loaded. Disable the other one. In settings, Inline menu must not be Off, and the site must not be in Blocked domains.

**Windows Hello every fill.** The vault asked for it. PassBridge cannot skip that.

**Badge or context menu is empty.** The vault is still locked, or the site has no saved logins. The badge is a username count and does not read the password.
