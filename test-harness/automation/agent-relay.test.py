# round trip through the real agent relay: a fake stdio "extension" answers each forwarded request,
# the real CLI sends requests. macOS uses the unix socket, Windows the named pipe; on Windows a client
# with the wrong key must be refused.
import getpass
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RELAY = ROOT / "native" / "passbridge-agent.py"
CLI = ROOT / "native" / "passbridge-agent-cli.py"
WINDOWS = os.name == "nt"
TMP = tempfile.mkdtemp(prefix="pb-agent-")
ENV = {**os.environ, "PASSBRIDGE_APPDIR": TMP}
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


relay = subprocess.Popen([sys.executable, "-I", str(RELAY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)


def fake_extension():
    while True:
        raw = relay.stdout.read(4)
        if len(raw) < 4:
            return
        (n,) = struct.unpack("<I", raw)
        req = json.loads(relay.stdout.read(n))
        reply = {"id": req["id"], "ok": True, "op": req["op"], "tabId": req.get("tabId")}
        b = json.dumps(reply).encode()
        relay.stdin.write(struct.pack("<I", len(b)) + b)
        relay.stdin.flush()


threading.Thread(target=fake_extension, daemon=True).start()


def cli(*args):
    r = subprocess.run([sys.executable, "-I", str(CLI), *args], capture_output=True, text=True, env=ENV, timeout=30)
    try:
        return json.loads(r.stdout), r.returncode
    except ValueError:
        return {"raw": r.stdout, "err": r.stderr}, r.returncode


reply, code = None, None
for _ in range(50):  # the relay needs a moment to start listening
    reply, code = cli("status")
    if reply.get("error") != "no_host":
        break
    time.sleep(0.2)
ok("status reaches the extension and the reply comes back", code == 0 and reply.get("ok") and reply.get("op") == "status", reply)
reply, code = cli("sign_in", "7", "octocat")
ok("sign_in carries tabId through", code == 0 and reply.get("tabId") == 7 and reply.get("op") == "sign_in", reply)
reply, code = cli("logins", "x")
ok("a non-numeric tabId is refused by the CLI", code == 2)

if WINDOWS:
    from multiprocessing import AuthenticationError
    from multiprocessing.connection import Client

    pipe = r"\\.\pipe\passbridge-agent-" + getpass.getuser()
    refused = False
    try:
        Client(pipe, family="AF_PIPE", authkey=b"x" * 32).close()
    except (AuthenticationError, OSError, EOFError):
        refused = True
    ok("a client with the wrong key is refused", refused)
    reply, code = cli("status")
    ok("the right key still works after a refused client", code == 0 and reply.get("ok"), reply)
    ok("the key file is 32 bytes", os.path.getsize(os.path.join(TMP, "agent.key")) == 32)
else:
    print("SKIP wrong-key check (macOS uses a 0600 socket, no key)")
    ok("the socket is user-only", (os.stat(os.path.join(TMP, "agent.sock")).st_mode & 0o777) == 0o600)

relay.stdin.close()
try:
    relay.wait(timeout=10)
except subprocess.TimeoutExpired:
    relay.kill()
    ok("relay exits when the extension goes away", False)
else:
    ok("relay exits when the extension goes away", True)

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)
