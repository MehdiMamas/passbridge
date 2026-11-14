// Throwaway spike for #330, not shipped (the build copies only the files it lists into dist/).
// A plain Node process, no browser, talks to the fake Apple helper the way the extension does:
// capabilities, SRP pairing with the 6-digit code (src/apple/srp.ts), then a per-site lookup.
// The helper side is test-harness/fake-apple-helper/host.ts, started as a child process, so the
// 4-byte length-prefixed stdio framing is real. The fake never checks who started it (no origin check).
// Run: node scripts/spike/non-browser-client.ts

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHelper } from "../../test-harness/fake-apple-helper/helper.ts";
import { serveHelper } from "../../test-harness/fake-apple-helper/serve.ts";
import { SRPSession } from "../../src/apple/srp.ts";
import { base64ToBytes, bytesToBase64, bytesToBigInt, bytesToUtf8 } from "../../src/apple/crypto.ts";

const b64json = (o: unknown) => bytesToBase64(new TextEncoder().encode(JSON.stringify(o)));
const unb64json = (s: string) => JSON.parse(bytesToUtf8(base64ToBytes(s)));
const log = (s: string) => console.log(s);

const helper = new FakeHelper({ style: "mac" });
const sock = join(tmpdir(), `pb-spike-${process.pid}.sock`);
const served = await serveHelper(helper, sock);

// the "native host": what a browser would start. We start it ourselves, which is the whole point.
const host = spawn(process.execPath, [new URL("../../test-harness/fake-apple-helper/host.ts", import.meta.url).pathname], {
  env: { ...process.env, PB_FAKE_HELPER_SOCK: sock },
  stdio: ["pipe", "pipe", "inherit"],
});

let inbox = Buffer.alloc(0);
const waiting: Array<(m: any) => void> = [];
host.stdout.on("data", (chunk: Buffer) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4 && inbox.length >= 4 + inbox.readUInt32LE(0)) {
    const n = inbox.readUInt32LE(0);
    const msg = JSON.parse(inbox.subarray(4, 4 + n).toString("utf8"));
    inbox = inbox.subarray(4 + n);
    log(`  <- frame ${n} bytes, cmd ${msg.cmd}`);
    waiting.shift()?.(msg);
  }
});

function send(msg: Record<string, unknown>, wait = true, ms = 1500): Promise<any> {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  log(`  -> frame ${body.length} bytes, cmd ${msg.cmd}`);
  host.stdin.write(Buffer.concat([head, body]));
  if (!wait) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting.shift();
      resolve(undefined);
    }, ms);
    waiting.push((m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}

async function handshake(session: SRPSession) {
  const r = await send({
    cmd: 2,
    msg: {
      QID: "m0",
      PAKE: b64json({ TID: session.username, MSG: 0, A: session.serialize(session.clientPublicKeyBytes), VER: "1.0", PROTO: [1] }),
      HSTBRSR: "Chrome",
    },
  });
  const pake = unb64json(r.payload.PAKE);
  session.setServerPublicKey(bytesToBigInt(session.deserialize(pake.B)), session.deserialize(pake.s));
}

async function verify(session: SRPSession, pin: string) {
  await session.setSharedKey(pin);
  const m = await session.computeM();
  const r = await send({ cmd: 2, msg: { QID: "m2", PAKE: b64json({ TID: session.username, MSG: 2, M: session.serialize(m, false) }) } });
  return unb64json(r.payload.PAKE);
}

async function lookup(session: SRPSession, hostname: string) {
  const sdata = session.serialize(await session.encrypt({ ACT: 5, URL: hostname }));
  const r = await send({
    cmd: 4,
    tabId: 0,
    frameId: 0,
    url: hostname,
    payload: { QID: "CmdGetLoginNames4URL", SMSG: JSON.stringify({ TID: session.username, SDATA: sdata }) },
  });
  if (!r) return undefined;
  const smsg = typeof r.payload.SMSG === "string" ? JSON.parse(r.payload.SMSG) : r.payload.SMSG;
  return JSON.parse(bytesToUtf8(await session.decrypt(session.deserialize(smsg.SDATA))));
}

try {
  log("1. capabilities (cmd 14, no pairing needed)");
  const caps = await send({ cmd: 14 });
  log(`   ${JSON.stringify(caps.capabilities)}`);

  const session = new SRPSession(!!caps.capabilities.shouldUseBase64);

  log("2. lookup before pairing (no key yet, so the body is a placeholder): the helper stays silent");
  const early = await send({ cmd: 4, tabId: 0, frameId: 0, url: "127.0.0.1", payload: { QID: "CmdGetLoginNames4URL", SMSG: JSON.stringify({ TID: session.username, SDATA: "0x00" }) } });
  log(`   reply: ${early === undefined ? "none (timed out)" : JSON.stringify(early)}`);

  log("3. handshake m0 (helper shows a 6-digit code on screen)");
  await handshake(session);
  log(`   code the helper is showing: ${helper.code}`);

  log("4. wrong code");
  const bad = await verify(session, helper.code === "000000" ? "000001" : "000000");
  log(`   reply: ${JSON.stringify({ MSG: bad.MSG, ErrCode: bad.ErrCode })} (the challenge is burned)`);

  log("5. new handshake, right code (unlock)");
  const s2 = new SRPSession(!!caps.capabilities.shouldUseBase64);
  await handshake(s2);
  const ok = await verify(s2, helper.code);
  log(`   reply: ${JSON.stringify({ MSG: ok.MSG, ErrCode: ok.ErrCode })}, helper.paired = ${helper.paired}`);

  log("6. per-site lookup (cmd 4, ACT 5 with the page hostname)");
  const found = await lookup(s2, "127.0.0.1");
  log(`   ${JSON.stringify({ STATUS: found.STATUS, users: found.Entries?.map((e: any) => e.USR) })}`);
  const none = await lookup(s2, "elsewhere.invalid");
  log(`   other site: ${JSON.stringify({ STATUS: none.STATUS })}`);

  if (!ok || found.STATUS !== 0 || none.STATUS !== 3 || !helper.paired) throw new Error("spike check failed");
  log("done: a plain Node process paired and looked up a login through the 4-byte framing.");
} finally {
  host.stdin.end();
  host.kill();
  await served.close();
}
