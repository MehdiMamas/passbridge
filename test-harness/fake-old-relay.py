#!/usr/bin/env python3
# a helper older than the code reader: native messaging, an "active" event with no code flag, and every cmd message ignored
import json
import struct
import sys


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


send({"event": "active"})
while True:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        break
    (n,) = struct.unpack("<I", raw)
    sys.stdin.buffer.read(n)
