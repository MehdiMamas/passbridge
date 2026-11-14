#!/usr/bin/python3
# agent sign-in host: Chrome starts it, it listens (a unix socket on macOS, a named pipe on Windows) and relays
# one JSON request to the extension (4-byte length-prefixed stdio) and the extension's reply back to that client.
# it adds nothing and sees no secret: the extension never sends one.
import getpass
import hmac
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

WINDOWS = os.name == "nt"
if WINDOWS:
    _default = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "PassBridge")
else:
    _default = "~/Library/Application Support/PassBridge"
APPDIR = os.path.expanduser(os.environ.get("PASSBRIDGE_APPDIR", _default))
SOCK = os.path.join(APPDIR, "agent.sock")
KEYFILE = os.path.join(APPDIR, "agent.key")
LOCKFILE = os.path.join(APPDIR, "agent.lock")
PIPE = r"\\.\pipe\passbridge-agent-" + getpass.getuser()
TIMEOUT = 90
# the code reader: a signed app that presses Allow on Apple's prompt and sends the code back over a one-shot socket
READER_APP = os.path.join(APPDIR, "PassBridge Code Reader.app")
READER_CMD = os.environ.get("PASSBRIDGE_CODE_READER")  # a JSON argv list, tests only
READER_CONNECT_S = 10
READER_TOTAL_S = float(os.environ.get("PASSBRIDGE_READER_TOTAL_S") or 70)  # the env var is for tests
CODE_RE = re.compile(r"^\d{6}$")
READER_ERRORS = ("no_prompt", "several_prompts", "reader_permission", "not_configured", "reader_failed")

out_lock = threading.Lock()
pending = {}  # id -> [event, reply]
pending_lock = threading.Lock()
lock_fd = None  # set once this process owns the endpoint
reader_lock = threading.Lock()
reads = {}  # rid -> state of a read in flight, so a cancel can reach it
reads_lock = threading.Lock()


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


def own_lock():
    # one relay per user owns the endpoint; the OS drops the lock when the process exits, so a crash leaves no stale owner
    global lock_fd
    os.makedirs(APPDIR, exist_ok=True)
    fd = os.open(LOCKFILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if WINDOWS:
            import msvcrt

            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False
    lock_fd = fd
    return True


def close_quietly(x):
    try:
        x.close()
    except Exception:
        pass


def unlink_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def read_code(rid, st):
    # one read: launch the reader, take one answer over a one-shot socket, send it to the extension. the code lives only here
    def reply(**kw):
        send_ext({"event": "code", "rid": rid, **kw})

    path = None
    proc = None
    locked = False
    try:
        if WINDOWS or (sys.platform != "darwin" and not READER_CMD):
            return reply(ok=False, error="mac_only")
        if not reader_lock.acquire(timeout=2):
            return reply(ok=False, error="busy")
        locked = True
        if st["cancel"].is_set():
            return reply(ok=False, error="reader_failed")
        if not READER_CMD and not os.path.isdir(READER_APP):
            return reply(ok=False, error="reader_missing")
        os.makedirs(APPDIR, exist_ok=True)
        os.chmod(APPDIR, 0o700)
        nonce = secrets.token_hex(16)
        path = os.path.join(APPDIR, "reader-%s.sock" % secrets.token_hex(8))
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        st["srv"] = srv
        srv.bind(path)
        os.chmod(path, 0o600)
        srv.listen(1)
        srv.settimeout(0.2)
        # the nonce goes in a 0600 file next to the socket, never in argv
        fd = os.open(path + ".nonce", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(nonce)
        if READER_CMD:
            cmd = list(json.loads(READER_CMD)) + ["--socket", path]
        else:
            cmd = ["/usr/bin/open", "-g", "-j", "-n", "-a", READER_APP, "--args", "--socket", path]
        started = time.monotonic()
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        conn = None
        while conn is None:
            if st["cancel"].is_set():
                return reply(ok=False, error="reader_failed")
            code = proc.poll()
            if code not in (None, 0):
                return reply(ok=False, error="reader_failed")
            if time.monotonic() - started > READER_CONNECT_S:
                return reply(ok=False, error="reader_failed")
            try:
                conn, _ = srv.accept()
            except (socket.timeout, BlockingIOError):
                continue
        st["conn"] = conn
        # one connection only: a second one is refused
        st["srv"] = None
        close_quietly(srv)
        conn.settimeout(0.2)
        buf = b""
        result = None
        while result is None:
            if st["cancel"].is_set() or time.monotonic() - started > READER_TOTAL_S:
                return reply(ok=False, error="reader_failed")
            if b"\n" not in buf:
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    continue
                if not chunk or len(buf) > 65536:
                    return reply(ok=False, error="reader_failed")
                buf += chunk
                continue
            line, buf = buf.split(b"\n", 1)
            try:
                obj = json.loads(line)
            except ValueError:
                return reply(ok=False, error="reader_failed")
            if not isinstance(obj, dict) or not hmac.compare_digest(str(obj.get("nonce", "")), nonce):
                return reply(ok=False, error="reader_failed")
            if "ok" in obj:
                result = obj
            elif obj.get("state") != "started":
                return reply(ok=False, error="reader_failed")
        if st["cancel"].is_set():
            return reply(ok=False, error="reader_failed")
        if result.get("ok") is True:
            code = str(result.get("code", "")).replace(" ", "")
            if not CODE_RE.match(code):
                return reply(ok=False, error="reader_failed")
            return reply(ok=True, code=code)
        err = result.get("error")
        return reply(ok=False, error=err if err in READER_ERRORS else "reader_failed")
    except Exception:
        try:
            reply(ok=False, error="reader_failed")
        except Exception:
            pass
    finally:
        for k in ("conn", "srv"):
            if st.get(k):
                close_quietly(st[k])
                st[k] = None
        if path:
            unlink_quietly(path)
            unlink_quietly(path + ".nonce")
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except Exception:
                pass
        if locked:
            reader_lock.release()
        with reads_lock:
            reads.pop(rid, None)


def start_read(rid):
    st = {"cancel": threading.Event(), "srv": None, "conn": None}
    with reads_lock:
        reads[rid] = st
    threading.Thread(target=read_code, args=(rid, st), daemon=True).start()


def cancel_code(rid=None):
    # only the read with this rid (None: every read, when the extension is gone)
    with reads_lock:
        targets = [st for r, st in reads.items() if rid is None or r == rid]
    for st in targets:
        st["cancel"].set()
        for k in ("conn", "srv"):
            if st.get(k):
                close_quietly(st[k])


def listen():
    standby = False
    while not own_lock():
        if not standby:
            standby = True
            send_ext({"event": "standby", "code": True})
        time.sleep(5)
    send_ext({"event": "active", "code": True})
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
    cancel_code()
    with pending_lock:
        for rid, slot in pending.items():
            slot[1] = {"id": rid, "ok": False, "error": "extension_gone"}
            slot[0].set()
    if lock_fd is not None:
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
        if isinstance(msg, dict) and "cmd" in msg and "id" not in msg:
            rid = str(msg.get("rid", ""))
            if msg["cmd"] == "read_code":
                start_read(rid)
            elif msg["cmd"] == "cancel_code":
                cancel_code(rid)
            continue
        rid = str(msg.get("id", "")) if isinstance(msg, dict) else ""
        with pending_lock:
            slot = pending.get(rid)
        if slot:
            slot[1] = msg
            slot[0].set()


if __name__ == "__main__":
    main()
