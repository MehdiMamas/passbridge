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


class Relay:
    # one relay process plus its fake stdio "extension": answers each forwarded request, records events
    def __init__(self, name):
        self.name = name
        self.events = []
        self.proc = subprocess.Popen([sys.executable, "-I", str(RELAY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while True:
            raw = self.proc.stdout.read(4)
            if len(raw) < 4:
                return
            (n,) = struct.unpack("<I", raw)
            req = json.loads(self.proc.stdout.read(n))
            if "id" not in req:
                self.events.append(req.get("event"))
                continue
            reply = {"id": req["id"], "ok": True, "op": req["op"], "tabId": req.get("tabId"), "by": self.name}
            b = json.dumps(reply).encode()
            self.proc.stdin.write(struct.pack("<I", len(b)) + b)
            self.proc.stdin.flush()

    def wait_event(self, event, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if event in self.events:
                return True
            time.sleep(0.1)
        return False


relay = Relay("A")


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
ok("the first relay answers", reply.get("by") == "A", reply)
relayB = Relay("B")
ok("a second relay reports standby", relayB.wait_event("standby", 10), relayB.events)
reply, code = cli("status")
ok("with two relays the first one still answers", reply.get("by") == "A", reply)
relay.proc.stdin.close()
relay.proc.wait(timeout=10)
ok("the second relay takes over within 10 s", relayB.wait_event("active", 10), relayB.events)
reply = None
for _ in range(50):
    reply, code = cli("status")
    if reply.get("ok"):
        break
    time.sleep(0.2)
ok("after the first relay exits the second one answers", reply.get("by") == "B", reply)
relay = relayB
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

relay.proc.stdin.close()
try:
    relay.proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    relay.proc.kill()
    ok("relay exits when the extension goes away", False)
else:
    ok("relay exits when the extension goes away", True)

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)
