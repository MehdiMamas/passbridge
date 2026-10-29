# Releasing

1. Bump the version in manifest.json, package.json and the lock file, merge, then push the tag `vX.Y.Z`.
2. The Release workflow builds `passbridge.zip`, `passbridge-macos-helper.zip` and `passbridge-windows-helper.zip` and attaches them. Each helper zip holds a `VERSION` file with the release version.
3. Sign all three zips on the maintainer's Mac (the key is in the Keychain), and upload the three `.sig` files to the release:

   ```
   for z in passbridge passbridge-macos-helper passbridge-windows-helper; do
     gh release download vX.Y.Z -p "$z.zip"
     node scripts/sign-release.mjs sign "$z.zip"
     gh release upload vX.Y.Z "$z.zip.sig"
   done
   ```

An unsigned zip is never installed: the extension checks each one against the pinned key and the digest GitHub reports. With "Install updates automatically with the helper" on, running extensions install the extension zip and update the helper from its zip with no click.
