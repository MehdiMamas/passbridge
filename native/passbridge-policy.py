#!/usr/bin/python3
# a plain defaults write is not a forced policy on macOS, so this builds a config profile the user approves once in System Settings
import ctypes
import json
import os
import struct
import subprocess
import sys
import uuid

BUNDLES = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.brave.Browser",
    "com.brave.Browser.origin",
    "com.brave.Browser.beta",
    "com.brave.Browser.nightly",
    "com.brave.Browser.dev",
    "com.microsoft.Edge",
    "org.chromium.Chromium",
    "company.thebrowser.Browser",
    "com.vivaldi.Vivaldi",
]
# PasswordManagerEnabled only reaches the offer to save. Chromium fills a saved password through a
# separate gate that reads PasswordManagerBlocklist alone, and that list is the one that takes a URL
# out of both workflows. "*" is the wildcard filter, so the profile covers every site.
KEY = "PasswordManagerEnabled"
BLOCK = "PasswordManagerBlocklist"
BLOCK_ALL = ["*"]
APPDIR = os.path.expanduser("~/Library/Application Support/PassBridge")
PROFILE = os.path.join(APPDIR, "PassBridge-HidePasswordManager.mobileconfig")

_CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_CF.CFStringCreateWithCString.restype = ctypes.c_void_p
_CF.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
_CF.CFPreferencesAppValueIsForced.restype = ctypes.c_bool
_CF.CFPreferencesAppValueIsForced.argtypes = [ctypes.c_void_p, ctypes.c_void_p]


def _cfstr(x):
    return _CF.CFStringCreateWithCString(None, x.encode(), 0x08000100)


def forced(keys):
    """true when a managed profile forces every key in keys for at least one browser"""
    wanted = [_cfstr(k) for k in keys]
    return any(all(_CF.CFPreferencesAppValueIsForced(k, _cfstr(b)) for k in wanted) for b in BUNDLES)


def is_hidden():
    # the switch promises both halves: no save prompt and no filling. One key alone is a profile an
    # older build installed, and reporting that as on is what hid this bug.
    return forced((KEY, BLOCK))


def is_engaged():
    # uninstall.sh asks this: anything still forced means the browser is not fully restored yet
    return forced((KEY,)) or forced((BLOCK,))


def write_profile():
    import plistlib

    payloads = []
    for b in BUNDLES:
        payloads.append(
            {
                "PayloadType": b,
                "PayloadIdentifier": "com.passbridge.hidepm." + b,
                "PayloadUUID": str(uuid.uuid4()).upper(),
                "PayloadEnabled": True,
                "PayloadVersion": 1,
                KEY: False,
                BLOCK: BLOCK_ALL,
            }
        )
    profile = {
        "PayloadType": "Configuration",
        "PayloadDisplayName": "PassBridge - Hide Browser Password Manager",
        "PayloadDescription": "Stops Chromium browsers saving or filling passwords themselves.",
        "PayloadIdentifier": "com.passbridge.hidepm",
        "PayloadUUID": "1D8B2E90-0000-4000-A000-4F70656E5057",
        "PayloadVersion": 1,
        "PayloadRemovalDisallowed": False,
        "PayloadContent": payloads,
    }
    os.makedirs(APPDIR, exist_ok=True)
    with open(PROFILE, "wb") as f:
        plistlib.dump(profile, f)


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    action = json.loads(sys.stdin.buffer.read(n)).get("action")

    if action == "set":
        write_profile()
        subprocess.run(["open", PROFILE])
        send({"ok": True, "hidden": is_hidden(), "needsApproval": not is_hidden()})
    elif action == "clear":
        # profiles can only be removed by the user in System Settings
        subprocess.run(["open", "x-apple.systempreferences:com.apple.preferences.configurationprofiles"])
        send({"ok": True, "hidden": is_hidden()})
    elif action == "get":
        send({"ok": True, "hidden": is_hidden()})
    else:
        send({"ok": False, "error": "unknown action"})


if __name__ == "__main__":
    # uninstall.sh asks this before it says the password manager is back
    if sys.argv[1:] == ["--forced"]:
        sys.exit(0 if is_engaged() else 3)
    main()
