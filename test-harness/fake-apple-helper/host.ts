#!/usr/bin/env node
// Native-messaging host registered as com.apple.passwordmanager for the test browser. The browser starts it and talks
// 4-byte length-prefixed JSON on stdio; it hands each message to the FakeHelper in the test process over the unix
// socket named by PB_FAKE_HELPER_SOCK. It holds no state.

import { connect } from "node:net";

const sock = connect(process.env.PB_FAKE_HELPER_SOCK || "");
sock.setEncoding("utf8");
sock.on("error", () => process.exit(1));
sock.on("close", () => process.exit(0));

let buf = "";
sock.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line) continue;
    const body = Buffer.from(JSON.stringify(JSON.parse(line).reply), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});

let inbox = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4 && inbox.length >= 4 + inbox.readUInt32LE(0)) {
    const n = inbox.readUInt32LE(0);
    sock.write(JSON.stringify({ msg: JSON.parse(inbox.subarray(4, 4 + n).toString("utf8")) }) + "\n");
    inbox = inbox.subarray(4 + n);
  }
});
process.stdin.on("end", () => sock.end());
