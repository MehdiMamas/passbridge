import { ApplePasswords, Command, normalizeOtpEntries } from "../../src/apple/protocol.js";
import { otpAuthSecret, parseOtpAuth } from "../../src/otpauth.js";
import { generateApplePassword } from "../../src/password-generate.js";
import { hostsRelated, passwordSearchSteps } from "../../src/session/password-search.js";
import { registrableDomain, siteLookupHosts } from "../../src/session/site-domain.js";
import { orderByPageUsername, usernameMatchesPage } from "../../src/session/username-match.js";
import { frameUrlsFor } from "../../src/session/frame-urls.js";
import { createLimiter, handleAgentRequest, hostAllowed, pickAllowedFrames, sanitizeReply } from "../../src/agent.js";
import { reportIssueUrl, reportText, scrubAttr, scrubText, scrubUrl } from "../../src/report-scrub.js";
import { UPDATE_CHECK_MS, availableUpdate, checkForUpdate, dismissUpdate, isNewerVersion } from "../../src/update-check.js";
import { REPLACED_EVENT, createLifecycle, isInvalidated, reinjectContentScripts } from "../../src/reload-recovery.js";
import { digestHex, verifyRelease } from "../../src/update-verify.js";
import { downloadRelease, latestRelease } from "../../src/update-release.js";
import { installUpdate } from "../../src/update-install.js";
import { manifestProblem, readZip } from "../../src/update-zip.js";
import { applyUpdate, hasInterruptedUpdate, isOwnFolder, recoverUpdate, setUpdating } from "../../src/update-files.js";
import { folderForUpdate, pickFolder } from "../../src/update-folder.js";

let failed = 0;
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

{
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const b64 = async (k) => Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64");
  const zip = new TextEncoder().encode("pretend zip bytes");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, zip));
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex");
  const key = await b64(kp);
  ok("verify: a good signature and digest pass", (await verifyRelease(zip, sig, hex, key)) === true);
  const bad = sig.slice();
  bad[0] ^= 1;
  ok("verify: a flipped signature bit fails", (await verifyRelease(zip, bad, hex, key)) === false);
  ok("verify: a changed zip fails", (await verifyRelease(new TextEncoder().encode("pretend zip bytez"), sig, hex, key)) === false);
  ok("verify: a wrong digest fails", (await verifyRelease(zip, sig, "0".repeat(64), key)) === false);
  ok("verify: a missing digest fails", (await verifyRelease(zip, sig, "", key)) === false);
  ok("verify: a signature from another key fails", (await verifyRelease(zip, sig, hex, await b64(other))) === false);
  ok("verify: an empty pinned key always fails", (await verifyRelease(zip, sig, hex, "")) === false);
  ok("verify: the shipped key rejects a signature made by a test key", (await verifyRelease(zip, sig, hex)) === false);
  ok("verify: a short signature fails", (await verifyRelease(zip, sig.slice(0, 63), hex, key)) === false);
  ok("verify: a garbage key fails without throwing", (await verifyRelease(zip, sig, hex, "!!!")) === false);
  ok("verify: digest field parsing", digestHex("sha256:" + hex) === hex && digestHex(undefined) === null && digestHex("sha1:abc") === null);
}

ok("report: query values and fragments are dropped, keys stay", scrubUrl("https://idmsa.apple.com/signin?widgetKey=abc&lang=en#x") === "https://idmsa.apple.com/signin?widgetKey=…&lang=…#…");
ok("report: a relative link keeps its path", scrubUrl("/olympus/v1/terms/ASC?t=1") === "/olympus/v1/terms/ASC?t=…");
ok("report: long data URIs are cut", scrubUrl(`data:image/png;base64,${"A".repeat(500)}`).endsWith("[data removed]"));
ok("report: emails are replaced in text", scrubText("signed in as jane.doe+x@gmail.com") === "signed in as [email]");
ok("report: an email in a path is replaced", scrubUrl("https://mail.example.com/u/jane@example.com/") === "https://mail.example.com/u/[email]/");
ok("report: long tokens in attributes are replaced, short words stay", scrubAttr(`login-form ${"a1B2".repeat(10)}`) === "login-form [token]");
{
  const rep = { url: "https://appstoreconnect.apple.com/login", version: "9.9.9", browser: "x", createdAt: "2026-10-25T00:00:00Z",
    frames: [{ top: true, url: "https://appstoreconnect.apple.com/login", safe: true, fields: [], html: "<html></html>" },
      { top: false, url: "https://idmsa.apple.com/appleauth/auth/signin", safe: false, fields: [{ tag: "input", type: "text", name: "", id: "account_name_text_field", autocomplete: "", visible: true, login: true, otp: false }], html: "<html>x</html>" }] };
  const url = new URL(reportIssueUrl(rep, "no menu"));
  ok("report: the issue goes to the PassBridge repo", url.origin + url.pathname === "https://github.com/MehdiMamas/passbridge/issues/new");
  ok("report: the issue body names the untrusted frame", (url.searchParams.get("body") || "").includes("idmsa.apple.com/appleauth/auth/signin · PassBridge stays silent"));
  ok("report: the file carries each frame's HTML", reportText(rep).includes("<html>x</html>") && reportText(rep).includes("account_name_text_field"));
}

const moodle = "moodle.augustana.edu";
const google = "accounts.google.com";
const moodleSteps = passwordSearchSteps(moodle, [google, moodle]);
ok(
  "multi-site login retries the record's first website then its other hosts",
  moodleSteps.map((s) => `${s.envelope}|${s.search}`).join(",") ===
    `${moodle}|${moodle},${google}|${moodle},${google}|${google}`,
);
ok(
  "a host the helper did not return is not queried",
  moodleSteps.every((s) => s.search === moodle || s.search === google) &&
    moodleSteps.every((s) => s.envelope === moodle || s.envelope === google),
);
ok("parent of the page host still matches", hostsRelated("login.augustana.edu", "augustana.edu"));
ok("an unrelated extra website is not a parent or child", !hostsRelated(moodle, google));
const childSteps = passwordSearchSteps("login.augustana.edu", ["augustana.edu"]);
ok(
  "parent host is searched with the frame as the outer url after the record's own sites",
  childSteps.some((s) => s.envelope === "login.augustana.edu" && s.search === "augustana.edu") &&
    childSteps.some((s) => s.envelope === "augustana.edu" && s.search === "login.augustana.edu"),
);

ok("a subdomain also looks up its site", siteLookupHosts("account.apple.com").join(",") === "account.apple.com,apple.com");
ok("deep subdomains walk up to the site and stop", siteLookupHosts("a.b.example.com").join(",") === "a.b.example.com,b.example.com,example.com");
ok("a site host looks up only itself", siteLookupHosts("apple.com").join(",") === "apple.com");
ok("never save on a subdomain covers the whole site", registrableDomain("login.example.com") === "example.com" && registrableDomain("www.example.com") === "example.com");
ok("a two-label public suffix is never queried", siteLookupHosts("account.bbc.co.uk").join(",") === "account.bbc.co.uk,bbc.co.uk" && registrableDomain("bbc.co.uk") === "bbc.co.uk");
ok("an IP address is not split", siteLookupHosts("192.168.1.10").join(",") === "192.168.1.10");
const viaSteps = passwordSearchSteps("account.apple.com", ["apple.com"], undefined, "apple.com");
ok(
  "a login listed under the parent site is searched there first",
  viaSteps[0].search === "apple.com" && viaSteps[0].envelope === "apple.com" &&
    viaSteps[1].search === "apple.com" && viaSteps[1].envelope === "account.apple.com",
);

const otp = parseOtpAuth("otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
ok("otpauth keeps issuer and account and hides the secret from the label", otp?.issuer === "GitHub" && otp?.account === "alice@example.com" && !("secret" in otp));
ok("setup key is the base32 secret without padding", otpAuthSecret(otp.uri) === "JBSWY3DPEHPK3PXP" && otpAuthSecret("otpauth://totp/Work?secret=JBSWY3DPEHPK3PXP====") === "JBSWY3DPEHPK3PXP");
ok("a non-setup link has no setup key", otpAuthSecret("https://example.com/?secret=JBSWY3DPEHPK3PXP") === "");
ok("wifi and migration QR codes are not setup links", parseOtpAuth("WIFI:S:cafe;T:WPA;P:secret;;") === null && parseOtpAuth("otpauth-migration://offline?data=abc") === null);
ok("a grouped setup key with spaces is accepted", otpAuthSecret("otpauth://totp/Work?secret=JBSW%20Y3DP%20EHPK%203PXP") === "JBSWY3DPEHPK3PXP");
ok("apple-otpauth totp is accepted", parseOtpAuth("apple-otpauth://totp/Work?secret=JBSWY3DPEHPK3PXP&issuer=Work")?.account === "Work");
const [scanned, synced] = normalizeOtpEntries([
  { source: "totp", domain: "7E8A4488-FB35-4AC8-B885-3CB52740EFBB", customTitle: "Cashapp", username: "a" },
  { source: "totp", domain: "github.com", customTitle: "GitHub", username: "b" },
]);
ok("a code keyed by a record id is labelled with its title, a real domain is kept", scanned.domain === "Cashapp" && synced.domain === "github.com");
const generated = generateApplePassword();
ok("generated password is three hyphenated groups", /^[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/.test(generated));

// a fake native port: the helper never answers until the test says so
function fakeNative() {
  const port = { sent: [], msg: [], gone: [], disconnected: false };
  port.postMessage = (m) => port.sent.push(m);
  port.disconnect = () => { port.disconnected = true; };
  port.onMessage = { addListener: (fn) => port.msg.push(fn) };
  port.onDisconnect = { addListener: (fn) => port.gone.push(fn) };
  port.reply = (m) => port.msg.forEach((fn) => fn(m));
  port.drop = () => port.gone.forEach((fn) => fn());
  return port;
}
async function settles(promise) {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return `rejected: ${e.message}`;
  }
}
async function connectedClient() {
  const port = fakeNative();
  globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  const client = new ApplePasswords();
  const connecting = client.connect();
  port.reply({ cmd: Command.GET_CAPABILITIES, capabilities: {} });
  await connecting;
  return { client, port };
}
{
  const port = fakeNative();
  globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  const client = new ApplePasswords();
  const connecting = client.connect();
  port.drop();
  ok("a helper that exits mid-request rejects the request", (await settles(connecting)) === "rejected: connection closed" && client._waiters.size === 0);
}
{
  const { client } = await connectedClient();
  // no timeout, the way a Touch ID read used to wait
  const stuck = client._withLock(() => client._send(Command.GET_PASSWORD_FOR_LOGIN_NAME, {}, null));
  await Promise.resolve();
  client.disconnect();
  const next = client._withLock(async () => "ran");
  ok("disconnect rejects the pending read and frees the lock", (await settles(stuck)) === "rejected: connection closed" && (await next) === "ran");
}
{
  const { client, port } = await connectedClient();
  const stuck = client._send(Command.GET_LOGIN_NAMES_FOR_URL, {}, null);
  client._dropNativePort();
  ok("a dropped session rejects the pending request", (await settles(stuck)) === "rejected: connection closed" && port.disconnected);
}
delete globalThis.chrome;

ok(
  "a site lookup carries only its own url",
  JSON.stringify(frameUrlsFor({ url: "https://acme.example/" })) === '["https://acme.example/"]',
);
ok(
  "an inline frame still carries its tab's url",
  JSON.stringify(frameUrlsFor({ url: "https://login.acme.example/frame", tab: { url: "https://acme.example/" } })) ===
    '["https://login.acme.example/frame","https://acme.example/"]',
);
ok(
  "a chrome url is never asked of the helper",
  frameUrlsFor({ url: "chrome://extensions/", tab: { url: "https://acme.example/" } }).length === 1,
);

ok("username matcher: case-insensitive exact", usernameMatchesPage("Me@Gmail.com", " me@gmail.com "));
ok("username matcher: bare name matches by local part", usernameMatchesPage("me", "me@gmail.com") && usernameMatchesPage("me@gmail.com", "me"));
ok("username matcher: different domains do not match", !usernameMatchesPage("me@a.com", "me@b.com"));
ok("username matcher: empty never matches", !usernameMatchesPage("", "me") && !usernameMatchesPage("me", ""));
ok(
  "matching login is ordered first, others keep order",
  orderByPageUsername([{ username: "a@x.com" }, { username: "me@gmail.com" }, { username: "b@x.com" }], "ME@gmail.com")
    .map((l) => l.username)
    .join() === "me@gmail.com,a@x.com,b@x.com",
);
ok("no match keeps the order", orderByPageUsername([{ username: "a" }, { username: "b" }], "zzz")[0].username === "a");

const agentList = ["github.com", "google.com"];
ok("agent: the exact host is allowed", hostAllowed("github.com", agentList));
ok("agent: a subdomain is allowed", hostAllowed("gist.github.com", agentList));
ok("agent: github.com.evil.io is refused", !hostAllowed("github.com.evil.io", agentList));
ok("agent: evilgithub.com is refused", !hostAllowed("evilgithub.com", agentList));
ok("agent: an empty allowlist refuses everything", !hostAllowed("github.com", []));
{
  const lim = createLimiter(3, 1000);
  ok("agent: rate limiter allows up to the max", lim.take(0) && lim.take(1) && lim.take(2));
  ok("agent: rate limiter refuses the next", !lim.take(3));
  ok("agent: rate limiter frees up after the window", lim.take(1001));
}
{
  const dirty = { ok: true, password: "p", code: "123456", nested: { Password: "x", list: [{ otp: "1", username: "me" }], domain: "a.com" } };
  const clean = sanitizeReply(dirty);
  ok("agent: sanitizer drops password and code at any depth", !JSON.stringify(clean).match(/password|"code"|otp|"p"|123456/i));
  ok("agent: sanitizer keeps usernames and domains", clean.nested.list[0].username === "me" && clean.nested.domain === "a.com");
}
{
  const deps = (over = {}) => ({
    client: { ready: true },
    getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"] }),
    getTab: async () => ({ id: 1, url: "https://github.com/login" }),
    hostnameOf: (u) => new URL(u).hostname,
    isFillUrlAllowed: async () => true,
    siteLogins: async () => [{ username: "a@x.com" }, { username: "b@x.com" }],
    uniqueByUsername: (l) => l,
    fillLoginOnTab: async (tab, username) => ({ filled: true, username, password: "leak" }),
    ...over,
  });
  const run = (msg, d = deps(), lim = createLimiter()) => handleAgentRequest(msg, d, lim);
  ok("agent: disabled refuses", (await run({ op: "logins", tabId: 1 }, deps({ getSettings: async () => ({ agentSignIn: false }) }))).reply.error === "not_enabled");
  ok("agent: a host off the list is not_allowed", (await run({ op: "logins", tabId: 1 }, deps({ getTab: async () => ({ id: 1, url: "https://github.com.evil.io/" }) }))).reply.error === "not_allowed");
  ok("agent: a missing tab is no_tab", (await run({ op: "logins", tabId: 9 }, deps({ getTab: async () => { throw new Error("x"); } }))).reply.error === "no_tab");
  ok("agent: several logins need a choice", (await run({ op: "sign_in", tabId: 1 })).reply.error === "choose_login");
  const r = await run({ op: "sign_in", tabId: 1, username: "B@x.com" });
  ok("agent: sign_in replies domain and username only", r.reply.ok && r.reply.username === "b@x.com" && r.reply.domain === "github.com" && !("password" in r.reply));
  ok("agent: an unpaired client is needs_user", (await run({ op: "sign_in", tabId: 1, username: "a@x.com" }, deps({ client: { ready: false } }))).reply.error === "needs_user");
  ok("agent: a refused read is needs_user", (await run({ op: "sign_in", tabId: 1, username: "a@x.com" }, deps({ fillLoginOnTab: async () => { throw new Error("timeout"); } }))).reply.error === "needs_user");
  const lim = createLimiter(1, 1000);
  await run({ op: "sign_in", tabId: 1, username: "a@x.com" }, deps(), lim);
  ok("agent: the second fill in the window is rate_limited", (await run({ op: "sign_in", tabId: 1, username: "a@x.com" }, deps(), lim)).reply.error === "rate_limited");
  ok("agent: fill_code is gone", (await run({ op: "fill_code", tabId: 1 })).reply.error === "unknown_op");
  const fr = pickAllowedFrames(
    [
      { frameId: 0, url: "https://account.apple.com/" },
      { frameId: 3, url: "https://idmsa.apple.com/appleauth" },
      { frameId: 4, url: "https://apple.com.evil.io/x" },
      { frameId: 5, url: "https://evilapple.com/" },
    ],
    ["apple.com"],
    (u) => new URL(u).hostname,
  );
  ok("agent: frame choice keeps allowlisted subdomain frames only", fr.length === 1 && fr[0].frameId === 3 && fr[0].host === "idmsa.apple.com");
  ok("agent: status reports pairing without a tab", (await run({ op: "status" })).paired === true);
}
ok("update: a higher release tag is newer", isNewerVersion("v1.4.0", "1.3.1") && isNewerVersion("1.3.10", "1.3.9"));
ok("update: the same or an older release is not newer", !isNewerVersion("v1.3.1", "1.3.1") && !isNewerVersion("1.3", "1.3.0") && !isNewerVersion("v1.2.9", "1.3.0"));
ok("update: a tag that is no version is never newer", !isNewerVersion("desktop-preview", "1.3.1") && !isNewerVersion(undefined, "1.3.1"));

// chrome.storage.local in memory, callback and promise forms, plus a fetch that counts its calls
const realFetch = globalThis.fetch;
function fakeUpdateEnv(seed = {}, reply = { ok: true, json: async () => ({ tag_name: "v1.4.0" }) }) {
  const data = { ...seed };
  const pick = (keys) => {
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    return { ...keys, ...data };
  };
  const local = {
    get: (keys, cb) => (cb ? cb(pick(keys)) : Promise.resolve(pick(keys))),
    set: (o, cb) => {
      Object.assign(data, o);
      cb?.();
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of [keys].flat()) delete data[k];
      return Promise.resolve();
    },
  };
  globalThis.chrome = { storage: { local }, runtime: { lastError: undefined } };
  const env = { data, fetched: [] };
  globalThis.fetch = async (url) => {
    env.fetched.push(String(url));
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return env;
}
const NOW = Date.UTC(2026, 9, 25);
{
  const env = fakeUpdateEnv();
  await checkForUpdate(NOW);
  ok("update: a first check asks GitHub for the latest release", env.fetched.join() === "https://api.github.com/repos/MehdiMamas/passbridge/releases/latest");
  ok("update: the check keeps the tag and the time", env.data.latestRelease === "v1.4.0" && env.data.updateCheckedAt === NOW);
  const update = await availableUpdate("1.3.1");
  ok("update: a newer release is offered with its release page", update?.version === "1.4.0" && update?.url === "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.0");
  ok("update: the installed version is not offered", (await availableUpdate("1.4.0")) === null);
  await dismissUpdate();
  ok("update: a dismissed release is not offered again", (await availableUpdate("1.3.1")) === null);
  env.data.latestRelease = "v1.5.0";
  ok("update: a release after the dismissed one is offered", (await availableUpdate("1.3.1"))?.version === "1.5.0");
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW - UPDATE_CHECK_MS + 60_000 });
  await checkForUpdate(NOW);
  ok("update: no second request inside a day", env.fetched.length === 0);
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW - 60_000 });
  const reached = await checkForUpdate(NOW, { force: true });
  ok("update: force skips the daily wait", env.fetched.length === 1 && reached === true && env.data.updateCheckedAt === NOW);
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW - 60_000 });
  const reached = await checkForUpdate(NOW, { force: false });
  ok("update: without force the daily wait still applies", env.fetched.length === 0 && reached === false);
}
{
  const env = fakeUpdateEnv({ canCheckForUpdates: false, updateCheckedAt: 0 });
  await checkForUpdate(NOW, { force: true });
  ok("update: force still respects the setting", env.fetched.length === 0);
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW + 3_600_000 });
  await checkForUpdate(NOW);
  ok("update: a check stamped in the future does not block forever", env.fetched.length === 1);
}
{
  const env = fakeUpdateEnv({ canCheckForUpdates: false, latestRelease: "v1.4.0" });
  await checkForUpdate(NOW);
  ok("update: turned off, nothing is requested", env.fetched.length === 0);
  ok("update: turned off, nothing is offered", (await availableUpdate("1.3.1")) === null);
}
{
  const env = fakeUpdateEnv({}, new Error("offline"));
  await checkForUpdate(NOW);
  ok("update: a failed request is retried on the next alarm", env.data.updateCheckedAt === undefined);
}
{
  const env = fakeUpdateEnv({ latestRelease: "v1.4.0" }, { ok: false, status: 403, json: async () => ({ message: "rate limited" }) });
  await checkForUpdate(NOW);
  ok("update: a refused request waits a day and keeps the last tag", env.data.updateCheckedAt === NOW && env.data.latestRelease === "v1.4.0");
}
{
  const env = fakeUpdateEnv();
  await Promise.all([checkForUpdate(NOW), checkForUpdate(NOW)]);
  ok("update: overlapping checks share one request", env.fetched.length === 1);
}
{
  fakeUpdateEnv();
  // what chrome answers while the worker is shutting down for a reload
  globalThis.chrome.storage.local.get = (keys, cb) => (cb ? cb({}) : Promise.reject(new Error("No SW")));
  ok("update: a check while the worker shuts down settles quietly", (await settles(checkForUpdate(NOW))) === "resolved");
}

function fakePage() {
  const win = new EventTarget();
  const hosts = [{ removed: false, remove() { this.removed = true; } }, { removed: false, remove() { this.removed = true; } }];
  win.document = { querySelectorAll: () => hosts };
  return { win, hosts };
}
{
  const { win, hosts } = fakePage();
  const runtime = { id: "abc" };
  const life = createLifecycle({ win, runtime });
  let fired = 0;
  life.listen(win, "ping", () => fired++);
  let cleaned = 0;
  life.onTeardown(() => cleaned++);
  win.dispatchEvent(new Event("ping"));
  ok("lifecycle: a fresh copy is alive and keeps its own listeners", life.alive() && !life.isDead() && fired === 1);
  ok("lifecycle: invalidated errors are recognised", isInvalidated(new Error("Extension context invalidated.")) && !isInvalidated(new Error("boom")));
  life.noteError(new Error("boom"));
  ok("lifecycle: an unrelated error leaves the copy running", !life.isDead());
  delete runtime.id;
  ok("lifecycle: a dead runtime id means not alive", life.alive() === false);
  life.noteError(new Error("Extension context invalidated."));
  win.dispatchEvent(new Event("ping"));
  ok("lifecycle: teardown removes injected hosts, runs cleanups and drops listeners", life.isDead() && hosts.every((h) => h.removed) && cleaned === 1 && fired === 1);
  life.teardown();
  ok("lifecycle: a second teardown is harmless", cleaned === 1);
  let late = 0;
  life.listen(win, "ping", () => late++);
  win.dispatchEvent(new Event("ping"));
  ok("lifecycle: nothing is registered after teardown", late === 0);
}
{
  const { win, hosts } = fakePage();
  const old = createLifecycle({ win, runtime: { id: "abc" } });
  ok("lifecycle: the first copy does not tear itself down", !old.isDead());
  const fresh = createLifecycle({ win, runtime: { id: "abc" } });
  ok("lifecycle: a newer copy replaces the older one", old.isDead() && hosts.every((h) => h.removed));
  ok("lifecycle: the newer copy survives its own event", !fresh.isDead() && fresh.alive());
  ok("lifecycle: the replaced event name is stable", REPLACED_EVENT === "passbridge:replaced");
}
{
  const calls = [];
  const runtime = { getManifest: () => ({ content_scripts: [{ js: ["src/content.js"] }] }) };
  const tabs = { query: async (q) => (calls.push(["query", q]), [{ id: 1, url: "https://a.test/" }, { id: 2, url: "https://locked.test/" }, { id: 3, url: "http://b.test/" }, { url: "https://noid.test/" }]) };
  const scripting = {
    executeScript: async (o) => {
      calls.push(["inject", o.target.tabId, o.target.allFrames, o.files]);
      if (o.target.tabId === 2) throw new Error("Cannot access contents of the page");
    },
  };
  const n = await reinjectContentScripts({ tabs, scripting, runtime });
  const injected = calls.filter((c) => c[0] === "inject");
  ok("reinject: queries only http and https tabs", JSON.stringify(calls[0][1].url) === JSON.stringify(["http://*/*", "https://*/*"]));
  ok("reinject: injects every frame with the manifest's script path", injected.length === 3 && injected.every((c) => c[2] === true && c[3][0] === "src/content.js"));
  ok("reinject: a refused page does not stop the others", n === 2 && injected.map((c) => c[1]).join() === "1,2,3");
  ok("reinject: a failing tab query injects nothing", (await reinjectContentScripts({ tabs: { query: async () => { throw new Error("x"); } }, scripting, runtime })) === 0);
  const real = JSON.parse((await import("node:fs")).readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  ok("manifest: asks for scripting and lists a content script to inject", real.permissions.includes("scripting") && real.content_scripts[0].js[0] === "src/content.js");
}
delete globalThis.chrome;
globalThis.fetch = realFetch;

// a zip built in the test: stored or deflated entries, with optional flags, unix mode and a wrong declared size
async function makeZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = e.dir ? new Uint8Array() : enc.encode(e.data ?? "");
    const method = e.dir ? 0 : e.method ?? 8;
    const body = method === 8 ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()) : raw;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(6, e.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.size ?? raw.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 3 << 8, true);
    central.setUint16(8, e.flags ?? 0, true);
    central.setUint16(10, method, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, e.size ?? raw.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(38, ((e.mode ?? (e.dir ? 0o40755 : 0o100644)) << 16) >>> 0, true);
    central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, body);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...locals, ...centrals, new Uint8Array(end.buffer)]).arrayBuffer());
}
{
  const zip = await makeZip([
    { name: "manifest.json", data: '{"version":"1.4.2"}', method: 0 },
    { name: "src/", dir: true },
    { name: "src/a.js", data: "A".repeat(500) },
  ]);
  const files = await readZip(zip);
  const text = (f) => new TextDecoder().decode(f.data);
  ok("zip: stored and deflated files come out with their paths", files.map((f) => f.path).join() === "manifest.json,src/a.js" && text(files[0]) === '{"version":"1.4.2"}' && text(files[1]) === "A".repeat(500));
  const bad = ["../x", "/x", "a\\b", "C:/x", "a//b", "./x", ".update-staging/x"];
  const refused = await Promise.all(bad.map(async (name) => (await settles(readZip(await makeZip([{ name, data: "x" }])))).startsWith("rejected")));
  ok("zip: unsafe paths and our own work folders are refused", refused.every(Boolean));
  ok("zip: a link is refused", (await settles(readZip(await makeZip([{ name: "l", data: "/etc", mode: 0o120777 }])))).startsWith("rejected"));
  ok("zip: an encrypted entry is refused", (await settles(readZip(await makeZip([{ name: "a", data: "x", flags: 1 }])))).startsWith("rejected"));
  ok("zip: a size that does not match is refused", (await settles(readZip(await makeZip([{ name: "a", data: "abc", size: 9 }])))).startsWith("rejected"));
  ok("zip: bytes that are no zip are refused", (await settles(readZip(new Uint8Array([1, 2, 3])))).startsWith("rejected"));
  const pkg = (manifest) => [{ path: "manifest.json", data: new TextEncoder().encode(typeof manifest === "string" ? manifest : JSON.stringify(manifest)) }];
  const want = { key: "K", version: "1.4.2" };
  ok("zip: a manifest with this install's key and the expected version passes", manifestProblem(pkg({ key: "K", version: "1.4.2" }), want) === null);
  ok("zip: a different key is refused", manifestProblem(pkg({ key: "X", version: "1.4.2" }), want) === "key");
  ok("zip: an unexpected version is refused", manifestProblem(pkg({ key: "K", version: "1.4.3" }), want) === "version");
  ok("zip: no manifest or an unreadable one is refused", manifestProblem([], want) === "manifest" && manifestProblem(pkg("{nope"), want) === "manifest");
}

// FileSystemDirectoryHandle in memory. failAt(op, path) makes the next matching call throw; noMove drops move() like an older Chrome
function fakeFs({ noMove = false } = {}) {
  const faults = [];
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const trip = (op, path) => {
    const i = faults.findIndex((f) => f.op === op && f.path === path);
    if (i >= 0) {
      faults.splice(i, 1);
      throw new Error(`fault ${op} ${path}`);
    }
  };
  const missing = () => new DOMException("not found", "NotFoundError");
  function file(name, parent) {
    const f = {
      kind: "file",
      name,
      parent,
      data: new Uint8Array(),
      path: () => join(f.parent.path, f.name),
      async getFile() {
        const data = f.data;
        return { size: data.length, text: async () => new TextDecoder().decode(data), arrayBuffer: async () => data.slice().buffer };
      },
      async createWritable() {
        let next = new Uint8Array();
        return {
          write: async (d) => {
            trip("write", f.path());
            next = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d);
          },
          close: async () => {
            f.data = next;
          },
        };
      },
    };
    if (!noMove) {
      f.move = async (a, b) => {
        const [dest, nextName] = typeof a === "string" ? [f.parent, a] : [a, b ?? f.name];
        trip("move", f.path());
        f.parent.kids.delete(f.name);
        dest.kids.set(nextName, f);
        f.parent = dest;
        f.name = nextName;
      };
    }
    return f;
  }
  function dir(name, parent) {
    const d = {
      kind: "directory",
      name,
      kids: new Map(),
      get path() {
        return parent ? join(parent.path, name) : "";
      },
      async getDirectoryHandle(n, { create = false } = {}) {
        const k = d.kids.get(n);
        if (k?.kind === "directory") return k;
        if (k || !create) throw missing();
        const sub = dir(n, d);
        d.kids.set(n, sub);
        return sub;
      },
      async getFileHandle(n, { create = false } = {}) {
        const k = d.kids.get(n);
        if (k?.kind === "file") return k;
        if (k || !create) throw missing();
        const f = file(n, d);
        d.kids.set(n, f);
        return f;
      },
      async removeEntry(n, { recursive = false } = {}) {
        const k = d.kids.get(n);
        if (!k) throw missing();
        if (k.kind === "directory" && k.kids.size && !recursive) throw new DOMException("not empty", "InvalidModificationError");
        trip("remove", join(d.path, n));
        d.kids.delete(n);
      },
      async *entries() {
        for (const entry of [...d.kids]) yield entry;
      },
    };
    return d;
  }
  const root = dir("otp", null);
  return { root, failAt: (op, path) => faults.push({ op, path }) };
}
async function put(root, path, text) {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}
async function snapshot(d, prefix = "") {
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind === "directory") {
      const inner = await snapshot(h, `${prefix}${name}/`);
      out.push(...(inner.length ? inner : [`${prefix}${name}/`]));
    } else out.push(`${prefix}${name}=${await (await h.getFile()).text()}`);
  }
  return out.sort();
}
const newFile = (path, text) => ({ path, data: new TextEncoder().encode(text) });
async function oldInstall(opts) {
  const fs = fakeFs(opts);
  await put(fs.root, "manifest.json", "v1");
  await put(fs.root, "src/a.js", "A1");
  await put(fs.root, "src/old.js", "O");
  await put(fs.root, "legacy/x.js", "X");
  return fs;
}
const OLD = ["legacy/x.js=X", "manifest.json=v1", "src/a.js=A1", "src/old.js=O"].join();
const NEXT = [newFile("manifest.json", "v2"), newFile("src/a.js", "A2"), newFile("src/new/n.js", "N")];
const NEW = ["manifest.json=v2", "src/a.js=A2", "src/new/n.js=N"].join();
{
  const fs = await oldInstall();
  const steps = [];
  await applyUpdate(fs.root, NEXT, { version: "1.4.2", onProgress: (done, total) => steps.push([done, total]) });
  ok("files: the folder ends up holding exactly the new release", (await snapshot(fs.root)).join() === NEW);
  ok("files: progress climbs one step at a time to the total", steps.length === 8 && steps.every(([d, t], i) => d === i + 1 && t === 8));
}
{
  const fs = await oldInstall();
  fs.failAt("write", ".update-staging/src/a.js");
  const err = await applyUpdate(fs.root, NEXT, { version: "1.4.2" }).then(() => null, (e) => e);
  ok("files: a failed write while staging leaves the old install untouched", err?.restored === false && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall();
  fs.failAt("move", ".update-staging/src/new/n.js");
  const err = await applyUpdate(fs.root, NEXT, { version: "1.4.2" }).then(() => null, (e) => e);
  ok("files: a failed move halfway puts the old install back", err?.restored === true && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall();
  fs.failAt("move", "legacy/x.js");
  await settles(applyUpdate(fs.root, NEXT, { version: "1.4.2" }));
  ok("files: a failure while setting aside a dropped file also puts the old install back", (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall({ noMove: true });
  await applyUpdate(fs.root, NEXT, { version: "1.4.2" });
  ok("files: without move() the files are copied and the result is the same", (await snapshot(fs.root)).join() === NEW);
}
// the state a crash leaves: everything staged, the journal written, a.js swapped and n.js moved in
async function crashedHalfway() {
  const fs = await oldInstall();
  for (const f of NEXT) await put(fs.root, `.update-staging/${f.path}`, new TextDecoder().decode(f.data));
  await put(fs.root, ".update-journal.json", JSON.stringify({ version: "1.4.2", added: ["src/new/n.js"], removed: ["legacy/x.js", "src/old.js"] }));
  await put(fs.root, ".update-backup/src/a.js", "A1");
  await put(fs.root, "src/a.js", "A2");
  await put(fs.root, "src/new/n.js", "N");
  return fs;
}
{
  const fs = await crashedHalfway();
  const first = await recoverUpdate(fs.root);
  ok("files: an interrupted update is rolled back to the old install", first === true && (await snapshot(fs.root)).join() === OLD);
  ok("files: a second recovery finds nothing to do", (await recoverUpdate(fs.root)) === false);
}
{
  const fs = await oldInstall();
  await put(fs.root, ".update-staging/src/a.js", "A2");
  ok("files: staging left without a journal is only cleaned up", (await recoverUpdate(fs.root)) === false && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await crashedHalfway();
  await applyUpdate(fs.root, NEXT, { version: "1.4.2" });
  ok("files: a new update first recovers an interrupted one", (await snapshot(fs.root)).join() === NEW);
}
{
  const fs = await oldInstall();
  const other = await oldInstall();
  const readFrom = (root) => async (name) => (await snapshot(root)).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  ok("files: the folder the extension runs from is recognised", (await isOwnFolder(fs.root, readFrom(fs.root))) === true);
  ok("files: a copy elsewhere is not", (await isOwnFolder(fs.root, readFrom(other.root))) === false);
  ok("files: the probe file is removed afterwards", (await snapshot(fs.root)).join() === OLD);
}

{
  const journalEnv = (journal) => {
    const env = fakeUpdateEnv();
    globalThis.chrome.runtime.getURL = (p) => `chrome-extension://pb/${p}`;
    globalThis.fetch = async (url) => {
      env.fetched.push(String(url));
      if (!journal) throw new TypeError("Failed to fetch");
      return new Response("{}");
    };
    return env;
  };
  let env = journalEnv(true);
  ok("interrupted: nothing is looked up when no update was running", (await hasInterruptedUpdate()) === false && env.fetched.length === 0);
  await setUpdating(true);
  ok("interrupted: a run that left its journal is found", (await hasInterruptedUpdate()) === true && env.fetched.join() === "chrome-extension://pb/.update-journal.json");
  env = journalEnv(false);
  await setUpdating(true);
  ok("interrupted: a run that left no journal is forgotten", (await hasInterruptedUpdate()) === false && env.data.isUpdating === undefined);
  await setUpdating(true);
  await setUpdating(false);
  ok("interrupted: a finished run clears its mark", env.data.isUpdating === undefined);
  delete globalThis.chrome;
  globalThis.fetch = realFetch;
}

// a saved folder handle with scripted permission answers, counting what the user would be asked
function savedFolder(query, request = "granted") {
  const h = { asked: 0 };
  h.queryPermission = async () => query;
  h.requestPermission = async () => {
    h.asked++;
    return request;
  };
  return h;
}
function folderEnv(saved, { own = true, pickThrows = false } = {}) {
  const env = { picked: 0, startIn: [], store: { value: saved, get: async () => env.store.value, set: async (v) => (env.store.value = v) } };
  env.picked_handle = savedFolder("granted");
  env.deps = {
    store: env.store,
    pick: async (startIn) => {
      env.picked++;
      env.startIn.push(startIn);
      if (pickThrows) throw new DOMException("cancelled", "AbortError");
      return env.picked_handle;
    },
    isOwn: async () => own,
  };
  return env;
}
{
  const env = folderEnv(null);
  const r = await folderForUpdate(env.deps);
  ok("folder: the first update asks for the folder once and keeps it", r.ok && r.folder === env.picked_handle && env.picked === 1 && env.startIn[0] === undefined && env.store.value === env.picked_handle);
}
{
  const saved = savedFolder("prompt", "granted");
  const env = folderEnv(saved);
  const r = await folderForUpdate(env.deps);
  // only a folder that comes through the picker gets chrome's "allow on every visit"; requestPermission offers two buttons
  ok("folder: after a restart the picker opens at the kept folder instead of the bare permission prompt", r.ok && env.picked === 1 && env.startIn[0] === saved && saved.asked === 0 && env.store.value === env.picked_handle);
}
{
  const saved = savedFolder("granted");
  const env = folderEnv(saved);
  const r = await folderForUpdate(env.deps);
  ok("folder: with allow on every visit nothing is asked", r.ok && saved.asked === 0 && env.picked === 0);
}
{
  const saved = savedFolder("denied");
  const env = folderEnv(saved);
  const r = await folderForUpdate(env.deps);
  ok("folder: a refused permission opens the picker at the kept folder again", r.ok && env.picked === 1 && env.startIn[0] === saved);
}
{
  const env = folderEnv(null, { own: false });
  const r = await folderForUpdate(env.deps);
  ok("folder: a folder that is not this install is refused and not kept", r.error === "notown" && env.store.value === null);
}
{
  const env = folderEnv(null, { pickThrows: true });
  ok("folder: closing the picker is reported as cancelled", (await folderForUpdate(env.deps)).error === "cancelled");
}
{
  const env = folderEnv(savedFolder("granted"), { own: false });
  ok("folder: a kept folder that no longer holds this install is reported", (await folderForUpdate(env.deps)).error === "notown");
}
{
  const env = folderEnv(savedFolder("granted"));
  const r = await pickFolder(env.deps);
  ok("folder: change folder always opens the picker", r.ok && env.picked === 1 && env.store.value === env.picked_handle);
}

{
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
  const zip = new TextEncoder().encode("release zip bytes ".repeat(4000));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, zip));
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex");
  const asset = (name, extra) => ({ name, browser_download_url: `https://dl.test/${name}`, ...extra });
  const releaseJson = (assets) => ({ tag_name: "v1.4.2", assets });
  const full = [asset("passbridge.zip", { size: zip.length, digest: `sha256:${hex}` }), asset("passbridge.zip.sig", { size: 64 })];
  const cacheModes = new Set();
  const serve = (json, files = {}) => {
    globalThis.fetch = async (url, init) => {
      cacheModes.add(init?.cache);
      url = String(url);
      if (url.startsWith("https://api.github.com/")) return json instanceof Error ? Promise.reject(json) : new Response(JSON.stringify(json), { status: 200 });
      const body = files[url.slice("https://dl.test/".length)];
      return body ? new Response(body) : new Response("missing", { status: 404 });
    };
  };
  serve(releaseJson(full));
  const release = await latestRelease("1.4.1");
  ok("release: a newer signed release is described", release.ok && release.version === "1.4.2" && release.size === zip.length && release.pageUrl === "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.2");
  serve(releaseJson([full[0]]));
  const unsigned = await latestRelease("1.4.1");
  ok("release: no .sig means unsigned, with the version and the page to download by hand", !unsigned.ok && unsigned.error === "unsigned" && unsigned.version === "1.4.2" && unsigned.pageUrl.endsWith("/v1.4.2"));
  serve(releaseJson([asset("passbridge.zip", { size: zip.length }), full[1]]));
  ok("release: no digest also means unsigned", (await latestRelease("1.4.1")).error === "unsigned");
  serve(releaseJson(full));
  ok("release: the installed version is reported as current", (await latestRelease("1.4.2")).error === "current");
  serve(new Error("offline"));
  ok("release: no answer from GitHub is a network error", (await latestRelease("1.4.1")).error === "network");

  serve(releaseJson(full), { "passbridge.zip": zip, "passbridge.zip.sig": sig });
  const seen = [];
  const got = await downloadRelease(release, { publicKey, onProgress: (n, total) => seen.push([n, total]) });
  ok("release: the download is verified and handed back", got.ok && got.zip.length === zip.length);
  ok("release: download progress reaches the full size", seen.length > 0 && seen.at(-1)[0] === zip.length && seen.at(-1)[1] === zip.length);
  const tampered = zip.slice();
  tampered[10] ^= 1;
  serve(releaseJson(full), { "passbridge.zip": tampered, "passbridge.zip.sig": sig });
  ok("release: a changed zip fails verification", (await downloadRelease(release, { publicKey })).error === "verify");
  serve(releaseJson(full), { "passbridge.zip.sig": sig });
  ok("release: a missing file is a download error", (await downloadRelease(release, { publicKey })).error === "download");
  ok("release: the lookup and the downloads skip the browser cache", cacheModes.size === 1 && cacheModes.has("no-store"));

  serve(releaseJson([full[0]]));
  const helper = await installUpdate("1.4.1");
  ok("helper update: an unsigned release says so instead of blaming the download", !helper.ok && /isn't signed/.test(helper.error));
}
globalThis.fetch = realFetch;

console.log(failed ? `\n${failed} failed` : "\nunit ok");
process.exit(failed ? 1 : 0);
