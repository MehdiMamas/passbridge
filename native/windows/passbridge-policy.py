#!/usr/bin/env python3
# hides Chromium's built-in password manager by writing PasswordManagerEnabled=0 under HKCU policy.
# accepts messages only from this extension's id. the browser must be fully quit before the policy applies.
import json
import os
import struct
import subprocess
import sys
import winreg

EXT_ORIGIN = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/"
VALUE = "PasswordManagerEnabled"
POLICIES = [
    r"Software\Policies\Google\Chrome",
    r"Software\Policies\Microsoft\Edge",
    r"Software\Policies\BraveSoftware\Brave",
    r"Software\Policies\Chromium",
    r"Software\Policies\Vivaldi",
]


def origin_ok():
    if len(sys.argv) < 2:
        return False
    return sys.argv[1].rstrip("/") == EXT_ORIGIN.rstrip("/")


def send(obj):
    raw = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(raw)) + raw)
    sys.stdout.buffer.flush()


def is_hidden():
    # true only when every key this host manages is actually 0
    for path in POLICIES:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_READ) as key:
                val, typ = winreg.QueryValueEx(key, VALUE)
        except OSError:
            return False
        if typ != winreg.REG_DWORD or val != 0:
            return False
    return True


def _write_dword():
    for path in POLICIES:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, VALUE, 0, winreg.REG_DWORD, 0)


def _delete_value():
    for path in POLICIES:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
                try:
                    winreg.DeleteValue(key, VALUE)
                except PermissionError:
                    raise
                except OSError:
                    pass
        except PermissionError:
            raise
        except OSError:
            pass


def _reg_text(delete):
    lines = ["Windows Registry Editor Version 5.00", ""]
    for path in POLICIES:
        lines.append("[HKEY_CURRENT_USER\\" + path + "]")
        if delete:
            lines.append('"PasswordManagerEnabled"=-')
        else:
            lines.append('"PasswordManagerEnabled"=dword:00000000')
        lines.append("")
    return "\r\n".join(lines)


def _elevate_reg(delete):
    # some PCs lock HKCU\Software\Policies against new subkeys. importing as the same user
    # with the runas verb shows one UAC prompt, the same idea as the macOS profile approval.
    if os.environ.get("OPENPASSWORDS_NO_ELEVATE"):
        raise PermissionError("policies key is locked")
    folder = os.path.join(os.environ.get("LOCALAPPDATA", "."), "PassBridge")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "password-manager.reg")
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(_reg_text(delete))
    command = (
        "$p = Start-Process -FilePath reg.exe -ArgumentList @('import','"
        + path.replace("'", "''")
        + "') -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise PermissionError((result.stderr or result.stdout or "the approval prompt was dismissed").strip())


def set_hidden():
    try:
        _write_dword()
    except PermissionError:
        _elevate_reg(False)
        # an admin approving with a different account writes that account's HKCU
        if not is_hidden():
            raise PermissionError("the approved import did not reach this user's policy keys")


def _any_set():
    for path in POLICIES:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_READ) as key:
                winreg.QueryValueEx(key, VALUE)
                return True
        except OSError:
            pass
    return False


def clear_hidden():
    try:
        _delete_value()
    except PermissionError:
        _elevate_reg(True)
        if _any_set():
            raise PermissionError("the approved import did not reach this user's policy keys")


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    if n > 1_000_000:
        send({"ok": False, "error": "message too large"})
        return
    if not origin_ok():
        send({"ok": False, "error": "forbidden"})
        return
    action = json.loads(sys.stdin.buffer.read(n) or b"{}").get("action")
    if action == "set":
        try:
            set_hidden()
        except PermissionError as exc:
            send({"ok": False, "error": f"couldn't write the policy ({exc})"})
            return
        send({
            "ok": True,
            "hidden": is_hidden(),
            "note": "Quit and reopen the browser so the policy applies.",
        })
    elif action == "clear":
        try:
            clear_hidden()
        except PermissionError as exc:
            send({"ok": False, "error": f"couldn't write the policy ({exc})"})
            return
        send({
            "ok": True,
            "hidden": is_hidden(),
            "note": "Quit and reopen the browser to bring the password manager back.",
        })
    elif action == "get":
        send({"ok": True, "hidden": is_hidden()})
    else:
        send({"ok": False, "error": "unknown action"})


if __name__ == "__main__":
    main()
