# Passkeys: compatibility

Checked 2026-11-03. Sources are in [RESEARCH.md](RESEARCH.md).

## Platforms

| Platform | Passkeys from Apple Passwords in Chrome | Notes |
|---|---|---|
| macOS 13.5+ with Chrome 118+ | Native: Chrome uses iCloud Keychain | Chrome asks once for access. |
| Windows 10 | Hybrid only (QR + Bluetooth to the iPhone) | Cross-device sign-in is handled by Chrome (108+). Third-party plugin passkey providers are not supported. |
| Windows 11 23H2 | Hybrid only | The OS handles cross-device sign-in. Plugin providers need 24H2 or newer. |
| Windows 11 24H2 and newer | Hybrid only | Plugin providers (for example 1Password, Bitwarden) work; none is Apple. |

iOS and iPadOS do not support persistent linking, so every Windows sign-in needs a new QR scan. No newer statement found as of 2026-11-03; recheck when Apple or Microsoft change it.

## Other password managers

Researched 2026-11-03 (checked 2026-11-03). Items marked UNCONFIRMED could not be verified against a fetched page. Dashlane support pages returned 403 to fetch; its facts come from search snippets (marked "snippet").

### 1Password
- Windows 11: native plugin passkey provider, needs the MSIX version. https://www.1password.community/announcements-52/official-release-1password-now-supports-windows-11-passkeys-23422 and https://support.1password.com/save-use-passkeys-windows/
- All platforms: the browser extension intercepts WebAuthn. https://support.1password.com/save-use-passkeys/
- Windows 10: the plugin API is Windows 11 only, so the extension is the route. No explicit Windows 10 statement found: UNCONFIRMED.
- macOS: native credential provider (AutoFill), plus the extension. https://support.1password.com/macos-autofill/ (search summary; exact quote not fetched, partly UNCONFIRMED).
- Credential Exchange: iOS/iPadOS 26+ and Android 14+, passkeys only on mobile; desktop none. https://support.1password.com/export/ and https://support.1password.com/import/
- Sync design for passkeys not described in the whitepaper (https://agilebits.github.io/security-design/): UNCONFIRMED. Passkeys are vault items under the vault's end-to-end encryption.
- Phone passkey (hybrid) on desktop: not documented by 1Password: UNCONFIRMED.

### Bitwarden
- Extension intercepts WebAuthn on all systems. Windows 11: plugin provider (Microsoft Store/appx distribution). https://bitwarden.com/help/storing-passkeys/ and https://techcommunity.microsoft.com/blog/windows-itpro-blog/windows-11-expands-passkey-manager-support/4467572
- macOS: the desktop app ships a credential provider extension that provides passkeys only; a Feb 2026 community post says it was not selectable as system provider on macOS 26.2. https://github.com/orgs/bitwarden/discussions/21537 and https://community.bitwarden.com/t/register-as-macos-password-and-passkey-provider/93723 . Current state UNCONFIRMED.
- Windows 10: extension only; not explicitly documented: UNCONFIRMED.
- Credential Exchange: import on iOS 26+ and Android 14+. https://bitwarden.com/help/import-data/ and https://bitwarden.com/blog/security-vendors-join-forces-to-make-passkeys-more-portable-for-everyone/ . Export direction and desktop/extension support: UNCONFIRMED.
- Encryption: end-to-end. https://bitwarden.com/help/bitwarden-security-white-paper/
- Hybrid sign-in with a Bitwarden passkey on Windows: https://bitwarden.com/blog/log-into-windows-with-a-bitwarden-passkey/ (the phone uses Bitwarden mobile as authenticator).
- The extension replaces `navigator.credentials.create/get` in the page (`apps/browser/src/autofill/fido2/content/fido2-page-script.ts` in bitwarden/clients). ES256 uses native WebCrypto in the extension. The Rust signing crate in the desktop app: UNCONFIRMED.

### Dashlane (snippet-sourced)
- Extension on Windows 10/11 intercepts WebAuthn (snippet of https://support.dashlane.com/hc/en-us/articles/32831790815506 , not fetchable).
- macOS app and Safari extension need macOS 15 (snippet of https://support.dashlane.com/hc/en-us/articles/39546962448658-Dashlane-on-macOS ). System-wide macOS passkey provider: UNCONFIRMED. Windows 11 plugin: UNCONFIRMED.
- Credential Exchange with Apple Passwords on iOS/macOS 26+, in the app, not the browser extension (snippets of https://support.dashlane.com/hc/en-us/articles/7964813633426-Move-your-data-from-Apple-Passwords-to-Dashlane ). Blog: https://www.dashlane.com/blog/credential-exchange-ios-switching-pwm
- Passkey sync design (whitepaper https://www.dashlane.com/download/whitepaper-en.pdf , text not extracted): UNCONFIRMED. Hybrid on desktop: UNCONFIRMED.

### Proton Pass
- Passkeys in the browser extension and on Android and iOS; desktop apps not listed. https://proton.me/support/pass-use-passkeys
- No Windows 11 plugin (open request, 778 votes): https://protonmail.uservoice.com/forums/953584-proton-pass-authenticator/suggestions/51390739-feature-request-support-fido-credential-exchange . macOS credential provider: UNCONFIRMED.
- Credential Exchange not supported: https://protonmail.uservoice.com/forums/953584-proton-pass-authenticator/suggestions/51122917-support-fido-alliance-passkey-import-export-standa . A "on the roadmap" reply (Oct 2026) was seen only in search: UNCONFIRMED.
- Items use per-item keys with AES-256-GCM (https://proton.me/blog/proton-pass-security-model ); that passkeys are ordinary items is inferred: UNCONFIRMED. Hybrid on desktop: UNCONFIRMED.

### KeePassXC
- Extension only, same on Windows 10/11 and macOS: "Passkeys are only supported with the use of the KeePassXC Browser Extension" (docs/topics/Passkeys.adoc in the keepassxc repo). The extension overwrites `navigator.credentials` (keepassxc-browser, `content/passkeys.js`). Signing uses Botan in the desktop app.
- Third-party, for KeePass (not KeePassXC): https://github.com/yusei36/KeePassPasskey , a Windows 11 24H2+ native provider.
- Credential Exchange not shipped: issue #11363 and PR #13343 (Add support for Credential Exchange Format with passkeys) open, not merged; release 2.8.0 (2026-10-21) has no CXF.
- No built-in sync (https://keepassxc.org/docs/ FAQ). Hybrid on desktop: UNCONFIRMED.

### Google Password Manager (Chrome)
- Built into Chrome on all systems; passkeys created on Windows go to Google Password Manager; macOS Chrome can store to Google Password Manager, iCloud Keychain (macOS 13.5+) or the Chrome profile. https://developers.google.com/identity/passkeys/supported-environments . Windows 10 support: UNCONFIRMED.
- Credential Exchange on Android with Play services (https://www.androidauthority.com/google-password-manager-import-export-support-3673351/ ). Chrome desktop: UNCONFIRMED.
- Synced and end-to-end encrypted (supported-environments page; https://developer.chrome.com/blog/passkeys-gpm-desktop ). Formal whitepaper: UNCONFIRMED.
- Chrome on all platforms supports cross-device (QR) sign-in with an Android or iOS passkey.

### Apple iCloud Passwords on Windows
- Apple's Windows documentation does not mention passkeys, and the Chrome Web Store listing (v3.4.0) does not either. Passkey support on Windows is not confirmed by Apple: treat as unsupported.
- Sources: https://support.apple.com/guide/icloud-windows/icw2babf5e03 , https://support.apple.com/guide/icloud-windows/icw76039ec0f , https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj
- Third-party sources conflict (Corbado says passkeys cannot be accessed on Windows as of January 2025, https://www.corbado.com/blog/how-to-use-apple-passwords ; an older Techlicious piece says otherwise). PassBridge's Proof 1 found no passkey command in Apple's helper protocol.

### Windows 11 plugin providers (context)
Generally available with the November 2025 security update, "starting with 1Password and Bitwarden today and other passkey managers coming soon" (https://techcommunity.microsoft.com/blog/windows-itpro-blog/windows-11-expands-passkey-manager-support/4467572 ). Dashlane, Proton Pass and KeePassXC are not shown as shipped.

## PassBridge passkey store (Windows, opt-in)

- Chrome with `chrome.webAuthenticationProxy` (the API Proof 2 used); other Chromium browsers: UNCONFIRMED.
- Passkeys with an ES256 (P-256) key only. Others are skipped on import.
- Import from an unencrypted Credential Exchange (CXF 1.0) file ([Proof 4](TESTING.md)).
- Only one extension can hold the proxy at a time. If another passkey manager holds it, PassBridge cannot attach.
- Needs the iCloud Passwords vault unlocked; a request waits for the unlock.
