// @ts-check
// ported from au2001/icloud-passwords-firefox (Apache-2.0), see NOTICE

import { SRPSession, SecretSessionVersion, MSGType } from "./srp.js";
import {
  bytesToBase64,
  base64ToBytes,
  bytesToUtf8,
  bigIntToBytes,
  bytesToBigInt,
  constantTimeEqual,
  QueryStatus,
  queryStatusError,
} from "./crypto.js";

const NATIVE_HOST = "com.apple.passwordmanager";
const BROWSER_NAME = "Chrome";
const VERSION = "1.0";
// background.js sets this from chrome.runtime.getPlatformInfo; tests leave the mac default
let deviceLabel = "your Mac";

export function setDeviceLabel(label) {
  if (typeof label === "string" && label) deviceLabel = label;
}

function freshCodeMessage() {
  return `Enter the new code ${deviceLabel} is showing now`;
}

// iCloud for Windows JSON-encodes some integers as strings
function asInt(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}
// past this we re-prompt instead of verifying against a code the user lost track of
const CHALLENGE_TTL_MS = 3 * 60_000;
// password and code reads may wait on Touch ID or Windows Hello, but never forever: a stuck read holds the lock
const USER_AUTH_TIMEOUT_MS = 2 * 60_000;

// callers show "new code" wording for this, retyping the old code can never work
function challengeError(message) {
  return Object.assign(new Error(message), { code: "challenge_reissued" });
}

// numbering matches the helper's own ExtensionCommand enum (and apple's extension)
export const Command = {
  END: 0,
  HANDSHAKE: 2,
  SET_ICON_AND_TITLE: 3,
  GET_LOGIN_NAMES_FOR_URL: 4,
  GET_PASSWORD_FOR_LOGIN_NAME: 5,
  SET_PASSWORD_FOR_LOGIN_NAME_URL: 6,
  NEW_ACCOUNT_FOR_URL: 7,
  TAB_EVENT: 8,
  PASSWORDS_DISABLED: 9,
  RELOGIN_NEEDED: 10,
  LAUNCH_PASSWORDS_APP: 13, // also carries "new password sheet" and "set up TOTP" variants
  GET_CAPABILITIES: 14,
  ONE_TIME_CODE_AVAILABLE: 15, // helper -> us, unsolicited: a code just arrived (Messages)
  GET_ONE_TIME_CODES: 16,
  DID_FILL_ONE_TIME_CODE: 17, // read the current TOTP value right before filling it
  SET_UP_TOTP_GENERATOR: 18, // status reply to the set-up-TOTP variant of cmd 13
  OPEN_URL_IN_SAFARI: 1984,
};

const QueryId = {
  [4]: "CmdGetLoginNames4URL",
  [5]: "CmdGetPassword4LoginName",
  [16]: "CmdGetOneTimeCodes",
  [17]: "CmdDidFillOneTimeCode",
};

const Action = { UPDATE: 1, SEARCH: 2, ADD_NEW: 3, MAYBE_ADD: 4, GHOST_SEARCH: 5 };

export const State = {
  Disconnected: "disconnected",
  NeedsPin: "needs_pin",
  Unlocked: "unlocked",
  NoHelper: "no_helper",
};

function jsonToBase64(obj) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(obj)));
}

// totp entries can arrive without a code, the value is read at fill time
function normalizeOtpEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) => ({
      source: String(e.source || ""),
      username: e.username || "",
      domain: e.domain || "",
      code: e.code != null ? String(e.code) : "",
    }))
    .filter((e) => e.code || e.source === "totp");
}

export class ApplePasswords {
  constructor() {
    /** @type {chrome.runtime.Port | undefined} */
    this.port = undefined;
    /** @type {SRPSession | undefined} */
    this.session = undefined;
    /** @type {Record<string, any> | undefined} */
    this.capabilities = undefined;
    this.state = State.Disconnected;
    /** @type {Map<number, { resolve: (m: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> | null }>} */
    this._waiters = new Map();
    /** @type {(state: string) => void} */
    this._onState = () => {};
    this._onOneTimeCode = () => {};
    this._challengeAt = 0;
    this._challengeGen = 0;
    this._challengePending = undefined;
    // replies carry no correlation id, so same-cmd requests collide. serialize everything
    this._lock = Promise.resolve();
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  onStateChange(fn) {
    this._onState = fn;
  }

  onOneTimeCodeAvailable(fn) {
    this._onOneTimeCode = fn;
  }

  // default false so an older helper hides the feature instead of getting a command it cant handle
  get canFillOneTimeCodes() {
    return this.capabilities?.canFillOneTimeCodes === true;
  }
  get canOpenPasswordsAppToNewPasswordSheet() {
    return this.capabilities?.canOpenPasswordsAppToNewPasswordSheet === true;
  }
  get canSetUpTotp() {
    return this.capabilities?.scanForOTPURI === true;
  }
  get canSaveAccountWithEmptyUserName() {
    return this.capabilities?.canSaveAccountWithEmptyUserName === true;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    try {
      this._onState(s);
    } catch (_) {}
  }

  get ready() {
    return (
      this.port !== undefined &&
      this.session !== undefined &&
      this.session.sharedKey !== undefined &&
      this.state === State.Unlocked
    );
  }

  _send(cmd, body = {}, timeoutMs = 5000) {
    const port = this.port;
    if (!port) throw new Error("connection closed");
    // a second request on the same cmd would steal the first one's reply
    if (this._waiters.has(cmd)) return Promise.reject(new Error("another request is already in flight"));
    return new Promise((resolve, reject) => {
      /** @type {{ resolve: (m: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> | null }} */
      const entry = { resolve, reject, timer: null };
      entry.timer =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              if (this._waiters.get(cmd) === entry) this._waiters.delete(cmd);
              reject(new Error("timeout waiting for response"));
            }, timeoutMs);
      this._waiters.set(cmd, entry);
      try {
        port.postMessage({ cmd, ...body });
      } catch (e) {
        if (entry.timer) clearTimeout(entry.timer);
        if (this._waiters.get(cmd) === entry) this._waiters.delete(cmd);
        reject(e);
      }
    });
  }

  // a request that can never be answered must not hold the lock for every later one
  _rejectWaiters(reason) {
    const waiters = [...this._waiters.values()];
    this._waiters.clear();
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
  }

  _dispatch(message) {
    const w = this._waiters.get(message.cmd);
    if (w) {
      this._waiters.delete(message.cmd);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(message);
    }
    if (message.cmd === Command.PASSWORDS_DISABLED || message.cmd === Command.RELOGIN_NEEDED) {
      // the helper invalidated this handshake; a live port with no session can never pair again
      this._dropNativePort();
    }
    if (message.cmd === Command.ONE_TIME_CODE_AVAILABLE && !w) {
      try {
        this._onOneTimeCode();
      } catch (_) {}
    }
  }

  // never resets an unlocked session, apple's extension re-pairs on every connect
  connect() {
    if (this.port) return Promise.resolve();
    if (this._connectPending) return this._connectPending;
    /** @type {Promise<void>} */
    const pending = new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (e) {
        this._setState(State.NoHelper);
        return reject(e);
      }
      this.port = port;

      port.onMessage.addListener((msg) => this._dispatch(msg));
      port.onDisconnect.addListener(() => {
        const owned = this.port === port;
        if (owned) {
          this.port = undefined;
          this.session = undefined;
          this._rejectWaiters("connection closed");
        }
        if (this._dropping) {
          this._dropping = false;
          return;
        }
        if (!owned) return;
        const err = chrome.runtime.lastError?.message;
        if (err && /not found|forbidden|host/i.test(err)) this._setState(State.NoHelper);
        else this._setState(State.Disconnected);
      });

      this._send(Command.GET_CAPABILITIES)
        .then((reply) => {
          const capabilities = reply.capabilities ?? {};
          this.capabilities = capabilities;
          // helper negotiates the version per handshake via PROTO, so only reject an explicit non-RFC demand
          if (
            capabilities.secretSessionVersion !== undefined &&
            capabilities.secretSessionVersion !== SecretSessionVersion.SRPWithRFCVerification
          ) {
            return reject(new Error("unsupported capabilities (expected SRP RFC verification)"));
          }
          this.session = new SRPSession(capabilities.shouldUseBase64);
          this._setState(State.NeedsPin);
          resolve();
        })
        .catch(reject);
    });
    this._connectPending = pending;
    pending.finally(() => {
      if (this._connectPending === pending) this._connectPending = undefined;
    });
    return pending;
  }

  // the code on the Mac only belongs to the newest challenge
  get hasChallenge() {
    return (
      this.state === State.NeedsPin &&
      this.session !== undefined &&
      this.session.serverPublicKey !== undefined &&
      this.session.salt !== undefined &&
      Date.now() - this._challengeAt < CHALLENGE_TTL_MS
    );
  }

  // helper said the session is dead: drop the port so the next connect() can handshake
  _dropNativePort() {
    const port = this.port;
    this.port = undefined;
    this.session = undefined;
    this._rejectWaiters("connection closed");
    if (port) {
      this._dropping = true;
      try { port.disconnect(); } catch (_) {}
    }
    this._setState(State.Disconnected);
  }

  // ifNeeded keeps a live prompt, a second code on screen invalidates the one the user is reading
  requestChallenge({ ifNeeded = false } = {}) {
    if (!this.session) {
      if (this._connectPending) {
        return this._connectPending.then(() => this.requestChallenge({ ifNeeded }));
      }
      if (this.port) this._dropNativePort();
      return this.connect().then(() => {
        if (!this.session) return Promise.reject(new Error("not connected"));
        return this.requestChallenge({ ifNeeded });
      });
    }
    if (ifNeeded && (this.hasChallenge || this.state === State.Unlocked)) return Promise.resolve(false);
    // two prompts would race and only the last code works
    if (this._challengePending) return this._challengePending;
    const p = this._withLock(() => this._issueChallenge());
    this._challengePending = p;
    const clear = () => {
      if (this._challengePending === p) this._challengePending = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  // the session a request started on, a disconnect between awaits clears this.session
  _liveSession() {
    if (!this.session) throw new Error("connection closed");
    return this.session;
  }

  async _issueChallenge() {
    const session = this._liveSession();
    session.serverPublicKey = undefined;
    session.salt = undefined;
    session.sharedKey = undefined;
    this._challengeGen++;

    const reply = await this._send(Command.HANDSHAKE, {
      msg: {
        QID: "m0",
        PAKE: jsonToBase64({
          TID: session.username,
          MSG: MSGType.ClientKeyExchange,
          A: session.serialize(session.clientPublicKeyBytes),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRPWithRFCVerification],
        }),
        HSTBRSR: BROWSER_NAME,
      },
    });

    const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
    if (pake.TID !== session.username) throw new Error("challenge for another session");
    if (pake.ErrCode !== undefined) throw new Error(`server hello error ${pake.ErrCode}`);
    if (pake.MSG.toString() !== MSGType.ServerKeyExchange.toString()) throw new Error("unexpected server message");
    if (asInt(pake.PROTO) !== SecretSessionVersion.SRPWithRFCVerification) throw new Error("unsupported protocol");

    const B = bytesToBigInt(session.deserialize(pake.B));
    const s = session.deserialize(pake.s);
    session.setServerPublicKey(B, s);
    this._challengeAt = Date.now();
    this._setState(State.NeedsPin);
    return true;
  }

  // a PIN only matches the challenge it was shown for, so re-issue and ask for the new code
  async verifyPin(pin) {
    if (!this.session) throw new Error("not connected");
    if (!this.hasChallenge) {
      await this.requestChallenge();
      throw challengeError(freshCodeMessage());
    }
    const gen = this._challengeGen;
    return this._withLock(async () => {
      // re-issued while queued, typed code is for the old prompt
      if (gen !== this._challengeGen) throw challengeError(freshCodeMessage());
      const session = this._liveSession();
      try {
        await session.setSharedKey(pin);
        const m = await session.computeM();

        const reply = await this._send(Command.HANDSHAKE, {
          msg: {
            QID: "m2",
            PAKE: jsonToBase64({
              TID: session.username,
              MSG: MSGType.ClientVerification,
              M: session.serialize(m, false),
            }),
          },
        });

        const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
        if (pake.TID !== session.username) throw new Error("verification for another session");
        if (pake.MSG.toString() !== MSGType.ServerVerification.toString()) throw new Error("unexpected server message");
        const errCode = asInt(pake.ErrCode);
        if (errCode === 1) throw new Error("Incorrect code");
        if (errCode !== 0 && errCode !== undefined) throw new Error(`verification error ${pake.ErrCode}`);

        const hamk = await session.computeHMAC(m);
        if (!constantTimeEqual(session.deserialize(pake.HAMK), hamk))
          throw new Error("server HAMK mismatch");

        this._setState(State.Unlocked);
      } catch (e) {
        // helper burns the challenge on a failed verify, drop it so the next attempt gets a fresh prompt
        session.sharedKey = undefined;
        session.serverPublicKey = undefined;
        session.salt = undefined;
        this._challengeAt = 0;
        throw e;
      }
    });
  }

  async _encryptedQuery(cmd, tabId, hostname, payloadBody, timeoutMs, frameId = 0) {
    const session = this._liveSession();
    const sdata = session.serialize(await session.encrypt(payloadBody));
    /** @type {Record<string, any>} */
    const body = {
      tabId,
      frameId,
      payload: { QID: QueryId[cmd], SMSG: JSON.stringify({ TID: session.username, SDATA: sdata }) },
    };
    // one-time-code queries carry their URLs inside the encrypted body
    if (hostname != null) body.url = hostname;
    const reply = await this._send(cmd, body, timeoutMs);

    let smsg = reply.payload.SMSG;
    if (typeof smsg === "string") smsg = JSON.parse(smsg);
    if (smsg.TID !== session.username) throw new Error("response for another session");
    const data = await session.decrypt(session.deserialize(smsg.SDATA));
    return JSON.parse(bytesToUtf8(data));
  }

  async getLoginNamesForURL(tabId, url) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_LOGIN_NAMES_FOR_URL,
        tabId,
        hostname,
        { ACT: Action.GHOST_SEARCH, URL: hostname },
        5000,
      );
      if (res.STATUS === QueryStatus.Success)
        return (res.Entries ?? []).map((e) => ({ username: e.USR, sites: e.sites }));
      if (res.STATUS === QueryStatus.NoResults) return [];
      throw queryStatusError(res.STATUS);
    });
  }

  async getPasswordForLoginName(tabId, url, loginName, queryUrl, envelopeUrl) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    // encrypted URL is the page host, a path, or a website the helper listed for this frame.
    // envelopeUrl is the outer message url. Apple sets that to the record's first website.
    const searchUrl = queryUrl || hostname;
    const outerUrl = envelopeUrl || hostname;
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_PASSWORD_FOR_LOGIN_NAME,
        tabId,
        outerUrl,
        { ACT: Action.SEARCH, URL: searchUrl, USR: loginName.username },
        USER_AUTH_TIMEOUT_MS, // the helper may wait on Touch ID here
      );
      if (res.STATUS === QueryStatus.Success) {
        const e = (res.Entries ?? [])[0];
        if (!e) return undefined;
        // reply is USR/PWD/customTitle/highLevelDomain/sites, no note or OTP seed
        return { username: e.USR, password: e.PWD, sites: e.sites };
      }
      if (res.STATUS === QueryStatus.NoResults) return undefined;
      throw queryStatusError(res.STATUS);
    });
  }

  // ACT maybeAdd lets the helper decide add-vs-update and drive the native save prompt
  async saveLogin(tabId, url, username, password) {
    if (!this.ready) throw new Error("not unlocked");
    if (!password) throw new Error("no password to save");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const session = this._liveSession();
      const sdata = session.serialize(
        await session.encrypt({
          ACT: Action.MAYBE_ADD,
          URL: "",
          USR: "",
          PWD: "",
          NURL: hostname,
          NUSR: username ?? "",
          NPWD: password,
        }),
      );
      const body = {
        tabId,
        frameId: 0,
        payload: {
          QID: "CmdNewAccount4URL",
          SMSG: JSON.stringify({ TID: session.username, SDATA: sdata }),
        },
      };
      // ack is empty and confirmation happens in the native prompt, so a slow ack is not an error
      try {
        await this._send(Command.SET_PASSWORD_FOR_LOGIN_NAME_URL, body, 3000);
      } catch (e) {
        if (!/timeout/i.test(String(e?.message ?? e))) throw e;
      }
      return true;
    });
  }

  async getOneTimeCodes(tabId, frameId, frameUrls, username) {
    if (!this.ready) throw new Error("not unlocked");
    if (!this.canFillOneTimeCodes) return { entries: [], requiresAuth: false };
    const body = { ACT: Action.GHOST_SEARCH, TYPE: "oneTimeCodes", frameURLs: frameUrls };
    if (username) body.username = username;
    return this._withLock(async () => {
      const res = await this._encryptedQuery(Command.GET_ONE_TIME_CODES, tabId, null, body, 8000, frameId);
      const requiresAuth = !!res.RequiresUserAuthenticationToFill;
      if (res.STATUS === QueryStatus.Success) return { entries: normalizeOtpEntries(res.Entries), requiresAuth };
      if (res.STATUS === QueryStatus.NoResults) return { entries: [], requiresAuth };
      throw queryStatusError(res.STATUS);
    });
  }

  // read at pick time so a code listed earlier isnt filled after it rotated. may wait on Touch ID
  async readOneTimeCode(tabId, frameId, frameUrls, username) {
    if (!this.ready) throw new Error("not unlocked");
    const body = { ACT: Action.SEARCH, TYPE: "oneTimeCodes", frameURLs: frameUrls };
    if (username) body.username = username;
    return this._withLock(async () => {
      const res = await this._encryptedQuery(Command.DID_FILL_ONE_TIME_CODE, tabId, null, body, USER_AUTH_TIMEOUT_MS, frameId);
      if (res.STATUS === QueryStatus.Success) return normalizeOtpEntries(res.Entries);
      if (res.STATUS === QueryStatus.NoResults) return [];
      throw queryStatusError(res.STATUS);
    });
  }

  /** @param {{ searchUrl?: string, newPasswordUrl?: string, totpUri?: string, totpPageUrl?: string }} [opts] */
  launchPasswordsApp({ searchUrl, newPasswordUrl, totpUri, totpPageUrl } = {}) {
    if (!this.port) throw new Error("not connected");
    const msg = { cmd: Command.LAUNCH_PASSWORDS_APP };
    if (totpUri) {
      if (!this.canSetUpTotp) throw new Error("this helper cant set up verification codes");
      msg.setUpTOTPURI = totpUri;
      if (totpPageUrl) msg.setUpTOTPPageURL = totpPageUrl;
    } else if (newPasswordUrl) {
      if (!this.canOpenPasswordsAppToNewPasswordSheet) throw new Error("this helper cant open the new-password sheet");
      msg.newPasswordWithSuggestedURL = newPasswordUrl;
    } else if (searchUrl) {
      msg.searchQueryURL = searchUrl;
    }
    this.port.postMessage(msg);
  }

  disconnect() {
    if (!this.port) return;
    try {
      this.port.postMessage({ cmd: Command.END });
    } catch (_) {}
    try {
      this.port.disconnect();
    } catch (_) {}
    this.port = undefined;
    this.session = undefined;
    this._rejectWaiters("connection closed");
    this._setState(State.Disconnected);
  }
}
