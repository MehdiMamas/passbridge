# the CLI under WSL re-runs itself through the Windows Python: a stub py.exe on PATH records its argv and stdin,
# and a fake osrelease file stands in for /proc/sys/kernel/osrelease. a stub wslpath maps the script path.
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "native" / "passbridge-agent-cli.py"
TMP = Path(tempfile.mkdtemp(prefix="pb-wsl-"))
BIN = TMP / "bin"
BIN.mkdir()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


def stub(name, body):
    p = BIN / name
    p.write_text("#!/bin/sh\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)


stub("wslpath", "printf '%s\\n' 'C:\\wsl\\cli.py'\n")
stub("py.exe", "printf '%s\\n' \"$@\" > \"" + str(TMP) + "/argv\"\ncat > \"" + str(TMP) + "/stdin\"\necho '{\"ok\":true,\"username\":\"u@x.com\"}'\n")
(TMP / "osr-wsl").write_text("5.15.153.1-microsoft-standard-WSL2\n")
(TMP / "osr-linux").write_text("6.8.0-generic\n")
env = {**os.environ, "PATH": f"{BIN}{os.pathsep}{os.environ['PATH']}", "PASSBRIDGE_APPDIR": str(TMP / "none")}
env.pop("PASSBRIDGE_NO_WSL_REEXEC", None)


def cli(osr, *args, stdin="", extra=None):
    e = {**env, "PASSBRIDGE_OSRELEASE": str(TMP / osr), **(extra or {})}
    return subprocess.run([sys.executable, "-I", str(CLI), *args], input=stdin, capture_output=True, text=True, env=e, timeout=30)


r = cli("osr-wsl", "save", "7", "u@x.com", stdin="Sup3r-secret\n")
ok("wsl: save re-runs through py.exe and returns its exit code", r.returncode == 0 and json.loads(r.stdout)["ok"] is True, r.stdout + r.stderr)
argv = (TMP / "argv").read_text().splitlines()
ok("wsl: py.exe gets -3, the Windows script path and the same arguments", argv == ["-3", "C:\\wsl\\cli.py", "save", "7", "u@x.com"], argv)
ok("wsl: the password is on stdin, never in argv", (TMP / "stdin").read_text() == "Sup3r-secret\n" and "Sup3r-secret" not in " ".join(argv))

(TMP / "argv").unlink()
r = cli("osr-wsl", "status")
ok("wsl: status goes through Windows too", r.returncode == 0 and (TMP / "argv").read_text().splitlines()[-1] == "status", r.stderr)

(TMP / "argv").unlink()
r = cli("osr-linux", "status")
ok("not wsl: no re-exec", not (TMP / "argv").exists() and json.loads(r.stdout)["error"] == "no_host", r.stdout + r.stderr)

r = cli("osr-wsl", "status", extra={"PASSBRIDGE_NO_WSL_REEXEC": "1"})
ok("PASSBRIDGE_NO_WSL_REEXEC=1 turns the re-exec off", not (TMP / "argv").exists() and json.loads(r.stdout)["error"] == "no_host", r.stdout + r.stderr)

r = cli("osr-linux", "save", "7", "u@x.com", stdin="")
ok("save with an empty stdin is refused", r.returncode == 2, r.stderr)
r = cli("osr-linux", "save", "7")
ok("save without a username is refused", r.returncode == 2, r.stderr)

shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if all(results) else 1)
