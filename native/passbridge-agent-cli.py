#!/usr/bin/python3
# usage: passbridge-agent-cli.py status | logins <tabId> | sign_in <tabId> [username]
import json
import os
import socket
import sys
import uuid

SOCK = os.path.join(
    os.path.expanduser(os.environ.get("PASSBRIDGE_APPDIR", "~/Library/Application Support/PassBridge")), "agent.sock"
)


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
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(100)
    try:
        s.connect(SOCK)
    except OSError:
        print(json.dumps({"ok": False, "error": "no_host"}))
        return 1
    s.sendall(json.dumps(req).encode() + b"\n")
    line = s.makefile("rb").readline()
    if not line:
        print(json.dumps({"ok": False, "error": "no_reply"}))
        return 1
    print(line.decode().strip())
    return 0 if json.loads(line).get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
