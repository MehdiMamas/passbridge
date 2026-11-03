# Passkeys: testing

## Proof 1: Apple's helper has no passkey operations

Static inspection of Apple's iCloud Passwords extension 3.4.0. See [RESEARCH.md](RESEARCH.md#proof-1-apples-helper-protocol-has-no-passkey-operations).

## Proof 2: webAuthenticationProxy

Question: can an extension answer WebAuthn requests through `chrome.webAuthenticationProxy`, with the browser still checking the origin?

Source: https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy

From the documentation: the API lets remote-desktop software intercept WebAuthn requests; it is available from Chrome 115 and, for MV3 extensions, since Chrome 148; `attach()` fails if a different extension is attached, and regular WebAuthn processing is suspended while attached; request options arrive as a JSON string and the answer is the `PublicKeyCredential.toJSON()` result; a request cannot be completed once canceled.

The documentation says nothing about `clientDataJSON` or the origin. Observed:

- The origin is passed in the request: `extensions.remoteDesktopClientOverride = {"origin": ..., "sameOriginWithAncestors": true}`, for both create and get.
- The extension builds `clientDataJSON` (type, challenge, origin, crossOrigin) and returns it in the response; Chrome passes it through unchanged. The page-side check `origin == location.origin` passed.
- Get options carry `rpId`, `allowCredentials` (with transports), `challenge` and `userVerification`; create options carry `rp`, `user`, `pubKeyCredParams`, `excludeCredentials` and `attestation`.
- `attach()` succeeded with no remote session and no special flag. It works headless, unpacked and as MV3.
- The browser rejects a relying-party ID that does not match the page origin before the extension is called (SecurityError "The relying party ID is not a registrable domain suffix of, nor equal to the current domain"). The extension's own check is defence in depth.

Result: PASS on Chrome for Testing 156.0.8078.4 and 149.0.7827.55 (MV3 needs 148 or newer). One create, then two gets, each verified in the page: ES256 DER signature checked with WebCrypto, signature counter rising (2, then 3). The wrong-RP-ID negative test returned SecurityError.

Meaning: option A is technically possible, but the proxy suspends all native WebAuthn while attached ([SECURITY.md](SECURITY.md)). Nothing from this proof is in PassBridge.

## How slice C is tested

- Unit (`npm run test:unit`): `passkeysView(true)` returns `passkeysHelpWin`, `passkeysView(false)` returns `passkeysHelpMac`, and the link ends with `SETUP.md#passkeys`.
- Browser (`test-harness/automation/drive-options.mjs`, part of `node test-harness/automation/run-all.mjs`): the Browser tab lists the "Passkeys" row after "Hide passkey suggestions", shows the non-Windows text in the Linux test browser, and has a "How it works" button.
- Locale check (`npm test`) requires the new keys in all three locale files.
