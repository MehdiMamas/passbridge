// The fake Apple helper (test-harness/fake-apple-helper) against the real src/apple/protocol.ts, in process,
// in both reply styles: pairing, a wrong code, every command, Touch ID outcomes, relogin. The win style is also
// checked against the replies recorded from iCloud for Windows (test-harness/fixtures/windows).

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { FakeHelper, seedVault } from "../fake-apple-helper/helper.ts";

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
/** @param {string} s */
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
/** @param {object} o */
const keys = (o) => Object.keys(o).sort().join(",");
const { bytesToUtf8 } = await import(/** @type {any} */ (new URL("crypto.ts", SRC)));

// a port wired straight to the helper, remembering every reply
/** @param {"mac" | "win"} style @param {object} [opts] */
function setup(style, opts) {
  const helper = new FakeHelper({ style, vault: seedVault(), ...opts });
  /** @type {any[]} */
  const replies = [];
  /** @type {((reply: any) => void)[]} */
  const listeners = [];
  /** @type {(() => void)[]} */
  const disc = [];
  const link = helper.connect((reply) => {
    replies.push(reply);
    setTimeout(() => listeners.forEach((fn) => fn(reply)), 0);
  });
  const port = {
    onMessage: { addListener: (/** @type {(reply: any) => void} */ fn) => listeners.push(fn) },
    onDisconnect: { addListener: (/** @type {() => void} */ fn) => disc.push(fn) },
    disconnect() {},
    postMessage: (/** @type {any} */ msg) => setTimeout(() => void link.receive(msg), 0),
  };
  globalThis.chrome = /** @type {any} */ ({ runtime: { connectNative: () => port, lastError: undefined } });
  return { helper, replies };
}

/** @param {"mac" | "win"} style @param {object} [opts] */
async function pairedClient(style, opts) {
  const env = setup(style, opts);
  const { ApplePasswords } = await import(/** @type {any} */ (new URL(`protocol.ts?fake=${Math.random()}`, SRC)));
  const client = new ApplePasswords();
  await client.connect();
  await client.requestChallenge();
  await client.verifyPin(env.helper.code);
  return { ...env, client };
}

// decrypt the newest encrypted reply with the client's own session
/** @param {{ replies: any[], client: any }} env */
async function lastPlain(env) {
  const r = env.replies[env.replies.length - 1];
  const smsg = typeof r.payload.SMSG === "string" ? JSON.parse(r.payload.SMSG) : r.payload.SMSG;
  const s = env.client.session;
  return JSON.parse(bytesToUtf8(await s.decrypt(s.deserialize(smsg.SDATA))));
}

/** @param {Promise<unknown>} p @returns {Promise<any>} */
const err = async (p) => p.then(() => null, (e) => e);

for (const style of /** @type {const} */ (["mac", "win"])) {
  /** @param {string} name */
  const t = (name) => `${style}: ${name}`;
  {
    const env = setup(style);
    const { ApplePasswords } = await import(/** @type {any} */ (new URL(`protocol.ts?fake=${Math.random()}`, SRC)));
    const client = new ApplePasswords();
    await client.connect();
    ok(t("capabilities say codes can be filled"), client.canFillOneTimeCodes === true && client.canSetUpTotp === true);
    ok(t("the new-password sheet is a macOS-only capability"), client.canOpenPasswordsAppToNewPasswordSheet === (style === "mac"));
    await client.requestChallenge();
    ok(t("a 6-digit code is shown"), /^\d{6}$/.test(env.helper.code), env.helper.code);

    const wrong = await err(client.verifyPin(env.helper.code === "000000" ? "111111" : "000000"));
    ok(t("a wrong code is an incorrect code"), /incorrect/i.test(String(wrong?.message)) && client.state !== "unlocked", String(wrong?.message));
    const again = await err(client.verifyPin("123456"));
    ok(t("after a failed code the next try asks for the new code"), again?.code === "challenge_reissued" && client.hasChallenge, String(again?.code));
    ok(t("a new code is on screen"), env.helper.codesShown.length === 2);

    env.helper.expireChallenge();
    const late = await err(client.verifyPin(env.helper.code));
    ok(t("a code the helper let expire no longer works"), /incorrect/i.test(String(late?.message)), String(late?.message));
    await client.requestChallenge();
    const fine = await err(client.verifyPin(env.helper.code));
    ok(t("the new code unlocks"), !fine && client.state === "unlocked", String(fine?.message));
  }

  {
    const env = await pairedClient(style);
    const { client, helper } = env;
    const names = await client.getLoginNamesForURL(1, "http://127.0.0.1/login");
    ok(t("login names for a site"), names.length === 1 && names[0].username === "mia@pb-e2e.invalid", JSON.stringify(names));
    ok(t("no logins for another site"), (await client.getLoginNamesForURL(1, "http://nothing.invalid/")).length === 0);

    const cred = await client.getPasswordForLoginName(1, "http://127.0.0.1/login", { username: "mia@pb-e2e.invalid" });
    ok(t("password for a login"), cred?.password === "e2e-Pass-1" && helper.authPrompts === 1, JSON.stringify(cred));

    helper.auth = "deny";
    const denied = await err(client.getPasswordForLoginName(1, "http://127.0.0.1/login", { username: "mia@pb-e2e.invalid" }));
    ok(t("Touch ID denied: the read fails and the session stays unlocked"), !!denied && client.state === "unlocked", String(denied?.message));
    helper.auth = "approve";

    await client.saveLogin(1, "http://127.0.0.1/signup", "new@pb-e2e.invalid", "n3w-Pass");
    ok(t("save adds a login"), helper.saved.length === 1 && helper.saved[0].updated === false);
    await client.saveLogin(1, "http://127.0.0.1/signup", "new@pb-e2e.invalid", "n3w-Pass-2");
    ok(t("saving the same login again updates it"), helper.saved[1].updated === true && /** @type {any} */ (helper.vault.logins.find((l) => l.username === "new@pb-e2e.invalid")).password === "n3w-Pass-2");
    ok(t("saved logins are listed"), (await client.getLoginNamesForURL(1, "http://127.0.0.1/")).length === 2);

    const { entries } = await client.getOneTimeCodes(1, 0, ["http://127.0.0.1/otp"]);
    ok(t("codes for the page's site only"), entries.length === 1 && entries[0].code === "246810", JSON.stringify(entries));
    const read = await client.readOneTimeCode(1, 0, ["http://127.0.0.1/otp"], "mia@pb-e2e.invalid");
    ok(t("read one code by login"), read.length === 1 && read[0].code === "246810", JSON.stringify(read));
    helper.auth = "deny";
    ok(t("a denied code read fails"), !!(await err(client.readOneTimeCode(1, 0, ["http://127.0.0.1/otp"], "mia@pb-e2e.invalid"))));
    helper.auth = "approve";

    let pushed = 0;
    client.onOneTimeCodeAvailable(() => pushed++);
    helper.pushOneTimeCode();
    await new Promise((r) => setTimeout(r, 20));
    ok(t("a pushed code is passed on"), pushed === 1);

    client.launchPasswordsApp({ searchUrl: "https://127.0.0.1/" });
    await new Promise((r) => setTimeout(r, 20));
    ok(t("launching the Passwords app reaches the helper"), helper.launched.length === 1 && helper.launched[0].searchQueryURL === "https://127.0.0.1/");

    helper.setState("relogin");
    await new Promise((r) => setTimeout(r, 20));
    ok(t("relogin needed drops the session"), client.state === "disconnected" && !client.ready, client.state);
  }

  {
    const env = setup(style);
    const { ApplePasswords } = await import(/** @type {any} */ (new URL(`protocol.ts?fake=${Math.random()}`, SRC)));
    const client = new ApplePasswords();
    env.helper.setState("disabled");
    const e = await err(client.connect());
    ok(t("passwords disabled: connect fails and the port is dropped"), !!e && !client.port, `${e?.message} ${client.state}`);
  }
}

// the win style next to the replies recorded from iCloud for Windows
{
  const env = await pairedClient("win");
  const raw = env.replies.filter((r) => r.cmd === 2).map((r) => unb64(r.payload.PAKE));
  const [hello, verdict] = raw;
  ok("win: capabilities have the recorded keys", keys(env.replies[0].capabilities) === keys(fixture("connect").capabilities));
  ok("win: server hello has the recorded keys", keys(hello) === keys(unb64(fixture("challenge").payload.PAKE)), keys(hello));
  ok("win: MSG is a string", hello.MSG === "1" && verdict.MSG === "3");
  ok("win: verify reply has the recorded keys", keys(verdict) === keys(unb64(fixture("verify-ok").payload.PAKE)), keys(verdict));

  await env.client.getLoginNamesForURL(1, "http://127.0.0.1/");
  ok("win: SMSG is a JSON string", typeof env.replies[env.replies.length - 1].payload.SMSG === "string");
  const names = await lastPlain(env);
  ok("win: login names have the recorded keys and entry keys", keys(names).startsWith("Entries,STATUS,TID") && keys(names.Entries[0]) === keys(fixture("login-names").Entries[0]), keys(names.Entries[0]));
  await env.client.getPasswordForLoginName(1, "http://127.0.0.1/", { username: "mia@pb-e2e.invalid" });
  ok("win: password entry has the recorded keys", keys((await lastPlain(env)).Entries[0]) === keys(fixture("password").Entries[0]));
  await env.client.getOneTimeCodes(1, 0, ["http://127.0.0.1/"]);
  const otp = await lastPlain(env);
  ok("win: code entries have the recorded keys", keys(otp.Entries[0]) === keys(fixture("otp").Entries[0]), keys(otp.Entries[0]));

  const bad = setup("win");
  const { ApplePasswords } = await import(/** @type {any} */ (new URL(`protocol.ts?fake=${Math.random()}`, SRC)));
  const c2 = new ApplePasswords();
  await c2.connect();
  await c2.requestChallenge();
  await err(c2.verifyPin("000000"));
  const last = unb64(bad.replies[bad.replies.length - 1].payload.PAKE);
  ok("win: a bad code answers like the recorded one", keys(last) === keys(unb64(fixture("verify-bad-code").payload.PAKE)) && last.ErrCode === 5, JSON.stringify(last));
}

{
  const env = await pairedClient("mac");
  const raw = env.replies.filter((r) => r.cmd === 2).map((r) => unb64(r.payload.PAKE));
  ok("mac: MSG is a number and SMSG an object", raw[0].MSG === 1 && raw[1].MSG === 3 && raw[1].ErrCode === 0);
  await env.client.getLoginNamesForURL(1, "http://127.0.0.1/");
  ok("mac: SMSG is an object", typeof env.replies[env.replies.length - 1].payload.SMSG === "object");
}

const failed = results.filter((r) => !r.cond).length;
console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
process.exit(failed ? 1 : 0);
