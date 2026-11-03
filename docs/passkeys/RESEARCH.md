# Passkeys from Apple Passwords in Chrome: research

All sources were fetched on 2026-11-03. Page dates are given where the page shows one. "UNCONFIRMED" means no primary source was found that day.

## Summary

- **No third-party signing path to iCloud Keychain passkeys exists.** Apple lets only a real web browser with the `com.apple.developer.web-browser.public-key-credential` entitlement ask iCloud Keychain to sign for any relying party. A Chrome extension or a helper app cannot hold it. Apple's own native-messaging helper (the one PassBridge talks to) has no passkey command (see Proof 1 below).
- **macOS: already solved by Chrome.** Chrome 118+ on macOS 13.5+ uses iCloud Keychain passkeys natively.
- **Windows: the only live route is hybrid (QR + Bluetooth) to the iPhone,** built into Chrome on Windows 10 and into the OS on Windows 11 23H2+. iOS and iPadOS do not support persistent linking, so every sign-in needs a fresh QR scan.
- **Credential Exchange (iOS/macOS 26) can copy passkeys out of Apple Passwords** into another credential-provider app, user-initiated each time. It is a one-time copy, not a sync and not a signing API.
- **Chrome has one official extension API that can answer WebAuthn requests:** `chrome.webAuthenticationProxy`. It is meant for remote desktop software, only one extension can attach, and while attached it suspends all native WebAuthn in that browser.

## 1. Apple Credential Exchange

| Fact | Source |
|---|---|
| `ASCredentialExportManager`, `ASCredentialImportManager`, `ASExportedCredentialData`, `ASImportableAccount` are available on iOS, iPadOS, macOS, Mac Catalyst and visionOS **26.0** | [ASCredentialExportManager](https://developer.apple.com/documentation/authenticationservices/ascredentialexportmanager), [ASCredentialImportManager](https://developer.apple.com/documentation/authenticationservices/ascredentialimportmanager) |
| "ASCredentialExportManager allows your app to exchange authentication credentials like passwords and passkeys with other apps." | same |
| The receiver is a **credential provider extension** with Info.plist keys `ASCredentialProviderExtensionCapabilities > SupportsCredentialExchange = YES` and `SupportedCredentialExchangeVersions` ("Currently the only available version is 1.0"). No special entitlement is named. | same |
| "The operating system acts as an intermediary to establish the identities of the password manager apps involved and performs the exchange; this process doesn't write any data to the file system." | ASCredentialExportManager |
| Export fails "if the device isn't configured with a passcode, Touch ID, or Face ID." | ASCredentialExportManager `requestExport(for:)` |
| WWDC25 session 279 "What's new in passkeys": "The transfer process is user initiated, occurs directly between participating credential manager apps and is secured by local authentication like Face ID." | [WWDC25 279](https://developer.apple.com/videos/play/wwdc2025/279/) |
| `ASImportableAccount` is "a representation of Account as defined in the Credential Exchange Format (CXF) specification" | [ASImportableAccount](https://developer.apple.com/documentation/authenticationservices/asimportableaccount) |
| Apple Passwords export works today with Bitwarden, Dashlane, DuckDuckGo, Devolutions and others; on macOS "1Password and some other apps haven't adopted it there yet." (2026-09-07) | [rmondello.com](https://rmondello.com/2026/09/07/switching-password-managers-2026/) |
| "This process copies the passkey without moving it." The Apple Account's own passkey cannot be exported. (2025-09-29) | [Six Colors](https://sixcolors.com/post/2025/09/export-keys-securely-from-passwords-to-third-party-managers/) |
| Whether the receiver must be App Store or notarized: not stated. | UNCONFIRMED |

### FIDO CXF and CXP

| Spec | Status | Source |
|---|---|---|
| CXF 1.0 (format) | Proposed Standard with errata, 2026-03-09. The passkey item has `key`: "The private key associated to this passkey instance" (PKCS#8, base64url). | [cxf-v1.0-ps-errata-20260309](https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html) |
| CXP 1.0 (protocol) | Working Draft 2024-10-03: "not intended to be a basis for any implementations". No newer version found. | [cxp-v1.0-wd-20241003](https://fidoalliance.org/specs/cx/cxp-v1.0-wd-20241003.html) |

Apple's exchange carries CXF data through its own system-mediated flow; it does not use the CXP wire protocol.

## 2. Remote use of an iPhone passkey

| Fact | Source |
|---|---|
| WebAuthn Level 3 is a W3C Recommendation, 25 August 2026. `hybrid` transport "supports, for example, authentication on a desktop computer using a smartphone." | [W3C webauthn-3](https://www.w3.org/TR/webauthn-3/) |
| CTAP 2.2 Proposed Standard, 14 July 2025. §11.5.1 QR-initiated and §11.5.2 state-assisted ("linking") hybrid. The linking "contact ID" is, "For Android", an FCM registration token. | [CTAP 2.2](https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html) |
| "Persistent linking is available between Android devices (authenticator) and Windows 11, version 23H2, and later. **iOS and iPadOS don't support persistent linking.**" (updated 2025-02-19) | [Microsoft Learn: Reference for passkeys](https://learn.microsoft.com/en-us/windows/apps/develop/security/reference) |
| Same statement, also for Chrome and Edge as clients (updated 2025-10-31). | [passkeys.dev Windows reference](https://passkeys.dev/docs/reference/windows/) |
| No Apple, Google or Microsoft source says iOS 26 added linking. **As of 2026-11-03: no persistent linking for iPhone** (no evidence of change since those pages). | searches on 2026-11-03 |
| Before Windows 11 23H2, including Windows 10, cross-device authentication "is only available in Chrome and Edge" (108+). From 23H2 the OS handles it for all apps. | passkeys.dev |
| Both devices need Bluetooth and internet. | [Microsoft Learn: Support for passkeys in Windows](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/) (updated 2026-10-08) |

## 3. Chrome and the operating systems

### macOS

| Fact | Source |
|---|---|
| "Chrome supports passkeys on iCloud Keychain starting in Chrome 118, on macOS 13.5 or later." The user grants Chrome access once. | [Chrome blog](https://developer.chrome.com/blog/passkeys-on-icloud-keychain) |
| Chromium gates this on the browser entitlement (`SecTaskCopyValueForEntitlement(... "com.apple.developer.web-browser.public-key-credential")`) and uses `ASAuthorizationWebBrowserPublicKeyCredentialManager` and `ASAuthorizationPlatformPublicKeyCredentialProvider`. | `device/fido/mac/icloud_keychain_sys.mm` in Chromium main |
| The entitlement "lets your app make registration and assertion requests for passkeys and security keys for any relying party identifier." "Only add this entitlement if your app can act as a user's web browser." Requesting it needs the Account Holder role and the macOS Browsers Passkeys form. | [Apple entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential), [forum thread 829169](https://developer.apple.com/forums/thread/829169) (Jun 2026) |
| `ASCredentialProviderViewController` macOS 11+, `ASPasskeyCredentialRequest` macOS 14+. Whether Chrome routes WebAuthn to third-party macOS credential providers: no Chromium statement found. | [ASPasskeyCredentialRequest](https://developer.apple.com/documentation/authenticationservices/aspasskeycredentialrequest); UNCONFIRMED |

### Windows

| Fact | Source |
|---|---|
| Third-party passkey providers ("plugin authenticators") became generally available "with the Windows November 2025 security update", 1Password and Bitwarden at launch. Windows 11 only. | [Windows IT Pro blog](https://techcommunity.microsoft.com/blog/windows-itpro-blog/-/4467572) (2025-11-11) |
| Requirements: Windows 11 24H2 or 25H2, build minor ≥ 6725; a packaged app registers a COM class, implements `IPluginAuthenticator`, calls `WebAuthNPluginAddAuthenticator`. | [Passkey manager sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/passkeymanager) (2026-09-03), [webauthnplugin.h](https://learn.microsoft.com/en-us/windows/win32/api/webauthnplugin/nf-webauthnplugin-webauthnpluginaddauthenticator) |
| **Windows 10 is not supported** by the plugin APIs (not mentioned anywhere; Windows 10 support ended October 2025). | same |
| Google Password Manager syncs passkeys on "Windows 10 or up"; Windows Hello passkeys do not sync. | [Chrome help 13168025](https://support.google.com/chrome/answer/13168025) |
| No way for Chrome on Windows to use iCloud Keychain passkeys other than hybrid was found. | searches on 2026-11-03 |

### Chrome extension APIs

| Fact | Source |
|---|---|
| `chrome.webAuthenticationProxy` "lets remote desktop software running on a remote host intercept Web Authentication API" requests. Permission `webAuthenticationProxy`, Chrome 115+. | [API reference](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy) |
| `attach()`: "regular processing of WebAuthn requests is suspended"; "fails with an error if a different extension is already attached." | same |
| Opened to third-party extensions in Chrome 115, "designed for remote desktop host software to forward WebAuthn requests". | [Chromium PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/C8DYxtipzbQ) (2023-05-31) |
| "The webAuthenticationProxy extension API is supported on Win/Mac/Linux." No policy or remote-session gate in that file. | `chrome/browser/webauthn/chrome_web_authentication_delegate.cc` |
| Native messaging gives no WebAuthn hook; it only carries messages. | [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) |

### Why overriding `navigator.credentials` is not a solution

Bitwarden and 1Password replace `navigator.credentials.create/get` in the page ([Bitwarden contributing docs](https://contributing.bitwarden.com/architecture/deep-dives/passkeys/implementations/provider/browser-extension): "reassigning the `navigator.credentials.create` and `navigator.credentials.get` methods"). A May 2026 review of 1Password's wrapper ([Scott Helme, 2026-05-21](https://scotthelme.co.uk/passkeys-permissions-policy-and-bug-hunting-in-1passwords-webauthn-wrapper/)) found the wrapper ignores Permissions-Policy, its page message channel "has no per-page authentication", and "page JavaScript could overwrite it outright". The page-world code, not the browser, then decides the origin and RP ID. For PassBridge it would also not help: there is still no key to sign with (section 1 and Proof 1). PassBridge keeps its MAIN-world code limited to hiding conditional prompts (`src/passkey-guard.js`).

## 4. Other password managers

See the table in [COMPATIBILITY.md](COMPATIBILITY.md#other-password-managers).

## 5. Proofs run for this research

### Proof 1: Apple's helper protocol has no passkey operations

- Package: Apple's "iCloud Passwords" Chrome extension, id `pejdijmoenmkgeppbflobdenhhabjlaj`, version **3.4.0**, downloaded from the Chrome Web Store update service on 2026-11-03 (crx sha256 `610ddd34…3d84f26`). Inspected as text, not run.
- Permissions: `privacy, declarativeContent, nativeMessaging, webNavigation, storage, contextMenus, scripting`. No `webAuthenticationProxy`.
- The full `ExtensionCommand` enum in its `background.js`: 0 EndOp, 1 Unused, 2 Handshake, 3 SetIconAndTitle, 4 GetLoginNames4URL, 5 GetPassword4LoginName, 6 SetPassword4LoginNameURL, 7 NewAccount4URL, 8 TabEvent, 9 PasswordsDisabled, 10 ReloginNeeded, 11 LaunchiCP, 12 iCPStateChange, 13 LaunchPasswordsApp, 14 Hello, 15 OneTimeCodeAvailable, 16 GetOneTimeCodes, 17 DidFillOneTimeCode, 18 SetUpTOTPGenerator, 19 DidCancelPINPairing, 1984 OpenURLInSafari.
- Searching all of its scripts for `passkey|webauthn|publickeycredential|navigator.credentials|webAuthenticationProxy|assertion|fido|ctap` finds only the `webauthn` autocomplete token used to classify username fields.
- The Windows helper's `GET_CAPABILITIES` reply (`docs/windows-findings.md`) advertises no passkey capability either.
- **Result: VERIFIED.** No passkey list or sign operation exists in Apple's native-messaging protocol.

### Proof 2: an extension answering WebAuthn through `webAuthenticationProxy`

See [TESTING.md](TESTING.md#proof-2-webauthenticationproxy).
