#!/usr/bin/python3
import getpass
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import uuid

USAGE = "usage: passbridge-agent-cli.py status | pair-start | pair-pin (pin on stdin) | logins <tabId> [--site <host>] [--wait <seconds, max 600>] | sign_in <tabId> [username] [--site <host>] [--wait <seconds, max 600>] | save <tabId> <username> | verify-code <tabId> [site] [username] | unlock | save --url <https-url> <username>  (save reads the password from stdin)"

MAX_WAIT = 600
WINDOWS = os.name == "nt"
if WINDOWS:
    _default = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "PassBridge")
else:
    _default = "~/Library/Application Support/PassBridge"
APPDIR = os.path.expanduser(os.environ.get("PASSBRIDGE_APPDIR", _default))
SOCK = os.path.join(APPDIR, "agent.sock")
KEYFILE = os.path.join(APPDIR, "agent.key")
PIPE = r"\\.\pipe\passbridge-agent-" + getpass.getuser()


def under_wsl():
    # the named pipe and agent.key exist only on the Windows side, so a WSL shell hands the call to Windows Python.
    # PASSBRIDGE_NO_WSL_REEXEC=1 turns it off; PASSBRIDGE_OSRELEASE points the check at another file (tests)
    if os.environ.get("PASSBRIDGE_NO_WSL_REEXEC"):
        return False
    try:
        with open(os.environ.get("PASSBRIDGE_OSRELEASE", "/proc/sys/kernel/osrelease")) as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def wsl_reexec(argv):
    # py.exe -3, else python.exe; stdin passes straight through, so a password never touches argv
    py = shutil.which("py.exe") or ("/mnt/c/Windows/py.exe" if os.path.exists("/mnt/c/Windows/py.exe") else None)
    cmd = [py, "-3"] if py else ([shutil.which("python.exe")] if shutil.which("python.exe") else None)
    if not cmd:
        return None
    try:
        script = subprocess.run(["wslpath", "-w", os.path.abspath(__file__)], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return subprocess.call(cmd + [script] + argv)


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
    if argv and argv[0] in ("-h", "--help"):
        print(USAGE)
        return 0
    if not argv or argv[0] not in ("status", "pair-start", "pair-pin", "logins", "sign_in", "save", "verify-code", "unlock"):
        print(USAGE, file=sys.stderr)
        return 2
    if under_wsl():
        code = wsl_reexec(argv)
        if code is not None:
            return code
    wait = 0
    site = None
    if argv[0] in ("logins", "sign_in"):
        # --site <host> and --wait <seconds> may come anywhere after the tabId
        rest = []
        i = 0
        while i < len(argv):
            a = argv[i]
            if i >= 2 and a in ("--site", "--wait"):
                val = argv[i + 1] if i + 1 < len(argv) else None
                bad_wait = a == "--wait" and not (val and val.isascii() and val.isdigit() and int(val) <= MAX_WAIT)
                if val is None or bad_wait or (a == "--site" and not val):
                    print(USAGE, file=sys.stderr)
                    return 2
                if a == "--wait":
                    wait = int(val)
                else:
                    site = val
                i += 2
                continue
            rest.append(a)
            i += 1
        argv = rest
    req = {"id": uuid.uuid4().hex, "op": argv[0].replace("-", "_")}
    if site:
        req["site"] = site
    pairing = argv[0] in ("pair-start", "pair-pin", "unlock")
    if argv[0] == "pair-pin":
        req["pin"] = sys.stdin.readline().strip()
    by_url = argv[0] == "save" and len(argv) > 1 and argv[1] == "--url"
    if argv[0] != "status" and not pairing and not by_url:
        if len(argv) < 2 or not argv[1].isdigit():
            print("tabId must be a number", file=sys.stderr)
            return 2
        req["tabId"] = int(argv[1])
    if argv[0] == "sign_in" and len(argv) > 2:
        req["username"] = argv[2]
    if argv[0] == "verify-code" and len(argv) > 2 and argv[2]:
        req["site"] = argv[2]
    if argv[0] == "verify-code" and len(argv) > 3:
        req["username"] = argv[3]
    if argv[0] == "save":
        if by_url:
            if len(argv) < 4:
                print("usage: save --url <https-url> <username>, password on stdin", file=sys.stderr)
                return 2
            req["url"] = argv[2]
            argv = argv[:1] + argv[2:]
        if len(argv) < 3:
            print("usage: save <tabId> <username>, password on stdin", file=sys.stderr)
            return 2
        req["username"] = argv[2]
        req["password"] = sys.stdin.read().rstrip("\r\n")
        if not req["password"]:
            print("the password must come on stdin", file=sys.stderr)
            return 2
    ask = ask_pipe if WINDOWS else ask_socket
    if wait:
        # a login saved on another device can take minutes to reach this Mac: poll the username list until it shows up
        try:
            step = max(0.05, float(os.environ.get("PASSBRIDGE_WAIT_STEP") or 10))
        except ValueError:
            step = 10.0
        want = req.get("username")
        probe = dict(req, op="logins")
        probe.pop("username", None)
        start = time.monotonic()
        while True:
            probe["id"] = uuid.uuid4().hex
            raw = ask(probe)
            try:
                r = json.loads(raw) if raw else None
            except ValueError:
                r = None
            if r is None:
                return finish(raw)
            names = [str(n).strip().lower() for n in (r.get("usernames") or [])]
            found = bool(names) and (not want or str(want).strip().lower() in names)
            if not r.get("ok") or found or time.monotonic() - start >= wait:
                break
            time.sleep(step)
        # logins prints its last reply; a failed read stops before any sign_in is sent
        if req["op"] == "logins" or not r.get("ok"):
            return finish(raw)
        if not found:
            # time ran out: the last logins reply says what was looked up; no sign_in is sent
            print(raw.decode().strip())
            return 1
        req["id"] = uuid.uuid4().hex
    return finish(ask(req))


def finish(line):
    if line is None:
        print(json.dumps({"ok": False, "error": "no_host"}))
        return 1
    if not line:
        print(json.dumps({"ok": False, "error": "no_reply"}))
        return 1
    try:
        reply = json.loads(line)
    except ValueError:
        print(json.dumps({"ok": False, "error": "no_reply"}))
        return 1
    print(line.decode().strip())
    return 0 if isinstance(reply, dict) and reply.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
