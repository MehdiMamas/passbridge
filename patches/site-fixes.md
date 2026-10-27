# Site fixes

These are the PassBridge rules that stay on top of the vendored Bitwarden qualification files. They live in `src/content.js` because that file is what the harness proves out. When a Bitwarden sync changes field detection, re-check each row here before deleting it.

| Site / case | Rule | Where |
|---|---|---|
| Snapchat login | Username is labeled only by `<label>` / `aria-labelledby` | `attrBlob` |
| Wells Fargo, Nintendo | `autocomplete="webauthn"` is a username | `hasStrongIdentitySignal` |
| Wells Fargo | `autocomplete="off"` does not hide a field that sits next to a password | `isLoginField` |
| Show-password toggle | A field that was `type=password` stays a password after it flips to text | `everPassword` |
| Spotify OTP | A row of `autocomplete=one-time-code` boxes is a split code even with no `maxlength` | `otpBoxGroup` |
| Nintendo | "E-mail address" is not a street address | `hasStrongIdentitySignal` before `NONLOGIN_HINT` |
| Banks and IdP iframes | Offer inside an iframe only for the allowlist or the same origin | `IFRAME_LOGIN_ALLOWLIST`, `frameIsSafe` |
| Okta (Labcorp) | A `type=password` field labelled "Password" is a password even when named `credentials.passcode` | `isOtpField` |
| Reset forms | The repeated new password wins over "last password field" | `collectSubmittedCredentials` |

Bitwarden behaviors we adopted around those rules: closed-shadow menu host, top-layer popover, in-field icon, 20ms fill pacing, native value setter plus key/input/change events, sandboxed-iframe refusal, save bar, context menu, badge, Ctrl/Cmd+Shift+L cycling.
