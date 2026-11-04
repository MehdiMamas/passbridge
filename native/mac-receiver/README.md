# PassBridge Receiver (Proof 5)

A macOS app plus credential provider extension that receives a Credential Exchange
export from Apple's Passwords app and logs only a summary: for each passkey the rpId
and key type (EC P-256 or other, key length in bytes), plus counts of passwords and
other items. No key bytes, credential ids, user handles, usernames or passwords are
logged or written. Output goes to `os_log` (subsystem `passbridge.receiver`) and to
`receiver-log.txt` in the app container.

## Build

Needs Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
cd native/mac-receiver
cp Local.xcconfig.example Local.xcconfig   # set DEVELOPMENT_TEAM (gitignored)
xcodegen generate
xcodebuild -scheme PassBridgeReceiver -allowProvisioningUpdates build
xcodebuild -scheme PassBridgeReceiver -allowProvisioningUpdates test
```

## Install

```sh
cp -R <DerivedData build products>/PassBridgeReceiver.app ~/Applications/
open ~/Applications/PassBridgeReceiver.app
pluginkit -e use -i com.passbridge.receiver.extension
pluginkit -m -i com.passbridge.receiver.extension   # a leading + means enabled
```

## Info.plist keys (source)

In the extension's `NSExtension > NSExtensionAttributes > ASCredentialProviderExtensionCapabilities`:

- `SupportsCredentialExchange` = `YES`
- `SupportedCredentialExchangeVersions` = `["1.0"]`
- `ProvidesPasskeys` = `YES`

In the app's Info.plist: `NSUserActivityTypes` = `[ASCredentialExchangeActivity]`.

Source: Apple documentation for `ASCredentialImportManager`
(https://developer.apple.com/documentation/authenticationservices/ascredentialimportmanager,
JSON at https://developer.apple.com/tutorials/data/documentation/authenticationservices/ascredentialimportmanager.json),
which names `NSExtension > NSExtensionAttributes > ASCredentialProviderExtensionCapabilities > SupportsCredentialExchange`
(Boolean YES) and `...> SupportedCredentialExchangeVersions` (array of strings, currently `1.0`).
`ProvidesPasskeys` is from `ASCredentialProviderViewController.h` in the SDK.
The literal value of the `ASCredentialExchangeActivity` constant is the string `ASCredentialExchangeActivity`.
