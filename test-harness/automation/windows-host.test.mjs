// iCloud for Windows speaks the same SRP session, with two encoding quirks:
// MSG (and sometimes ErrCode) arrive as strings, and SMSG arrives as a JSON string.

import { createCipheriv, randomBytes, webcrypto } from "node:crypto";
import { appleServer, big, bytes } from "./srp-reference.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
};

const SRC = new URL("../../src/apple/", import.meta.url);

// verify: "check" grades M, or forces a reply: { ErrCode, HAMK: "valid" | "forged" }
function makeWindowsHost({ pin, salt, verify = "check" }) {
  const state = { server: null, live: false, username: "" };
  const port = {
    onMessage: { addListener: (fn) => port._listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    _listeners: [],
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
  const verdict = (pake, fields) => reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: "3", ...fields }) } });

  // AES-128-GCM under the first half of K, sent as iv || ciphertext || tag
  function encryptReply(obj) {
    const iv = randomBytes(16);
    const c = createCipheriv("aes-128-gcm", state.server.K.subarray(0, 16), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
  }

  async function handle(msg) {
    if (msg.cmd === 14) {
      return reply({
        cmd: 14,
        capabilities: {
          secretSessionVersion: 1,
          canFillOneTimeCodes: true,
          supportsSubURLs: true,
          scanForOTPURI: true,
        },
      });
    }
    if (msg.cmd === 4) {
      const blob = encryptReply({
        STATUS: 0,
        Entries: [{ USR: "ada@example.com", sites: ["example.com"] }],
      });
      const smsg = JSON.stringify({ TID: state.username, SDATA: wire(blob) });
      return reply({ cmd: 4, payload: { SMSG: smsg } });
    }
    if (msg.cmd !== 2) return;
    const pake = unb64(msg.msg.PAKE);
    if (msg.msg.QID === "m0") {
      state.username = pake.TID;
      state.server = appleServer({ username: pake.TID, pin, salt, A: big(unwire(pake.A)), b: big(randomBytes(32)) });
      state.live = true;
      return reply({
        cmd: 2,
        payload: {
          PAKE: b64({
            TID: pake.TID,
            MSG: "1",
            PROTO: 1,
            VER: "1.0",
            B: wire(bytes(state.server.B)),
            s: wire(salt),
          }),
        },
      });
    }
    if (!state.live) return verdict(pake, { ErrCode: "1" });
    state.live = false;
    if (verify !== "check") {
      const hamk = verify.HAMK === "forged" ? randomBytes(32) : state.server.HAMK;
      return verdict(pake, { ErrCode: verify.ErrCode, HAMK: wire(hamk) });
    }
    if (Buffer.compare(state.server.M, unwire(pake.M)) !== 0) return verdict(pake, { ErrCode: "1" });
    return verdict(pake, { ErrCode: "0", HAMK: wire(state.server.HAMK) });
  }

  globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  return state;
}

const plainSalt = () => {
  const s = randomBytes(16);
  if (s[0] === 0) s[0] = 0x7f;
  return s;
};

async function freshClient(opts) {
  makeWindowsHost({ pin: "123456", salt: plainSalt(), ...opts });
  const { ApplePasswords } = await import(new URL(`protocol.js?windows=${Math.random()}`, SRC));
  const client = new ApplePasswords();
  await client.connect();
  await client.requestChallenge();
  return client;
}

async function verify(client, pin) {
  let err = null;
  await client.verifyPin(pin).catch((e) => (err = e));
  return err;
}

{
  const client = await freshClient();
  ok("windows capabilities omit the passwords-app sheet", client.canOpenPasswordsAppToNewPasswordSheet === false);
  ok("windows capabilities include one-time codes", client.canFillOneTimeCodes === true);
  ok("windows capabilities include totp setup", client.canSetUpTotp === true);

  const err = await verify(client, "123456");
  ok("string MSG and string ErrCode still unlock", client.state === "unlocked" && !err, String(err?.message));

  let names = null;
  let listErr = null;
  try {
    names = await client.getLoginNamesForURL(1, "https://example.com/login");
  } catch (e) {
    listErr = e;
  }
  ok(
    "string SMSG still lists logins",
    names?.[0]?.username === "ada@example.com" && !listErr,
    listErr ? String(listErr.message) : JSON.stringify(names),
  );
}

{
  const client = await freshClient();
  const err = await verify(client, "000000");
  ok(
    'wrong PIN (string ErrCode "1") is rejected as an incorrect code',
    client.state !== "unlocked" && /incorrect/i.test(String(err?.message)),
    `state=${client.state} err=${err?.message}`,
  );
}

{
  const client = await freshClient({ verify: { ErrCode: "2", HAMK: "valid" } });
  const err = await verify(client, "123456");
  ok(
    'any other ErrCode ("2") is rejected even with a valid HAMK',
    client.state !== "unlocked" && /verification error 2/.test(String(err?.message)),
    `state=${client.state} err=${err?.message}`,
  );
}

{
  const client = await freshClient({ verify: { ErrCode: "0", HAMK: "forged" } });
  const err = await verify(client, "123456");
  ok(
    'ErrCode "0" with a forged HAMK is rejected',
    client.state !== "unlocked" && /HAMK/.test(String(err?.message)),
    `state=${client.state} err=${err?.message}`,
  );
}

const failed = results.filter((r) => !r.cond).length;
console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
process.exit(failed ? 1 : 0);
