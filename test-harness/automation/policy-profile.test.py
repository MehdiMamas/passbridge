# the macOS policy helper: what the hide-password-manager profile asks the browser to do.
# the profile is written into a temp directory, so nothing here touches ~/Library or the
# installed profiles. the CFPreferences checks are stubbed for the same reason.
import importlib.util
import os
import plistlib
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / "native" / "passbridge-policy.py"
results = []

if sys.platform != "darwin":
    print(f"\n==== SKIP the macOS policy-profile check (not macOS) ====")
    sys.exit(0)


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -> " + str(detail)))


spec = importlib.util.spec_from_file_location("passbridge_policy", POLICY)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

with tempfile.TemporaryDirectory() as tmp:
    policy.APPDIR = tmp
    policy.PROFILE = os.path.join(tmp, "test.mobileconfig")
    policy.write_profile()
    with open(policy.PROFILE, "rb") as f:
        profile = plistlib.load(f)

payloads = profile.get("PayloadContent") or []
by_bundle = {p.get("PayloadType"): p for p in payloads}

ok("one payload per browser bundle", [p.get("PayloadType") for p in payloads] == policy.BUNDLES, len(payloads))
ok("the profile replaces itself by identifier", profile.get("PayloadIdentifier") == "com.passbridge.hidepm")

# PasswordManagerEnabled alone stops only the save prompt, which is the bug this guards
ok(
    "every payload stops the browser offering to save",
    all(by_bundle[b].get("PasswordManagerEnabled") is False for b in policy.BUNDLES),
)
ok(
    "every payload stops the browser filling its own saved passwords",
    all(by_bundle[b].get("PasswordManagerBlocklist") == ["*"] for b in policy.BUNDLES),
    [b for b in policy.BUNDLES if by_bundle[b].get("PasswordManagerBlocklist") != ["*"]],
)

# the switch may only report on when both halves are forced: a profile from an older build carries
# the save key alone and leaves filling in place
asked = []


def answer(keys):
    asked.append(tuple(keys))
    return True


policy.forced = answer
policy.is_hidden()
ok("is_hidden asks for both keys, not just the save one", asked[-1] == (policy.KEY, policy.BLOCK), asked[-1])

answered = set()


def answer_only_block(keys):
    asked.append(tuple(keys))
    return tuple(keys) in answered or tuple(keys) == (policy.BLOCK,)


policy.forced = answer_only_block
asked.clear()
ok("is_engaged still sees a profile that only blocks filling", policy.is_engaged() is True, asked)
ok("is_engaged asks about the save key first", asked[0] == (policy.KEY,), asked)

answered.add((policy.KEY,))
asked.clear()
ok("is_engaged sees a profile that only stops saving", policy.is_engaged() is True, asked)

failed = results.count(False)
print(f"\n==== {len(results) - failed}/{len(results)} PASS ====")
sys.exit(1 if failed or not results else 0)