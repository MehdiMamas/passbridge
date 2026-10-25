# the macOS update host: zip checks, folder swap with rollback, and folder lookup in a fake browser tree
import base64
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "native" / "passbridge-updater.py"
TMP = tempfile.mkdtemp(prefix="pb-updater-")
os.environ["PASSBRIDGE_APPDIR"] = os.path.join(TMP, "app")
spec = importlib.util.spec_from_file_location("updater", HOST)
up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(up)
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


def forget():
    try:
        os.remove(os.path.join(TMP, "app", "updater.json"))
    except OSError:
        pass


def make_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for item in entries:
            if isinstance(item, zipfile.ZipInfo):
                z.writestr(item, "target")
            else:
                z.writestr(item[0], item[1])
    return buf.getvalue()


def manifest(version, key="KEY"):
    return json.dumps({"version": version, "key": key})


def install_dir(name, version="1.0.0", key="KEY"):
    d = Path(TMP) / name
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(manifest(version, key))
    (d / "old.txt").write_text("old")
    return d


def req(zip_bytes, version):
    return {"op": "install", "zip": base64.b64encode(zip_bytes).decode(), "version": version}


def run(folder, zip_bytes, version):
    forget()
    # an injected chooser stands in for the osascript picker
    return up.handle(req(zip_bytes, version), support=os.path.join(TMP, "nobrowsers"), chooser=lambda: str(folder))


good = make_zip([("manifest.json", manifest("2.0.0")), ("src/a.js", "new")])

# good install
d = install_dir("good")
r = run(d, good, "2.0.0")
ok("install: a good zip replaces the folder", r.get("ok") and (d / "src/a.js").exists() and not (d / "old.txt").exists(), r)
ok("install: no old or temp folder is left", not os.path.exists(str(d) + ".passbridge-old") and not os.path.exists(str(d) + ".passbridge-new"))
saved = os.path.join(TMP, "app", "updater.json")
ok("install: the picked folder is remembered", os.path.exists(saved) and json.load(open(saved))["folder"] == os.path.realpath(d), (r, os.path.exists(saved)))

# zip-slip, absolute, symlink
for label, z in {
    "zip-slip (..)": make_zip([("manifest.json", manifest("2.0.0")), ("../evil.txt", "x")]),
    "absolute path": make_zip([("manifest.json", manifest("2.0.0")), ("/tmp/pb-evil.txt", "x")]),
}.items():
    d = install_dir("bad-" + label.split()[0])
    r = run(d, z, "2.0.0")
    ok(f"install: {label} is refused and the folder is untouched", not r["ok"] and (d / "old.txt").exists() and not (Path(TMP) / "evil.txt").exists(), r)
link = zipfile.ZipInfo("src/link")
link.external_attr = (0o120777 << 16)
d = install_dir("bad-symlink")
r = run(d, make_zip([("manifest.json", manifest("2.0.0")), link]), "2.0.0")
ok("install: a symlink entry is refused and the folder is untouched", not r["ok"] and (d / "old.txt").exists(), r)

# wrong key, wrong version
d = install_dir("wrongkey")
r = run(d, make_zip([("manifest.json", manifest("2.0.0", "OTHER"))]), "2.0.0")
ok("install: a different manifest key is refused", not r["ok"] and "key" in r["error"] and (d / "old.txt").exists(), r)
d = install_dir("wrongver")
r = run(d, good, "3.0.0")
ok("install: a different version is refused", not r["ok"] and "version" in r["error"] and (d / "old.txt").exists(), r)
d = install_dir("notzip")
r = up.handle(req(b"not a zip", "2.0.0"), support=TMP, chooser=lambda: str(d))
ok("install: a non-zip is refused", not r["ok"] and (d / "old.txt").exists(), r)

# rollback when the final rename fails
d = install_dir("rollback")
real_rename = os.rename
calls = []


def flaky(a, b, *args, **kw):
    calls.append((a, b))
    if len(calls) == 2:
        raise OSError("disk says no")
    return real_rename(a, b, *args, **kw)


up.os.rename = flaky
try:
    r = run(d, good, "2.0.0")
finally:
    up.os.rename = real_rename
ok("install: a failed swap puts the old folder back", not r["ok"] and (d / "old.txt").exists() and (d / "manifest.json").exists(), r)
ok("install: rollback leaves no temp folder", not os.path.exists(str(d) + ".passbridge-new") and not os.path.exists(str(d) + ".passbridge-old"))

# folder lookup in a fake Support tree
support = Path(TMP) / "support"


def profile(browser, profile_name, ext_path, location=4, file="Preferences", ext_id=up.EXT_ID):
    p = support / browser / profile_name
    p.mkdir(parents=True, exist_ok=True)
    (p / file).write_text(json.dumps({"extensions": {"settings": {ext_id: {"path": str(ext_path), "location": location}}}}))


a = install_dir("ext-a")
b = install_dir("ext-b")
nokey = Path(TMP) / "ext-nokey"
nokey.mkdir()
(nokey / "manifest.json").write_text(json.dumps({"version": "1"}))
profile("Google/Chrome", "Default", a)
profile("Google/Chrome", "Profile 1", a, file="Secure Preferences")
ok("lookup: the same folder in two profiles is one folder", up.find_folders(str(support)) == [os.path.realpath(a)], up.find_folders(str(support)))
profile("BraveSoftware/Brave-Browser", "Default", b)
ok("lookup: two different folders are both listed", sorted(up.find_folders(str(support))) == sorted([os.path.realpath(a), os.path.realpath(b)]))
forget()
ok("lookup: status with two folders and no saved one finds none", up.handle({"op": "status"}, support=str(support))["folder"] is None)
forget()
profile("BraveSoftware/Brave-Browser", "Default", b, location=1)
ok("lookup: a non-unpacked entry is ignored", up.find_folders(str(support)) == [os.path.realpath(a)])
profile("Microsoft Edge", "Default", a, ext_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
profile("Vivaldi", "Default", nokey)
ok("lookup: other ids and folders without our key are ignored", up.find_folders(str(support)) == [os.path.realpath(a)])
ok("lookup: status returns the single folder", up.handle({"op": "status"}, support=str(support)) == {"ok": True, "folder": os.path.realpath(a)})
r = up.handle(req(good, "2.0.0"), support=str(support), chooser=lambda: (_ for _ in ()).throw(AssertionError("asked")))
ok("lookup: a single folder installs without asking", r.get("ok") and (a / "src/a.js").exists(), r)
try:
    up.locate(True, str(Path(TMP) / "empty"), chooser=lambda: str(nokey))
    ok("lookup: a picked folder without our key is refused", False)
except up.UpdateError:
    ok("lookup: a picked folder without our key is refused", True)

# framing over stdio
msg = json.dumps({"op": "status"}).encode()
p = subprocess.run([sys.executable, "-I", str(HOST)], input=struct.pack("<I", len(msg)) + msg, capture_output=True, timeout=30,
                   env={**os.environ, "PASSBRIDGE_APPDIR": os.path.join(TMP, "none")})
(n,) = struct.unpack("<I", p.stdout[:4])
ok("stdio: a status message gets one framed reply", json.loads(p.stdout[4 : 4 + n]).get("ok") is True, p.stdout[:80])

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)
