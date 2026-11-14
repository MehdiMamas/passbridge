#!/usr/bin/env python3
# stands in for the PassBridge Code Reader app in tests: speaks the one-shot socket protocol with no Apple prompt.
# the scenario is read from $PASSBRIDGE_APPDIR/fake-reader-scenario on every start, so a test can change it between calls.
# all codes here are made-up values.
import json
import os
import socket
import sys
import time

APPDIR = os.environ["PASSBRIDGE_APPDIR"]
START = time.time()


def note(name, text):
    with open(os.path.join(APPDIR, name), "w") as f:
        f.write(text)


def finish(code=0):
    note("fake-reader-exited", "%.3f" % (time.time() - START))
    sys.exit(code)


def main():
    path = sys.argv[sys.argv.index("--socket") + 1]
    note("fake-reader-argv", json.dumps(sys.argv))
    try:
        os.unlink(os.path.join(APPDIR, "fake-reader-exited"))
    except OSError:
        pass
    try:
        with open(os.path.join(APPDIR, "fake-reader-scenario")) as f:
            scenario = f.read().strip()
    except OSError:
        scenario = "ok"
    if scenario == "launch_fails":
        finish(1)
    if scenario == "never_connect":
        time.sleep(12)
        finish(0)
    if scenario == "late_connect":
        time.sleep(2)
    try:
        with open(path + ".nonce") as f:
            nonce = f.read().strip()
        os.unlink(path + ".nonce")
    except OSError:
        finish(1)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(path)
    except OSError:
        finish(1)
    note("fake-reader-connected", "1")

    def send(obj):
        s.sendall(json.dumps(obj).encode() + b"\n")

    send({"nonce": nonce, "state": "started"})
    if scenario in ("ok", "late_connect"):
        send({"nonce": nonce, "ok": True, "code": "482915"})
    elif scenario == "ok_spaced":
        send({"nonce": nonce, "ok": True, "code": "482 915"})
    elif scenario == "wrong_nonce":
        send({"nonce": "0" * 32, "ok": True, "code": "482915"})
    elif scenario == "bad_code":
        send({"nonce": nonce, "ok": True, "code": "12ab56"})
    elif scenario == "malformed":
        s.sendall(b"not json\n")
    elif scenario in ("no_prompt", "several_prompts", "not_configured"):
        send({"nonce": nonce, "ok": False, "error": scenario})
    elif scenario == "permission":
        send({"nonce": nonce, "ok": False, "error": "reader_permission"})
    elif scenario == "crash":
        os._exit(1)
    elif scenario == "hang":
        # wait for the relay to close the socket, as the real reader does (that is its cancel)
        s.settimeout(120)
        try:
            while s.recv(1):
                pass
        except OSError:
            pass
        finish(0)
    s.close()
    finish(0)


main()
