// The Apple helper's side of the native-messaging protocol, for tests. It does what the real helper does for the
// extension (capabilities, SRP-6a pairing with a 6-digit code, AES-GCM sessions, the vault commands) and nothing else.
// Keychain and Touch ID / Windows Hello happen inside Apple's helper, so they show up here as vault state and as an
// "auth" switch a test flips. One FakeHelper holds the vault; each browser connection gets its own session.
// Replies follow the recorded Windows fixtures (test-harness/fixtures/windows) for style "win", and the macOS
// shape (numeric MSG and ErrCode, SMSG as an object) for style "mac".

import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { appleServer, big, bytes } from "../automation/srp-reference.ts";

const Cmd = { HANDSHAKE: 2, GET_LOGIN_NAMES: 4, GET_PASSWORD: 5, SET_PASSWORD: 6, PASSWORDS_DISABLED: 9, RELOGIN_NEEDED: 10, LAUNCH_APP: 13, GET_CAPABILITIES: 14, ONE_TIME_CODE: 15, GET_OTPS: 16, DID_FILL_OTP: 17 };
const Status = { Success: 0, GenericError: 1, NoResults: 3 };

// logins are keyed by the sites they are saved for; otps by the domain they belong to
export function seedVault() {
  return {
    logins: [{ username: "mia@pb-e2e.invalid", password: "e2e-Pass-1", sites: ["127.0.0.1", "localhost"] }],
    otps: [
      { source: "totp", username: "mia@pb-e2e.invalid", domain: "127.0.0.1", code: "246810" },
      { source: "totp", username: "other@pb-e2e.invalid", domain: "elsewhere.invalid", code: "864209" },
    ],
  };
}

const hostMatches: (site: string, host: string) => boolean = (site, host) => host === site || host.endsWith("." + site);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

type Conn = { send: (reply: any) => void, server: any, live: boolean, paired: boolean, username: string, closed: boolean };

export class FakeHelper {
  style: "mac" | "win";
  vault: ReturnType<typeof seedVault>;
  state: string;
  auth: string;
  authPrompts: number;
  codesShown: string[];
  /** how many handshakes have ended paired, ever (a connection that closes does not lower it) */
  pairings: number;
  saved: any[];
  launched: any[];
  conns: Set<Conn>;
  constructor({ style = "mac", vault = seedVault() }: { style?: "mac" | "win", vault?: ReturnType<typeof seedVault> } = {}) {
    this.style = style;
    this.vault = vault;
    /** "ok", "relogin" (RELOGIN_NEEDED) or "disabled" (PASSWORDS_DISABLED) */
    this.state = "ok";
    /** what Touch ID / Windows Hello does for password and code reads: "approve", "deny" or "timeout" (never answers) */
    this.auth = "approve";
    this.authPrompts = 0;
    this.codesShown = [];
    this.pairings = 0;
    this.saved = [];
    this.launched = [];
    this.conns = new Set();
  }

  /** the code the helper is showing now */
  get code() {
    return this.codesShown[this.codesShown.length - 1];
  }

  /** a new browser connection; send(reply) delivers a reply to it, the return value takes its messages */
  connect(send: (reply: any) => void) {
    const conn: Conn = { send, server: null, live: false, paired: false, username: "", closed: false };
    this.conns.add(conn);
    return {
      receive: (msg: any) => this._handle(conn, msg),
      close: () => {
        conn.closed = true;
        this.conns.delete(conn);
      },
    };
  }

  /** what a person does at the helper: the code on screen stops working */
  expireChallenge() {
    for (const c of this.conns) c.live = false;
  }

  /** is any browser connection paired */
  get paired() {
    return [...this.conns].some((c) => c.paired);
  }

  /** the helper asks to sign in again (relogin) or says Passwords is off (disabled); "ok" undoes it */
  setState(state: "ok" | "relogin" | "disabled") {
    this.state = state;
    const cmd = state === "relogin" ? Cmd.RELOGIN_NEEDED : state === "disabled" ? Cmd.PASSWORDS_DISABLED : 0;
    if (cmd) for (const c of this.conns) c.send({ cmd });
  }

  /** unsolicited "a code just arrived" */
  pushOneTimeCode() {
    for (const c of this.conns) c.send({ cmd: Cmd.ONE_TIME_CODE });
  }

  // wire helpers -----------------------------------------------------------------------------------------
  get win() {
    return this.style === "win";
  }
  _msg(n: number) {
    return this.win ? String(n) : n;
  }
  _pake(obj: any) {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  }
  _unpake(s: string) {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  }
  _wire(b: Uint8Array) {
    return "0x" + Buffer.from(b).toString("hex");
  }
  _unwire(s: string) {
    return Buffer.from(String(s).replace(/^0x/, ""), "hex");
  }

  capabilities() {
    const caps = { secretSessionVersion: 1, canFillOneTimeCodes: true, supportsSubURLs: true, scanForOTPURI: true };
    // the macOS helper also opens the Passwords app on the new-password sheet and saves a login with no name
    if (!this.win) Object.assign(caps, { canOpenPasswordsAppToNewPasswordSheet: true, canSaveAccountWithEmptyUserName: true });
    return caps;
  }

  // AES-128-GCM under the first half of K. In: ciphertext || tag || iv. Out: iv || ciphertext || tag.
  _open(conn: Conn, sdata: string) {
    const raw = this._unwire(sdata);
    const iv = raw.subarray(raw.length - 16);
    const tag = raw.subarray(raw.length - 32, raw.length - 16);
    const d = createDecipheriv("aes-128-gcm", conn.server.K.subarray(0, 16), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 32)), d.final()]).toString("utf8"));
  }
  _seal(conn: Conn, obj: any) {
    const iv = randomBytes(16);
    const c = createCipheriv("aes-128-gcm", conn.server.K.subarray(0, 16), iv);
    const ct = Buffer.concat([c.update(JSON.stringify({ TID: conn.username, ...obj }), "utf8"), c.final()]);
    const smsg = { TID: conn.username, SDATA: this._wire(Buffer.concat([iv, ct, c.getAuthTag()])) };
    return this.win ? JSON.stringify(smsg) : smsg;
  }

  async _handle(conn: Conn, msg: any) {
    if (conn.closed) return;
    switch (msg.cmd) {
      case Cmd.GET_CAPABILITIES:
        return conn.send({ cmd: Cmd.GET_CAPABILITIES, capabilities: this.capabilities() });
      case Cmd.HANDSHAKE:
        return this._handshake(conn, msg);
      case Cmd.GET_LOGIN_NAMES:
      case Cmd.GET_PASSWORD:
      case Cmd.GET_OTPS:
      case Cmd.DID_FILL_OTP:
      case Cmd.SET_PASSWORD:
        return this._query(conn, msg);
      case Cmd.LAUNCH_APP:
        this.launched.push(msg);
        return;
      default:
        return; // END and anything else: nothing to say
    }
  }

  _handshake(conn: Conn, msg: any) {
    const pake = this._unpake(msg.msg.PAKE);
    const reply = (fields: any) => conn.send({ cmd: Cmd.HANDSHAKE, payload: { QID: msg.msg.QID, PAKE: this._pake({ TID: pake.TID, ...fields }) } });
    if (msg.msg.QID === "m0") {
      if (this.state === "relogin") return conn.send({ cmd: Cmd.RELOGIN_NEEDED });
      if (this.state === "disabled") return conn.send({ cmd: Cmd.PASSWORDS_DISABLED });
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      this.codesShown.push(code);
      const salt = randomBytes(16);
      if (salt[0] === 0) salt[0] = 0x7f;
      conn.username = pake.TID;
      conn.server = appleServer({ username: pake.TID, pin: code, salt, A: big(this._unwire(pake.A)), b: big(randomBytes(32)) });
      conn.live = true;
      return reply({ MSG: this._msg(1), PROTO: 1, VER: "1.0", B: this._wire(bytes(conn.server.B)), s: this._wire(salt) });
    }
    // a code is good once: a failed or late verify burns the challenge
    const good = conn.live && Buffer.compare(conn.server.M, this._unwire(pake.M)) === 0;
    conn.live = false;
    if (good) {
      conn.paired = true;
      this.pairings++;
    }
    if (good) return reply({ MSG: this._msg(3), HAMK: this._wire(conn.server.HAMK), ErrCode: 0 });
    // Windows answers a bad code with TID and ErrCode only; macOS keeps MSG
    return reply(this.win ? { ErrCode: 5 } : { MSG: 3, ErrCode: 1 });
  }

  async _query(conn: Conn, msg: any) {
    if (!conn.paired) return; // not paired yet: the real helper stays silent
    const sent = JSON.parse(msg.payload.SMSG);
    if (sent.TID !== conn.username) return;
    const q = this._open(conn, sent.SDATA);
    const answer = (cmd: number, obj: any) => conn.send({ cmd, payload: { SMSG: this._seal(conn, obj) } });
    const entry = (l: { sites: string[], username: string, password: string }) => ({ HLD: l.sites[0] || "", customTitle: "", USR: l.username, PWD: l.password, ModDate: "", CDate: "", sites: l.sites, NOTES: "", TOTP: "0" });

    if (msg.cmd === Cmd.SET_PASSWORD) {
      const host = q.NURL;
      const hit = this.vault.logins.find((l) => l.username === q.NUSR && l.sites.some((s) => hostMatches(s, host)));
      if (hit) hit.password = q.NPWD;
      else this.vault.logins.push({ username: q.NUSR, password: q.NPWD, sites: [host] });
      this.saved.push({ host, username: q.NUSR, password: q.NPWD, updated: !!hit });
      return conn.send({ cmd: Cmd.SET_PASSWORD, payload: {} });
    }

    if (msg.cmd === Cmd.GET_LOGIN_NAMES) {
      const rows = this.vault.logins.filter((l) => l.sites.some((s) => hostMatches(s, q.URL)));
      return answer(msg.cmd, rows.length ? { STATUS: Status.Success, Entries: rows.map(entry) } : { STATUS: Status.NoResults });
    }

    if (msg.cmd === Cmd.GET_PASSWORD || msg.cmd === Cmd.DID_FILL_OTP) {
      this.authPrompts++;
      if (this.auth === "timeout") return;
      if (this.auth === "deny") return answer(msg.cmd, { STATUS: Status.GenericError });
    }

    if (msg.cmd === Cmd.GET_PASSWORD) {
      const rows = this.vault.logins.filter((l) => l.username === q.USR && l.sites.some((s) => hostMatches(s, q.URL)));
      return answer(msg.cmd, rows.length ? { STATUS: Status.Success, Entries: rows.map((l) => { const { customTitle, ...e } = entry(l); return e; }) } : { STATUS: Status.NoResults });
    }

    // codes: for the frames asked about, the rows whose domain is one of those hosts (or has none, like a text message)
    const hosts: string[] = (q.frameURLs || []).map(hostOf);
    let rows = this.vault.otps.filter((r) => !r.domain || hosts.some((h) => hostMatches(r.domain, h)));
    if (msg.cmd === Cmd.DID_FILL_OTP && q.username) rows = rows.filter((r) => r.username === q.username);
    const out = rows.map((r) => ({ ...r, duration: 22, period: 30 }));
    return answer(msg.cmd, out.length ? { STATUS: Status.Success, Entries: out, ...(msg.cmd === Cmd.GET_OTPS ? { RequiresUserAuthenticationToFill: false } : {}) } : { STATUS: Status.NoResults });
  }
}
