#!/usr/bin/python3
# usage: passbridge-agent-cli.py status | logins <tabId> | sign_in <tabId> [username]
import getpass
import json
import os
import socket
import sys
import uuid

WINDOWS = os.name == "nt"
if WINDOWS:
    _default = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "PassBridge")
else:
    _default = "~/Library/Application Support/PassBridge"
APPDIR = os.path.expanduser(os.environ.get("PASSBRIDGE_APPDIR", _default))
SOCK = os.path.join(APPDIR, "agent.sock")
KEYFILE = os.path.join(APPDIR, "agent.key")
PIPE = r"\\.\pipe\passbridge-agent-" + getpass.getuser()


def ask_pipe(req):
    # send_bytes/recv_bytes only, never send()/recv() (pickle)
    from multiprocessing.connection import Client

    try:
        with open(KEYFILE, "rb") as f:
            key = f.read()
        conn = Client(PIPE, family="AF_PIPE", authkey=key)
    except Exception:
        return None
    with conn:
        conn.send_bytes(json.dumps(req).encode())
        try:
            return conn.recv_bytes()
        except (EOFError, OSError):
            return b""


def ask_socket(req):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(100)
    try:
        s.connect(SOCK)
    except OSError:
        return None
    s.sendall(json.dumps(req).encode() + b"\n")
    return s.makefile("rb").readline()


def main(argv):
    if not argv or argv[0] not in ("status", "logins", "sign_in"):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    req = {"id": uuid.uuid4().hex, "op": argv[0]}
    if argv[0] != "status":
        if len(argv) < 2 or not argv[1].isdigit():
            print("tabId must be a number", file=sys.stderr)
            return 2
        req["tabId"] = int(argv[1])
    if argv[0] == "sign_in" and len(argv) > 2:
        req["username"] = argv[2]
    line = (ask_pipe if WINDOWS else ask_socket)(req)
    if line is None:
        print(json.dumps({"ok": False, "error": "no_host"}))
        return 1
    if not line:
        print(json.dumps({"ok": False, "error": "no_reply"}))
        return 1
    print(line.decode().strip())
    return 0 if json.loads(line).get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
