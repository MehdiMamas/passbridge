#!/usr/bin/env python3
# stands in for a helper older than the code reader: the real relay, but its active and standby events carry no
# code flag, so the extension must answer verify_code with reader_missing at once. The agent socket still works.
import os

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "native", "passbridge-agent.py")
with open(SRC, encoding="utf-8") as f:
    code = f.read().replace(', "code": True', "")
ns = {"__name__": "old_relay", "__file__": SRC}
exec(compile(code, SRC, "exec"), ns)
ns["main"]()
