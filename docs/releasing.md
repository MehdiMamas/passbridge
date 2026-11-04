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

   Over ssh the login Keychain refuses access ("User interaction is not allowed", exit 36). Run the signing as a one-shot LaunchAgent in the logged-in GUI session instead: write a plist whose `ProgramArguments` run the `sign-release.mjs sign` loop on zips copied to the Mac, then `launchctl bootstrap gui/$(id -u) <plist>`, wait for it to finish, `launchctl bootout gui/$(id -u)/<label>`, and copy the `.sig` files back. This needs no password and opens no window.

4. Smoke test on Windows before publishing. On a Windows PC with iCloud for Windows signed in, download the draft's `passbridge.zip` and `passbridge-windows-helper.zip`, install the helper from its zip, and load the extension unpacked from `chrome://extensions`. Then:
   - unlock with a verification code (a wrong code first should say "Incorrect code"),
   - fill one saved login on a sign-in page,
   - read one verification (TOTP) code. iCloud for Windows currently returns no codes to the helper, so record this step as N/A until that changes.

   Record PASS or FAIL for each step in a comment on the release issue. Publish only when no step fails.
5. The workflow leaves the release as a draft, so nobody is offered it unsigned. Publish it once the three `.sig` files are on it: `gh release edit vX.Y.Z --draft=false --latest`. `releases/latest` only shows it after that.

An unsigned zip is never installed: the extension checks each one against the pinned key and the digest GitHub reports. With "Install updates automatically with the helper" on, running extensions install the extension zip and update the helper from its zip with no click.
