# runs the Python hosts' --selftest modes, then drives the Windows policy host over native messaging.
# the policy checks never write the registry: "set" and "clear" run in-process with the writers stubbed
# to raise Access Denied, so they reach the OPENPASSWORDS_NO_ELEVATE path without a UAC prompt.
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native"
POLICY = NATIVE / "windows" / "passbridge-policy.py"
ORIGIN = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/"
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


def frame(obj):
    raw = json.dumps(obj).encode()
    return struct.pack("<I", len(raw)) + raw


def unframe(raw):
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw[:4])
    return json.loads(raw[4 : 4 + n])


def host(stdin, origin=ORIGIN, env=None):
    proc = subprocess.run(
        [sys.executable, "-I", str(POLICY), origin],
        input=stdin,
        capture_output=True,
        timeout=30,
        env={**os.environ, **(env or {})},
    )
    return proc.returncode, unframe(proc.stdout), proc.stderr.decode(errors="replace")


class Stdio:
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def in_process(module, action):
    # main() with the registry writers locked and subprocess.run forbidden
    def denied():
        raise PermissionError("[WinError 5] Access is denied")

    launched = []

    def no_elevation(args, **kwargs):
        launched.append(args)
        raise AssertionError("the UAC import ran")

    saved = (module._write_dword, module._delete_value, module.subprocess.run, sys.stdin, sys.stdout, sys.argv)
    module._write_dword = denied
    module._delete_value = denied
    module.subprocess.run = no_elevation
    sys.stdin, sys.stdout, sys.argv = Stdio(frame({"action": action})), Stdio(b""), [str(POLICY), ORIGIN]
    try:
        module.main()
        return unframe(sys.stdout.buffer.getvalue()), launched
    finally:
        module._write_dword, module._delete_value, module.subprocess.run, sys.stdin, sys.stdout, sys.argv = saved


for script in [NATIVE / "passbridge-autopair.py", NATIVE / "windows" / "passbridge-autopair.py", NATIVE / "windows" / "passbridge-totpsetup.py"]:
    proc = subprocess.run([sys.executable, "-I", str(script), "--selftest"], capture_output=True, text=True, timeout=60)
    name = script.relative_to(ROOT).as_posix()
    ok(f"{name} --selftest", proc.returncode == 0 and "selftest ok" in proc.stdout, (proc.stdout + proc.stderr).strip()[-300:])

if sys.platform != "win32":
    print("SKIP policy host checks (they need winreg, Windows only)")
else:
    code, msg, err = host(frame({"action": "get"}), origin="chrome-extension://someoneelse/")
    ok("policy host refuses another extension", msg == {"ok": False, "error": "forbidden"}, f"{code} {msg} {err}")

    code, msg, err = host(frame({"action": "nope"}))
    ok("policy host rejects an unknown action", msg == {"ok": False, "error": "unknown action"}, f"{code} {msg} {err}")

    code, msg, err = host(frame({"action": "get"}))
    ok("policy host reports the current state", msg and msg.get("ok") is True and isinstance(msg.get("hidden"), bool), f"{code} {msg} {err}")

    code, msg, err = host(struct.pack("<I", 2_000_000))
    ok("policy host refuses an oversized message", msg == {"ok": False, "error": "message too large"}, f"{code} {msg} {err}")

    code, msg, err = host(b"")
    ok("policy host exits quietly when the browser closes stdin", code == 0 and msg is None and not err, f"{code} {msg} {err}")

    os.environ["OPENPASSWORDS_NO_ELEVATE"] = "1"
    spec = importlib.util.spec_from_file_location("passbridge_policy", POLICY)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    for action in ["set", "clear"]:
        try:
            msg, launched = in_process(policy, action)
        except BaseException as exc:
            msg, launched = f"crashed: {exc!r}", ["?"]
        ok(
            f"locked policy key + OPENPASSWORDS_NO_ELEVATE: '{action}' returns an error, no UAC prompt",
            isinstance(msg, dict) and msg.get("ok") is False and "locked" in msg.get("error", "") and not launched,
            f"{msg} launched={launched}",
        )

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)
