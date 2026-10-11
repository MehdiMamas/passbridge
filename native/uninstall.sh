#!/bin/sh
# macOS only
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support"
PROFILE_ID="com.passbridge.hidepm"
PROFILE_NAME="PassBridge - Hide Browser Password Manager"

for d in "$SUPPORT/Google/Chrome"* "$SUPPORT/Microsoft Edge" "$SUPPORT/Chromium" "$SUPPORT/Arc/User Data" "$SUPPORT/Vivaldi" "$SUPPORT/BraveSoftware/"*/; do
  rm -f "${d%/}/NativeMessagingHosts/com.passbridge.policy.json" 2>/dev/null || true
  rm -f "${d%/}/NativeMessagingHosts/com.passbridge.autopair.json" 2>/dev/null || true
  rm -f "${d%/}/NativeMessagingHosts/com.openpasswords.policy.json" 2>/dev/null || true
  rm -f "${d%/}/NativeMessagingHosts/com.openpasswords.autopair.json" 2>/dev/null || true
done

# nothing writes these any more; a plain defaults key is not a forced policy, so this is only cleanup
for bundle in com.brave.Browser com.brave.Browser.origin com.brave.Browser.beta com.brave.Browser.nightly com.brave.Browser.dev com.google.Chrome com.google.Chrome.beta com.google.Chrome.dev com.google.Chrome.canary com.microsoft.Edge org.chromium.Chromium company.thebrowser.Browser com.vivaldi.Vivaldi; do
  defaults delete "$bundle" PasswordManagerEnabled 2>/dev/null || true
done

# the settings toggle turns the password manager off with a configuration profile, so only removing it brings it back
pm_forced() {
  if xcode-select -p >/dev/null 2>&1; then
    # asks CFPreferences, the same check the browsers make: 0 forced, 3 not forced, anything else unknown
    rc=0
    /usr/bin/python3 "$DIR/passbridge-policy.py" --forced || rc=$?
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 3 ] && return 1
  fi
  profiles list 2>/dev/null | grep -q "$PROFILE_ID"
}

if pm_forced; then
  profiles remove -identifier "$PROFILE_ID" >/dev/null 2>&1 || true
fi
if pm_forced; then
  open "x-apple.systempreferences:com.apple.preferences.configurationprofiles" 2>/dev/null || true
  echo "The \"$PROFILE_NAME\" profile is still installed."
  echo "In System Settings > General > Device Management, select it and click the minus button."
  if [ -t 0 ]; then
    printf "Press Return once it is removed... "
    read -r _ || true
  fi
fi

rm -rf "$SUPPORT/PassBridge"

if pm_forced; then
  echo "Removed the helper, but the \"$PROFILE_NAME\" profile is still installed, so the browser password manager stays off."
  echo "Remove it in System Settings > General > Device Management, then restart your browser."
  exit 1
fi
echo "Removed the helper and restored the browser password manager. Restart your browser."
