// a code is only valid for the exact challenge it was shown for, the client must never swap the challenge under the user

import { randomBytes, webcrypto } from "node:crypto";
import { GROUP_1024, GROUP_3072, appleServer, big, bytes, group } from "./srp-reference.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
};

const SRC = new URL("../../src/apple/", import.meta.url);
const { SRPSession } = await import(new URL("srp.js", SRC));

const hex = (n) => (typeof n === "bigint" ? n.toString(16) : Buffer.from(n).toString("hex")).toUpperCase();
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// RFC 5054 appendix B (SHA-1, 1024-bit group): proves the reference before it grades anything
{
  const G = group(GROUP_1024, "sha1");
  const I = "alice";
  const P = "password123";
  const s = Buffer.from("BEB25379D1A8581EB5A727673A2441EE", "hex");
  const a = BigInt("0x60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393");
  const b = BigInt("0xE487CB59D31AC550471E81F00F6928E01DDA08E974A004F49E61F5D105284D20");
  const want = {
    k: "7556AA045AEF2CDD07ABAF0F665C3E818913186F",
    x: "94B7555AABE9127CC58CCF4993DB6CF84D16C124",
    v: "7E273DE8696FFC4F4E337D05B4B375BEB0DDE1569E8FA00A9886D8129BADA1F1822223CA1A605B530E379BA4729FDC59F105B4787E5186F5C671085A1447B52A48CF1970B4FB6F8400BBF4CEBFBB168152E08AB5EA53D15C1AFF87B2B9DA6E04E058AD51CC72BFC9033B564E26480D78E955A5E29E7AB245DB2BE315E2099AFB",
    A: "61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC44352E8903211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC8E39356179EAE45E42BA92AEACED825171E1E8B9AF6D9C03E1327F44BE087EF06530E69F66615261EEF54073CA11CF5858F0EDFDFE15EFEAB349EF5D76988A3672FAC47B0769447B",
    B: "BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011BAF38964DC46A0670DD125B95A981652236F99D9B681CBF87837EC996C6DA04453728610D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA37089E6F9C6059F388838E7A00030B331EB76840910440B1B27AAEAEEB4012B7D7665238A8E3FB004B117B58",
    u: "CE38B9593487DA98554ED47D70A7AE5F462EF019",
    S: "B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D233861E359B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C41BB59B6D5979B5C00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F3499B200210DCC1F10EB33943CD67FC88A2F39A4BE5BEC4EC0A3212DC346D7E474B29EDE8A469FFECA686E5A",
  };
  const x = G.x(I, P, s);
  const v = G.verifier(I, P, s);
  const A = G.publicA(a);
  const B = G.publicB(b, v);
  const u = G.u(A, B);
  const got = { k: G.k, x, v, A, B, u, S: G.clientS(a, B, x, u) };
  const off = Object.keys(want).filter((key) => hex(got[key]) !== want[key]);
  ok("reference SRP matches RFC 5054 appendix B (k, x, v, A, B, u, S)", off.length === 0, `differs: ${off.join(", ")}`);
  ok("reference server and client agree on S", G.serverS(A, v, u, b) === got.S);
}

// salt is bytes and K a 32-byte digest, both hashed as-is never as trimmed bigints
class SrpServer {
  constructor({ pin, salt }) {
    this.pin = pin;
    this.salt = salt;
  }
  start(username, A) {
    this.r = appleServer({ username, pin: this.pin, salt: this.salt, A, b: big(randomBytes(32)) });
    return { B: this.r.B, s: this.salt };
  }
}

// one code per challenge, a failed verify burns it like the real helper
function makeHost({ salts, pins }) {
  const state = { codesShown: [], challenges: 0, server: null, live: false };
  let saltIdx = 0;
  let pinIdx = 0;

  const port = {
    _listeners: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._listeners.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    disconnect() {},
    postMessage(msg) {
      setTimeout(() => void handle(msg), 0);
    },
  };
  const reply = (m) => port._listeners.forEach((fn) => fn(m));
  const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
  const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  const wire = (b) => "0x" + Buffer.from(b).toString("hex");
  const unwire = (s) => Buffer.from(String(s).replace(/^0x/, ""), "hex");

  async function handle(msg) {
    if (msg.cmd === 14) return reply({ cmd: 14, capabilities: { shouldUseBase64: false } });
    if (msg.cmd !== 2) return;
    const pake = unb64(msg.msg.PAKE);

    if (msg.msg.QID === "m0") {
      state.challenges++;
      const pin = pins[Math.min(pinIdx++, pins.length - 1)];
      const salt = salts[Math.min(saltIdx++, salts.length - 1)];
      state.codesShown.push(pin);
      state.server = new SrpServer({ pin, salt });
      state.live = true;
      const { B, s } = state.server.start(pake.TID, big(unwire(pake.A)));
      return reply({
        cmd: 2,
        payload: { PAKE: b64({ TID: pake.TID, MSG: 1, PROTO: 1, B: wire(bytes(B)), s: wire(s) }) },
      });
    }

    if (!state.live) return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 1 }) } });
    state.live = false;
    if (!same(state.server.r.M, unwire(pake.M))) {
      return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 1 }) } });
    }
    return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 0, HAMK: wire(state.server.r.HAMK) }) } });
  }

  globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  return state;
}

const leadingZeroSalt = () => {
  const s = randomBytes(16);
  s[0] = 0x00; // the 1-in-256 case that used to be truncated
  return s;
};
const plainSalt = () => {
  const s = randomBytes(16);
  if (s[0] === 0) s[0] = 0x7f;
  return s;
};

async function freshClient() {
  // re-import per test so each run gets its own module-level client state
  const { ApplePasswords } = await import(new URL(`protocol.js?${Math.random()}`, SRC));
  const c = new ApplePasswords();
  await c.connect();
  return c;
}

{
  const host = makeHost({ salts: [plainSalt()], pins: ["123456"] });
  const c = await freshClient();
  await c.requestChallenge();
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("the code shown on the Mac unlocks", c.state === "unlocked" && !err, String(err?.message));
}

// a salt whose first byte is 0x00 used to be truncated and reported as a wrong PIN
{
  const host = makeHost({ salts: [leadingZeroSalt()], pins: ["123456"] });
  const c = await freshClient();
  await c.requestChallenge();
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("leading-zero salt still unlocks", c.state === "unlocked" && !err, String(err?.message));
}

// fixed inputs chosen so K = H(S) starts with 0x00 and the salt starts with 0x00,
// graded against the reference and against golden values, not against srp.js's own formula
{
  const username = "0x00112233445566778899aabbccddeeff";
  const salt = Buffer.from("00" + "5a".repeat(15), "hex");
  const a = BigInt("0x" + "a5".repeat(32));
  const b = BigInt("0x" + "3c".repeat(32)) + 512n;
  const A = group(GROUP_3072, "sha256").publicA(a);
  const r = appleServer({ username, pin: "123456", salt, A, b });
  const golden = {
    K: "00018E6D301A6FBE5CD377927F34C296620996CFFA5BFD6B9475ACDE3FD63180",
    M: "C3D8C91BA21ABEFD6968D1E6B100BC3368CBFFEF2D9F17812D891575694D1F6F",
    HAMK: "41DFB0165F818F097216993F58C9384AE8B6312D9ADA20E517EC6526C846FA3E",
  };
  ok("reference still yields the golden K, M and HAMK", hex(r.K) === golden.K && hex(r.M) === golden.M && hex(r.HAMK) === golden.HAMK);

  const s = new SRPSession(false);
  s.username = username;
  s.clientPrivateKey = a;
  ok("client A is minimal big-endian g^a", same(s.clientPublicKeyBytes, bytes(A)));
  s.setServerPublicKey(r.B, new Uint8Array(salt));
  await s.setSharedKey("123456");
  ok("leading-zero shared key matches the reference", s.sharedKey.toString(16).padStart(64, "0").toUpperCase() === golden.K);
  const m = await s.computeM();
  ok("leading-zero shared key hashes at full 32 bytes (M)", hex(m) === golden.M, hex(m));
  ok("HAMK matches the reference", hex(await s.computeHMAC(m)) === golden.HAMK);
  await s.setSharedKey("654321");
  ok("a wrong PIN gives a different M", hex(await s.computeM()) !== golden.M);
}

{
  const host = makeHost({ salts: [plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  await c.requestChallenge({ ifNeeded: true });
  await c.requestChallenge({ ifNeeded: true });
  ok("ifNeeded reuses the live challenge (one code, not three)", host.challenges === 1, `challenges=${host.challenges}`);
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("the first code still works after ifNeeded calls", c.state === "unlocked" && !err, String(err?.message));
}

{
  const host = makeHost({ salts: [plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await Promise.all([c.requestChallenge(), c.requestChallenge(), c.requestChallenge()]);
  ok("concurrent challenge requests show one code", host.challenges === 1, `challenges=${host.challenges}`);
}

{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  const firstCode = host.codesShown[0];
  await c.requestChallenge();
  let err = null;
  await c.verifyPin(firstCode).catch((e) => (err = e));
  ok("stale code fails as a wrong code, not a crash", !!err && c.state !== "unlocked", String(err?.message));
  await c.requestChallenge();
  let err2 = null;
  await c.verifyPin(host.codesShown[host.codesShown.length - 1]).catch((e) => (err2 = e));
  ok("the newest code unlocks right after a stale one", c.state === "unlocked" && !err2, String(err2?.message));
}

// verifying with no live challenge must not re-challenge and grade the old code against the new one
{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  let bad = null;
  await c.verifyPin("000000").catch((e) => (bad = e));
  ok("wrong code is rejected", !!bad && c.state !== "unlocked", String(bad?.message));
  ok("a spent challenge is not reusable", c.hasChallenge === false);

  let stale = null;
  await c.verifyPin("000000").catch((e) => (stale = e));
  ok(
    "next attempt asks for the NEW code instead of grading the old one",
    stale?.code === "challenge_reissued",
    `code=${stale?.code} msg=${stale?.message}`,
  );
  ok("and a fresh code is on screen for it", c.hasChallenge === true && host.challenges === 2, `challenges=${host.challenges}`);

  let err = null;
  await c.verifyPin(host.codesShown[host.codesShown.length - 1]).catch((e) => (err = e));
  ok("typing that new code unlocks (no infinite incorrect loop)", c.state === "unlocked" && !err, String(err?.message));
}

{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  c._challengeAt = Date.now() - 10 * 60_000;
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("an expired code re-prompts", err?.code === "challenge_reissued" && host.challenges === 2, `${err?.code} challenges=${host.challenges}`);
}

const failed = results.filter((r) => !r.cond);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
