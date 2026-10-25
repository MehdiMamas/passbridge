#!/usr/bin/python3
# update host: the extension verifies a release zip, this swaps it into the unpacked extension folder.
# ops: "status" (is there a folder we can update) and "install" (zip as base64 plus the version expected).
# it never fetches anything and trusts the zip only as far as the checks below.
import base64
import glob
import io
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import zipfile

EXT_ID = "pejdijmoenmkgeppbflobdenhhabjlaj"
APPDIR = os.path.expanduser(os.environ.get("PASSBRIDGE_APPDIR", "~/Library/Application Support/PassBridge"))
SAVED = "updater.json"
SUPPORT = os.path.expanduser("~/Library/Application Support")
# same browsers install.sh registers hosts for
BROWSER_DIRS = [
    "Google/Chrome",
    "Google/Chrome Beta",
    "Google/Chrome Dev",
    "Google/Chrome Canary",
    "Microsoft Edge",
    "Chromium",
    "Arc/User Data",
    "Vivaldi",
    "BraveSoftware/*",
]
UNPACKED = 4  # extensions.settings[id].location for "load unpacked"
MAX_ZIP = 64 * 1024 * 1024


class UpdateError(Exception):
    pass


def manifest_of(folder):
    try:
        with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def our_folder(path, key=None):
    # a folder counts when its manifest carries our key (and the same key as `key` when given)
    m = manifest_of(path)
    if not isinstance(m, dict) or not m.get("key"):
        return False
    return key is None or m["key"] == key


def preference_paths(support=None):
    support = support or SUPPORT
    out = []
    for pattern in BROWSER_DIRS:
        for browser in glob.glob(os.path.join(glob.escape(support), pattern)):
            for name in ("Preferences", "Secure Preferences"):
                out += glob.glob(os.path.join(glob.escape(browser), "*", name))
    return out


def find_folders(support=None):
    """distinct unpacked folders for our id whose manifest carries a key, from every browser profile"""
    found = []
    for prefs in preference_paths(support):
        try:
            with open(prefs, encoding="utf-8") as f:
                data = json.load(f)
            entry = data["extensions"]["settings"][EXT_ID]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not isinstance(entry, dict) or entry.get("location") != UNPACKED or not isinstance(entry.get("path"), str):
            continue
        path = os.path.realpath(entry["path"])
        if os.path.isdir(path) and our_folder(path) and path not in found:
            found.append(path)
    return found


def saved_folder():
    try:
        with open(os.path.join(APPDIR, SAVED), encoding="utf-8") as f:
            path = json.load(f).get("folder")
    except (OSError, ValueError, AttributeError):
        return None
    return path if isinstance(path, str) and os.path.isdir(path) and our_folder(path) else None


def save_folder(path):
    os.makedirs(APPDIR, exist_ok=True)
    with open(os.path.join(APPDIR, SAVED), "w", encoding="utf-8") as f:
        json.dump({"folder": path}, f)


def choose_folder():
    r = subprocess.run(
        ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose the PassBridge folder")'],
        capture_output=True,
        text=True,
        timeout=300,
    )
    path = r.stdout.strip()
    return os.path.realpath(path) if r.returncode == 0 and path else None


def locate(ask=False, support=None, chooser=None):
    """the folder to update, or None. asks with a folder picker only when `ask` and nothing else fits"""
    saved = saved_folder()
    if saved:
        return os.path.realpath(saved)
    found = find_folders(support)
    if len(found) == 1:
        return found[0]
    if not ask:
        return None
    picked = (chooser or choose_folder)()
    picked = os.path.realpath(picked) if picked else None
    if not picked or not os.path.isdir(picked) or not our_folder(picked):
        raise UpdateError("That folder isn't a PassBridge install.")
    save_folder(picked)
    return picked


def safe_extract(zip_bytes, dest):
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise UpdateError("The update isn't a valid zip.")
    root = os.path.realpath(dest)
    with zf:
        infos = zf.infolist()
        for info in infos:
            name = info.filename
            parts = name.replace("\\", "/").split("/")
            if name.startswith(("/", "\\")) or ".." in parts or (len(name) > 1 and name[1] == ":"):
                raise UpdateError("The update has an unsafe path.")
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise UpdateError("The update contains a link.")
            if os.path.commonpath([root, os.path.realpath(os.path.join(root, name))]) != root:
                raise UpdateError("The update has an unsafe path.")
        for info in infos:
            target = os.path.join(root, info.filename)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            if (info.external_attr >> 16) & 0o111:
                os.chmod(target, 0o755)


def swap(folder, zip_bytes, version):
    folder = folder.rstrip("/")
    old_manifest = manifest_of(folder)
    if not old_manifest or not old_manifest.get("key"):
        raise UpdateError("The current folder has no manifest key.")
    tmp = folder + ".passbridge-new"
    old = folder + ".passbridge-old"
    for stale in (tmp, old):
        if os.path.lexists(stale):
            shutil.rmtree(stale, ignore_errors=True)
    os.makedirs(tmp)
    moved = False
    try:
        safe_extract(zip_bytes, tmp)
        new_manifest = manifest_of(tmp)
        if not new_manifest or new_manifest.get("key") != old_manifest["key"]:
            raise UpdateError("The update isn't signed for this install (key differs).")
        if new_manifest.get("version") != version:
            raise UpdateError("The update has a different version than expected.")
        os.rename(folder, old)
        moved = True
        os.rename(tmp, folder)
    except BaseException as exc:
        if moved:
            shutil.rmtree(folder, ignore_errors=True)
            os.rename(old, folder)
        shutil.rmtree(tmp, ignore_errors=True)
        if isinstance(exc, UpdateError):
            raise
        raise UpdateError(f"Install failed: {exc}") from exc
    shutil.rmtree(old, ignore_errors=True)


def handle(msg, support=None, chooser=None):
    op = msg.get("op") if isinstance(msg, dict) else None
    try:
        if op == "status":
            return {"ok": True, "folder": locate(False, support)}
        if op == "install":
            version = msg.get("version")
            if not isinstance(version, str) or not version or not isinstance(msg.get("zip"), str):
                raise UpdateError("Bad request.")
            try:
                data = base64.b64decode(msg["zip"], validate=True)
            except ValueError:
                raise UpdateError("Bad request.")
            if len(data) > MAX_ZIP:
                raise UpdateError("The update is too large.")
            folder = locate(True, support, chooser)
            if not folder:
                raise UpdateError("Couldn't find the PassBridge folder.")
            swap(folder, data, version)
            return {"ok": True, "folder": folder}
        return {"ok": False, "error": "unknown op"}
    except UpdateError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"Update failed: {exc}"}


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    try:
        msg = json.loads(sys.stdin.buffer.read(n))
    except ValueError:
        msg = None
    send(handle(msg))


if __name__ == "__main__":
    main()
