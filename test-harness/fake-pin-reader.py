#!/usr/bin/env python3
# stands in for read-pair-code.ps1 in tests: prints bare digits and exits 0, or exits 1 while no window is up.
# the scenario is read from $PASSBRIDGE_APPDIR/fake-pin-scenario on every start. all codes here are made-up values.
import os
import sys
import time

APPDIR = os.environ["PASSBRIDGE_APPDIR"]
try:
    with open(os.path.join(APPDIR, "fake-pin-scenario")) as f:
        scenario = f.read().strip()
except OSError:
    scenario = "ok"
with open(os.path.join(APPDIR, "fake-pin-runs"), "a") as f:
    f.write("x")
if scenario == "ok":
    sys.stdout.write("482915")
elif scenario == "spaced":
    sys.stdout.write("482 915")
elif scenario == "bad":
    sys.stdout.write("12ab56")
elif scenario == "no_window":
    sys.exit(1)
elif scenario == "crash":
    sys.exit(2)
elif scenario == "hang":
    while True:
        with open(os.path.join(APPDIR, "fake-pin-beat"), "w") as f:
            f.write("%.3f" % time.time())
        time.sleep(0.1)
