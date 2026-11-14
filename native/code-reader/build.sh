#!/bin/sh
# usage: build.sh <outDir> [signing identity]. With an identity: universal, hardened runtime, timestamped.
# Without one: the host architecture only, ad-hoc signed.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"
IDENTITY="$2"
[ -n "$OUT" ] || { echo "usage: build.sh <outDir> [identity]" >&2; exit 2; }
APP="$OUT/PassBridge Code Reader.app"
BIN="passbridge-code-reader"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "$IDENTITY" ]; then
  swiftc -O -target arm64-apple-macos13 -o "$WORK/arm64" "$DIR/main.swift"
  swiftc -O -target x86_64-apple-macos13 -o "$WORK/x86_64" "$DIR/main.swift"
  lipo -create "$WORK/arm64" "$WORK/x86_64" -output "$WORK/$BIN"
else
  swiftc -O -o "$WORK/$BIN" "$DIR/main.swift"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
VERSION="$(cat "$DIR/../VERSION" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/../../package.json" | head -1)"
[ -n "$VERSION" ] && /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
cp "$WORK/$BIN" "$APP/Contents/MacOS/$BIN"
cp "$DIR/prompt.json" "$APP/Contents/Resources/prompt.json"

if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp --identifier com.passbridge.codereader -s "$IDENTITY" "$APP"
else
  codesign --force --identifier com.passbridge.codereader -s - "$APP"
fi
echo "Built $APP"
