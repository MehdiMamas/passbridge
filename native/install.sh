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
