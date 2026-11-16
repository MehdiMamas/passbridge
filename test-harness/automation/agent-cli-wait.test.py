# the CLI's --site and --wait flags, run in-process with the socket/pipe call replaced by a scripted fake
# (no Apple, no relay), so it runs the same on Windows and POSIX
import contextlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path

os.environ["PASSBRIDGE_NO_WSL_REEXEC"] = "1"
os.environ["PASSBRIDGE_WAIT_STEP"] = "0.01"

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("agentcli", ROOT / "native" / "passbridge-agent-cli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


def run(argv, replies):
    """replies: list of dicts handed out in order; the last one repeats. returns (code, stdout, sent requests)"""
    sent = []

    def fake(req):
        sent.append(dict(req))
        r = replies[min(len(sent) - 1, len(replies) - 1)]
        return json.dumps(r).encode() + b"\n"

    cli.ask_socket = fake
    cli.ask_pipe = fake
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(argv)
    return code, out.getvalue(), sent


EMPTY = {"ok": True, "domain": "example.com", "usernames": []}
HAVE = {"ok": True, "domain": "example.com", "usernames": ["octocat"]}

code, out, sent = run(["logins", "7", "--site", "example.com"], [HAVE])
ok("--site is sent as site, after the tabId", code == 0 and len(sent) == 1 and sent[0]["site"] == "example.com" and sent[0]["tabId"] == 7, sent)

code, out, sent = run(["logins", "7"], [EMPTY])
ok("no --wait: one request, unchanged", code == 0 and len(sent) == 1 and "site" not in sent[0], sent)

code, out, sent = run(["logins", "7", "--wait", "1"], [EMPTY, EMPTY, HAVE])
ok("logins --wait retries until a name shows, prints the last reply", code == 0 and len(sent) == 3 and json.loads(out)["usernames"] == ["octocat"], (code, out, len(sent)))
ok("each request has its own id", len({s["id"] for s in sent}) == 3)

code, out, sent = run(["sign_in", "7", "--wait", "1", "--site", "example.com"], [EMPTY, HAVE, {"ok": True, "domain": "example.com", "username": "octocat"}])
ok("sign_in --wait polls logins, then sends sign_in once", code == 0 and [s["op"] for s in sent] == ["logins", "logins", "sign_in"], [s["op"] for s in sent])
ok("the polls and the sign_in carry the same tab and site", all(s["tabId"] == 7 and s["site"] == "example.com" for s in sent), sent)

code, out, sent = run(["sign_in", "7", "Octocat", "--wait", "1"], [{"ok": True, "usernames": ["other"]}, {"ok": True, "usernames": [" octocat "]}, {"ok": True, "username": "octocat"}])
ok("sign_in --wait waits for the named username (case-insensitive)", [s["op"] for s in sent] == ["logins", "logins", "sign_in"] and sent[2]["username"] == "Octocat" and "username" not in sent[0], sent)

code, out, sent = run(["sign_in", "7", "--wait", "1"], [{"ok": False, "error": "needs_user"}])
ok("a non-ok logins reply stops at once, no sign_in sent", code == 1 and len(sent) == 1 and json.loads(out)["error"] == "needs_user", (code, out, sent))

code, out, sent = run(["logins", "7", "--wait", "1"], [{"ok": False, "error": "not_allowed"}])
ok("logins --wait stops at once on a non-ok reply", code == 1 and len(sent) == 1, sent)

code, out, sent = run(["sign_in", "7", "--wait", "1"], [EMPTY, EMPTY])
cli_wait = len(sent)
ok("--wait that runs out sends no sign_in and prints the last logins reply, exit 1", code == 1 and len(sent) > 0 and all(s["op"] == "logins" for s in sent) and json.loads(out)["usernames"] == [], ([s["op"] for s in sent], code, out))

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    junk = cli.finish(b"not json\n")
ok("a reply that is not JSON is no_reply, exit 1, no crash", junk == 1 and json.loads(buf.getvalue())["error"] == "no_reply", buf.getvalue())

code, out, sent = run(["sign_in", "7"], [EMPTY])
ok("no --wait: a miss still sends one sign_in", [s["op"] for s in sent] == ["sign_in"], sent)

for bad in (["logins", "7", "--wait"], ["logins", "7", "--wait", "x"], ["logins", "7", "--wait", "-1"], ["logins", "7", "--wait", "601"], ["logins", "7", "--wait", "²"], ["sign_in", "7", "--site"]):
    code, out, sent = run(bad, [HAVE])
    ok("bad flag " + " ".join(bad[2:]) + " is a usage error, nothing sent", code == 2 and not sent, (code, sent))

sys.exit(0 if all(results) else 1)
