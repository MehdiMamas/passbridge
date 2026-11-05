// Replays scrubbed replies captured from iCloud for Windows through the real protocol code.
// The keys in the fixtures are dummies, so the proof is not checked; the shapes are.

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = /** @type {any} */ (webcrypto);

/** @type {{ name: string, cond: unknown }[]} */
const results = [];
/** @param {string} name @param {unknown} cond @param {string} [detail] */
const ok = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
};

const SRC = new URL("../../src/apple/", import.meta.url);
const FIX = new URL("../fixtures/windows/", import.meta.url);
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), "utf8"));
/** @param {object} o */
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
/** @param {string} s */
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

// answers each command with its fixture; TID (and the dummy B and salt) are swapped for values
// this session can use, everything else is the captured shape
/** @param {string} verifyName */
function replayHost(verifyName) {
  const port = {
    onMessage: { addListener: (/** @type {(msg: any) => void} */ fn) => port._listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    /** @type {((msg: any) => void)[]} */
    _listeners: [],
    disconnect() {},
    /** @param {any} msg */
    postMessage(msg) {
      setTimeout(() => {
        let out;
        if (msg.cmd === 14) out = fixture("connect");
        else if (msg.cmd === 2) {
          const sent = unb64(msg.msg.PAKE);
          const isChallenge = msg.msg.QID === "m0";
          const fx = fixture(isChallenge ? "challenge" : verifyName);
          const pake = { ...unb64(fx.payload.PAKE), TID: sent.TID };
          if (isChallenge) {
            pake.B = "0x" + "02".padStart(2, "0");
            pake.s = "0x" + "11".repeat(16);
          }
          out = { ...fx, payload: { ...fx.payload, PAKE: b64(pake) } };
        }
        if (out) port._listeners.forEach((fn) => fn(out));
      }, 0);
    },
  };
  globalThis.chrome = /** @type {any} */ ({ runtime: { connectNative: () => port, lastError: undefined } });
}

/** @param {string} verifyName */
async function challenged(verifyName) {
  replayHost(verifyName);
  const { ApplePasswords } = await import(/** @type {any} */ (new URL(`protocol.ts?fixtures=${Math.random()}`, SRC)));
  const client = new ApplePasswords();
  await client.connect();
  await client.requestChallenge();
  return client;
}

/** @param {any} reply */
async function unlockedWith(reply) {
  const client = await challenged("verify-ok");
  const { State } = await import(/** @type {any} */ (new URL("protocol.ts", SRC)));
  client.state = State.Unlocked;
  client.session.sharedKey = new Uint8Array(32);
  client._encryptedQuery = async () => reply;
  return client;
}

/** @param {() => unknown} fn @returns {Promise<{ value?: any, err?: any }>} */
async function attempt(fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    return { err: e };
  }
}

{
  const client = await challenged("verify-ok");
  ok("connect.json capabilities are read", client.canFillOneTimeCodes === true);
  ok("challenge.json gives a challenge to answer", client.hasChallenge === true, `state=${client.state}`);
}

{
  const client = await challenged("verify-ok");
  const { err } = await attempt(() => client.verifyPin("123456"));
  ok(
    "verify-ok.json is read without a missing-field error (dummy proof is rejected last)",
    /HAMK mismatch/.test(String(err?.message)),
    String(err?.message),
  );
}

{
  const client = await challenged("verify-bad-code");
  const { err } = await attempt(() => client.verifyPin("000000"));
  ok(
    "verify-bad-code.json (ErrCode 5, no MSG) is an incorrect code",
    client.state !== "unlocked" && /Incorrect code/.test(String(err?.message)),
    String(err?.message),
  );
}

{
  const client = await unlockedWith(fixture("login-names"));
  const { value, err } = await attempt(() => client.getLoginNamesForURL(1, "https://example.com/login"));
  ok(
    "login-names.json gives parsed logins",
    Array.isArray(value) && value.length === 2 && value[0].username === "user@example.com" && !err,
    String(err?.message ?? JSON.stringify(value)),
  );
}

{
  const client = await unlockedWith(fixture("password"));
  const { value, err } = await attempt(() =>
    client.getPasswordForLoginName(1, "https://example.com/login", { username: "user@example.com" }),
  );
  ok(
    "password.json gives a parsed password",
    value?.username === "user@example.com" && typeof value?.password === "string" && !err,
    String(err?.message ?? JSON.stringify(value)),
  );
}

{
  const client = await unlockedWith(fixture("otp"));
  const { value, err } = await attempt(() => client.readOneTimeCode(1, 0, ["https://example.com/"]));
  ok(
    "otp.json gives a parsed code",
    value?.length === 1 && value[0].code === "000000" && value[0].domain === "example.com" && !err,
    String(err?.message ?? JSON.stringify(value)),
  );
}

const failed = results.filter((r) => !r.cond).length;
console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
process.exit(failed ? 1 : 0);
