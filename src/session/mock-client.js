// ApplePasswords-shaped stand-in. The harness writes MOCK_KIND; it does not patch background.js.
import { INCORRECT_CODE } from "../apple/protocol.ts";

/** @type {Record<string, { username: string, sites: string[] }[]>} */
const FIXTURES = {
  unlocked: [{ username: "test@example.com", sites: [] }],
  multi: [
    { username: "alice@example.com", sites: [] },
    { username: "bob@work.com", sites: [] },
  ],
  passkeys: [{ username: "test@example.com", sites: [] }],
  locked: [],
  empty: [],
  nohelper: [],
  pinflow: [{ username: "test@example.com", sites: [] }],
  otp: [{ username: "test@example.com", sites: [] }, { username: "alice@example.com", sites: [] }],
  many: [
    { username: "alice@example.com", sites: ["https://account.riotgames.com"] },
    { username: "bob@work.com", sites: [] },
    { username: "mehdi.one@example.com", sites: [] },
    { username: "mehdi.two@example.com", sites: [] },
    { username: "carol@example.com", sites: [] },
    { username: "dave@example.com", sites: [] },
    { username: "erin@example.com", sites: [] },
    { username: "frank@example.com", sites: [] },
    { username: "gina@example.com", sites: [] },
    { username: "hank@example.com", sites: [] },
    { username: "iris@example.com", sites: [] },
    { username: "jake@example.com", sites: [] },
  ],
};

const OTP_ROWS = [
  { source: "totp", username: "alice@example.com", domain: "acme.example", code: "246810" },
  { source: "totp", username: "synthetic.two@example.test", domain: "acme.example", code: "864209" },
  { source: "totp", username: "test@example.com", domain: "instagram.example", code: "135790" },
  { source: "totp", username: "panel@example.com", domain: "127.0.0.1.nip.io", code: "112233" },
  { source: "sms", username: "", domain: "", code: "975318" },
];

/** @param {string} u */
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

// harness hosts stand in for real sites, so they see every row
/** @param {string} h */
const isHarnessHost = (h) =>
  !h || h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".test");

/** @param {string[] | null | undefined} frameUrls */
const otpRowsFor = (frameUrls) => {
  const hosts = (frameUrls || []).map(hostOf);
  if (hosts.some(isHarnessHost)) return OTP_ROWS;
  return OTP_ROWS.filter((row) => !row.domain || hosts.some((h) => h === row.domain || h.endsWith("." + row.domain)));
};

// saved logins per host, so a login saved for one site is read back for that site (passkey records need their own password)
/** @param {string} u */
const hostKey = (u) => hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(u)) ? u : `https://${u}`);

/** @param {string} [kind] */
export function createMockClient(kind) {
  const startsLocked = kind === "locked" || kind === "pinflow";
  /** @type {((state: string) => void)[]} */
  const listeners = [];
  /** @type {{ username: string, sites: string[] }[]} */
  const added = [];
  const byHost = new Map();
  const client = {
    state: kind === "nohelper" ? "no_helper" : startsLocked ? "needs_pin" : "unlocked",
    ready: !startsLocked && kind !== "nohelper",
    hasChallenge: startsLocked,
    canFillOneTimeCodes: kind === "otp",
    canOpenPasswordsAppToNewPasswordSheet: false,
    canSetUpTotp: false,
    capabilities: {},
    /** @param {(state: string) => void} fn */
    onStateChange(fn) {
      listeners.push(fn);
    },
    onOneTimeCodeAvailable() {},
    async connect() {
      if (client.state === "disconnected") {
        client.state = startsLocked ? "needs_pin" : "unlocked";
        client.ready = !startsLocked;
      }
    },
    disconnect() {
      client.state = "disconnected";
      client.ready = false;
    },
    /**
     * @param {unknown} _tabId
     * @param {string} url
     */
    async getLoginNamesForURL(_tabId, url) {
      if (!client.ready) throw new Error("locked");
      if (url && /(^|\/\/)passkeys\.passbridge\.invalid/.test(String(url))) return (byHost.get(hostKey(url)) || []).map((/** @type {any} */ e) => ({ username: e.username, sites: [] }));
      return [...(FIXTURES[/** @type {string} */ (kind)] || []), ...added];
    },
    /**
     * @param {unknown} _tabId
     * @param {string} url
     * @param {{ username?: string } | null | undefined} login
     * @param {string} [queryUrl]
     */
    async getPasswordForLoginName(_tabId, url, login, queryUrl) {
      const saved = (byHost.get(hostKey(queryUrl || url)) || []).find((/** @type {any} */ e) => e.username === login?.username);
      if (saved) return { username: saved.username, password: saved.password, ...(/** @type {any} */ (globalThis).__mockVerified ? { verified: true } : {}) };
      return { username: login?.username || "test@example.com", password: "TestPass123" };
    },
    /**
     * @param {unknown} _tabId
     * @param {unknown} _frameId
     * @param {string[]} frameUrls
     */
    async getOneTimeCodes(_tabId, _frameId, frameUrls) {
      if (kind !== "otp") return { entries: [], requiresAuth: false };
      return { entries: otpRowsFor(frameUrls).map((row) => ({ ...row })), requiresAuth: false };
    },
    /**
     * @param {unknown} _tabId
     * @param {unknown} _frameId
     * @param {string[]} frameUrls
     */
    async readOneTimeCode(_tabId, _frameId, frameUrls) {
      return otpRowsFor(frameUrls).map((row) => ({ ...row }));
    },
    async requestChallenge() {
      client.state = "needs_pin";
      client.ready = false;
      client.hasChallenge = true;
      return client.state;
    },
    /** @param {string} pin */
    async verifyPin(pin) {
      if (pin === "123456") {
        client.ready = true;
        client.state = "unlocked";
        client.hasChallenge = false;
        listeners.forEach((fn) => fn(client.state));
        return;
      }
      const err = /** @type {Error & { code?: string }} */ (new Error(INCORRECT_CODE));
      err.code = "challenge_reissued";
      client.hasChallenge = true;
      client.state = "needs_pin";
      throw err;
    },
    /**
     * @param {unknown} tabId
     * @param {string} url
     * @param {string} username
     * @param {string} password
     */
    async saveLogin(tabId, url, username, password) {
      // lets a driver read what would have gone to Apple's sheet
      (/** @type {any} */ (globalThis).__mockSaved ||= []).push({ url, username, password });
      added.push({ username, sites: [] });
      const key = hostKey(url);
      byHost.set(key, [...(byHost.get(key) || []).filter((/** @type {any} */ e) => e.username !== username), { username, password }]);
    },
    /** @param {unknown} args */
    launchPasswordsApp(args) {
      (/** @type {any} */ (globalThis).__mockLaunched ||= []).push(args);
    },
  };
  return client;
}
