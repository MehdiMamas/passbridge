# Windows findings

Probed on this PC on 2026-09-30. iCloud for Windows was already installed.

## What is installed

| Item | Value |
|---|---|
| Package | `AppleInc.iCloud_15.9.60.0_x64__nzyj5cx40ttqa` (Status Ok) |
| Helper alias | `%LOCALAPPDATA%\Microsoft\WindowsApps\iCloudPasswordsExtensionHelper.exe` |
| Real binary | `C:\Program Files\WindowsApps\AppleInc.iCloud_15.9.60.0_x64__nzyj5cx40ttqa\iCloud\iCloudPasswordsExtensionHelper.exe` |
| Chrome host key | `HKLM\Software\Google\Chrome\NativeMessagingHosts\com.apple.passwordmanager` |
| Manifest | `...\iCloud\ChromePwdMgrHostApp_manifest.json` |

The manifest Apple registered:

```json
{
  "name": "com.apple.passwordmanager",
  "description": "Apple iCloud Chrome/Edge Password Manager Host App",
  "path": "iCloudPasswordsExtensionHelper.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/",
    "chrome-extension://mfbcdcnpokpoajjciilocoachedjkima/"
  ]
}
```

`path` is relative, and the manifest file lives under `Program Files\WindowsApps`. Chrome therefore starts the helper inside that protected package directory. There was no HKCU override and no Edge key. `native/windows/install.ps1` writes an HKCU manifest that points at the WindowsApps **alias** and registers it for Chrome, Edge, Brave, Chromium, and Vivaldi.

Spawning the helper from Node succeeded both via the alias and via the package path. The failure people hit is Chrome launching the host from the protected directory, not the binary itself being broken. The installer still prefers the alias.

## Live protocol

Native-messaging client, origin `chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/`.

`GET_CAPABILITIES` (`cmd` 14) returned:

```json
{
  "cmd": 14,
  "capabilities": {
    "secretSessionVersion": 1,
    "canFillOneTimeCodes": true,
    "supportsSubURLs": true,
    "scanForOTPURI": true
  }
}
```

`secretSessionVersion` 1 is SRP with RFC verification, the same session the extension already speaks. Not advertised, so the UI hides them: `canOpenPasswordsAppToNewPasswordSheet`, `canSaveAccountWithEmptyUserName`, `shouldUseBase64`.

A client-hello (`m0`) was accepted. The server hello PAKE fields were:

| Field | Type on the wire | Notes |
|---|---|---|
| `MSG` | string `"1"` | macOS sends a number. `protocol.js` already compares with `.toString()` |
| `PROTO` | number `1` | |
| `VER` | string `"1.0"` | |
| `B`, `s` | hex strings with a `0x` prefix | `shouldUseBase64` was absent, so hex is correct |
| `ErrCode` | absent on success | |

The PIN itself never travels in this reply. The helper shows it in the Windows UI. This probe did not type the code, so it did not unlock the vault, fill a login, or observe a Windows Hello prompt. A wrong or string `ErrCode` on the verify step is covered by `test-harness/automation/windows-host.test.mjs`.

## Policy key

Creating `HKCU\Software\Policies\Google\Chrome` (and the Edge, Brave, Chromium, and Vivaldi equivalents) returned Access Denied for this user. Existing keys under `HKCU\Software\Policies` are only `Microsoft` and `Power`. The policy host writes the DWORD directly when it can. When it cannot, it asks Windows to import a `.reg` file with a UAC prompt, the same shape as the macOS profile approval. The automated check skips that prompt (`OPENPASSWORDS_NO_ELEVATE=1`) and confirms the host returns an error instead of crashing.
