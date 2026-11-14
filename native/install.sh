#!/bin/sh
# macOS only, run once after cloning
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="pejdijmoenmkgeppbflobdenhhabjlaj" # the ID our manifest key forces
SUPPORT="$HOME/Library/Application Support"

# without the Command Line Tools /usr/bin/python3 is only a stub that offers to install them
if ! xcode-select -p >/dev/null 2>&1; then
  echo "The helper runs on /usr/bin/python3, which needs the Xcode Command Line Tools."
  echo "Run: xcode-select --install"
  echo "Then run this script again."
  exit 1
fi

# outside the repo so moving it wont break the host path, and out of ~/Downloads where TCC can block the browser launching it
APPDIR="$SUPPORT/PassBridge"
mkdir -p "$APPDIR"
cp "$DIR/passbridge-policy.py" "$APPDIR/passbridge-policy.py"
chmod +x "$APPDIR/passbridge-policy.py"
HELPER="$APPDIR/passbridge-policy.py"
# agent sign-in host and its command-line client
cp "$DIR/passbridge-agent.py" "$APPDIR/passbridge-agent.py"
cp "$DIR/passbridge-agent-cli.py" "$APPDIR/passbridge-agent-cli.py"
chmod +x "$APPDIR/passbridge-agent.py" "$APPDIR/passbridge-agent-cli.py"
AGENT="$APPDIR/passbridge-agent.py"
# one-click update host
cp "$DIR/passbridge-updater.py" "$APPDIR/passbridge-updater.py"
chmod +x "$APPDIR/passbridge-updater.py"
UPDATER="$APPDIR/passbridge-updater.py"
# the release zip says which version this is, so the extension knows when the helper is behind
if [ -f "$DIR/VERSION" ]; then cp "$DIR/VERSION" "$APPDIR/helper-version"; fi

# verification code reader: the signed app from a release zip, else an ad-hoc build from source
READER="$APPDIR/PassBridge Code Reader.app"
if [ -f "$DIR/code-reader.zip" ]; then
  ZIP_SHA="$(shasum -a 256 "$DIR/code-reader.zip" | cut -d' ' -f1)"
  if [ "$ZIP_SHA" != "$(cat "$APPDIR/code-reader.sha" 2>/dev/null)" ] || [ ! -d "$READER" ]; then
    rm -rf "$READER"
    ditto -x -k "$DIR/code-reader.zip" "$APPDIR"
    xattr -dr com.apple.quarantine "$READER" 2>/dev/null || true
    echo "$ZIP_SHA" > "$APPDIR/code-reader.sha"
    echo "Code reader installed"
  else
    echo "Code reader up to date"
  fi
elif [ -f "$DIR/code-reader/main.swift" ] && command -v swiftc >/dev/null 2>&1; then
  SRC_SHA="$(cat "$DIR/code-reader/main.swift" "$DIR/code-reader/prompt.json" "$DIR/code-reader/Info.plist" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$SRC_SHA" != "$(cat "$APPDIR/code-reader.src-sha" 2>/dev/null)" ] || [ ! -d "$READER" ]; then
    sh "$DIR/code-reader/build.sh" "$APPDIR"
    echo "$SRC_SHA" > "$APPDIR/code-reader.src-sha"
    echo "Code reader built from source (ad-hoc). Grant it Accessibility access again after each rebuild."
  else
    echo "Code reader up to date"
  fi
else
  echo "Code reader not included: install a release helper zip to use verification codes"
fi

# the pairing-code reader earlier versions installed
rm -rf "$APPDIR/passbridge-autopair.py" "$APPDIR/PassBridge Helper.app"

found=0
register() {
  d="$1/NativeMessagingHosts"
  mkdir -p "$d"
  cat > "$d/com.passbridge.policy.json" <<EOF
{
  "name": "com.passbridge.policy",
  "description": "PassBridge policy helper",
  "path": "$HELPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  cat > "$d/com.passbridge.agent.json" <<EOF
{
  "name": "com.passbridge.agent",
  "description": "PassBridge agent sign-in host",
  "path": "$AGENT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  cat > "$d/com.passbridge.updater.json" <<EOF
{
  "name": "com.passbridge.updater",
  "description": "PassBridge update host",
  "path": "$UPDATER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  rm -f "$d/com.passbridge.autopair.json" "$d/com.openpasswords.policy.json" "$d/com.openpasswords.autopair.json"
  echo "  registered: $(basename "$1")"
  found=$((found + 1))
}

for b in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Microsoft Edge" "Chromium" "Arc/User Data" "Vivaldi"; do
  [ -d "$SUPPORT/$b" ] && register "$SUPPORT/$b"
done
for d in "$SUPPORT/BraveSoftware/"*/; do
  [ -d "$d" ] && register "${d%/}"
done

echo
echo "Helper installed to $HELPER ($found browser(s))"
echo "Now FULLY QUIT and reopen your browser (Cmd+Q), then use the toggle in PassBridge settings."
