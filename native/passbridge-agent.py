#!/usr/bin/python3
# agent sign-in host: Chrome starts it, it listens (a unix socket on macOS, a named pipe on Windows) and relays
# one JSON request to the extension (4-byte length-prefixed stdio) and the extension's reply back to that client.
# it adds nothing and sees no secret: the extension never sends one.
import getpass
import json
import os
import socket
import struct
import sys
import threading
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
TIMEOUT = 90

out_lock = threading.Lock()
pending = {}  # id -> [event, reply]
pending_lock = threading.Lock()


def send_ext(obj):
    b = json.dumps(obj).encode()
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
        sys.stdout.buffer.flush()


def read_ext():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        return None
    return json.loads(data)


def ask(req):
    rid = str(req.get("id", ""))
    if not rid or not isinstance(req.get("op"), str):
        return {"id": rid, "ok": False, "error": "bad_request"}
    # our own id on the wire, so two clients picking the same id can't get each other's reply
    wid = uuid.uuid4().hex
    ev = threading.Event()
    slot = [ev, None]
    with pending_lock:
        pending[wid] = slot
    try:
        send_ext({**req, "id": wid})
        if not ev.wait(TIMEOUT):
            return {"id": rid, "ok": False, "error": "timeout"}
        return {**slot[1], "id": rid}
    except Exception:
        return {"id": rid, "ok": False, "error": "extension_gone"}
    finally:
        with pending_lock:
            pending.pop(wid, None)


def handle(raw):
    try:
        req = json.loads(raw)
        if not isinstance(req, dict):
            raise ValueError
    except ValueError:
        return {"id": "", "ok": False, "error": "bad_request"}
    return ask(req)


def serve_client(conn):
    with conn, conn.makefile("rwb") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                f.write(json.dumps(handle(line)).encode() + b"\n")
                f.flush()
            except OSError:
                return


def serve_pipe_client(conn):
    # send_bytes/recv_bytes only: send()/recv() would unpickle what the client sends
    with conn:
        while True:
            try:
                raw = conn.recv_bytes()
            except (EOFError, OSError):
                return
            try:
                conn.send_bytes(json.dumps(handle(raw)).encode())
            except OSError:
                return


def load_key():
    # 32 random bytes made on first start; only this host and the CLI read the file
    os.makedirs(APPDIR, exist_ok=True)
    try:
        fd = os.open(KEYFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        with open(KEYFILE, "rb") as f:
            return f.read()
    key = os.urandom(32)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    return key


def listen_pipe():
    from multiprocessing.connection import Listener

    srv = Listener(address=PIPE, family="AF_PIPE", authkey=load_key())
    while True:
        try:
            conn = srv.accept()
        except Exception:
            # a client without the key fails the handshake: drop it and keep listening
            continue
        threading.Thread(target=serve_pipe_client, args=(conn,), daemon=True).start()


def listen():
    if WINDOWS:
        listen_pipe()
        return
    os.makedirs(APPDIR, exist_ok=True)
    os.chmod(APPDIR, 0o700)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    os.chmod(SOCK, 0o600)
    srv.listen(8)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


def gone():
    # stdin closed: answer everyone still waiting, then leave
    with pending_lock:
        for rid, slot in pending.items():
            slot[1] = {"id": rid, "ok": False, "error": "extension_gone"}
            slot[0].set()
    try:
        os.unlink(SOCK)
    except OSError:
        pass


def main():
    threading.Thread(target=listen, daemon=True).start()
    while True:
        try:
            msg = read_ext()
        except Exception:
            msg = None
        if msg is None:
            gone()
            # let the waiting handler threads write their replies
            threading.Event().wait(0.3)
            os._exit(0)
        rid = str(msg.get("id", "")) if isinstance(msg, dict) else ""
        with pending_lock:
            slot = pending.get(rid)
        if slot:
            slot[1] = msg
            slot[0].set()


if __name__ == "__main__":
    main()
