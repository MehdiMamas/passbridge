// ApplePasswords-shaped stand-in. The harness writes MOCK_KIND; it does not patch background.js.

const FIXTURES = {
  unlocked: [{ username: "test@example.com", sites: [] }],
  multi: [
    { username: "alice@example.com", sites: [] },
    { username: "bob@work.com", sites: [] },
  ],
  locked: [],
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
  { source: "totp", username: "test@example.com", domain: "instagram.example", code: "135790" },
  { source: "sms", username: "", domain: "", code: "975318" },
];

export function createMockClient(kind) {
  const startsLocked = kind === "locked" || kind === "pinflow";
  const listeners = [];
  const client = {
    state: startsLocked ? "needs_pin" : "unlocked",
    ready: !startsLocked,
    hasChallenge: startsLocked,
    canFillOneTimeCodes: kind === "otp",
    canOpenPasswordsAppToNewPasswordSheet: false,
    canSetUpTotp: false,
    capabilities: {},
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
    async getLoginNamesForURL() {
      if (!client.ready) throw new Error("locked");
      return FIXTURES[kind] || [];
    },
    async getPasswordForLoginName(_tabId, _url, login) {
      return { username: login?.username || "test@example.com", password: "TestPass123" };
    },
    async getOneTimeCodes() {
      if (kind !== "otp") return { entries: [], requiresAuth: false };
      return { entries: OTP_ROWS.map((row) => ({ ...row })), requiresAuth: false };
    },
    async readOneTimeCode() {
      return OTP_ROWS.map((row) => ({ ...row }));
    },
    async requestChallenge() {
      client.state = "needs_pin";
      client.ready = false;
      client.hasChallenge = true;
      return client.state;
    },
    async verifyPin(pin) {
      if (pin === "123456") {
        client.ready = true;
        client.state = "unlocked";
        client.hasChallenge = false;
        listeners.forEach((fn) => fn(client.state));
        return;
      }
      const err = new Error("Incorrect code");
      err.code = "challenge_reissued";
      client.hasChallenge = true;
      client.state = "needs_pin";
      throw err;
    },
    async saveLogin() {},
    launchPasswordsApp() {},
  };
  return client;
}
