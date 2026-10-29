import { ApplePasswords, Command, normalizeOtpEntries } from "../../src/apple/protocol.js";
import { isBareCodeOtp } from "../../src/otp-field.js";
import { otpAuthSecret, parseOtpAuth } from "../../src/otpauth.js";
import { parseSetupInput, totpHandoff, withAccount } from "../../src/totp-setup.js";
import { loginAction, menuItems } from "../../src/menu.js";
import { generateApplePassword } from "../../src/password-generate.js";
import { hostsRelated, passwordSearchSteps } from "../../src/session/password-search.js";
import { registrableDomain, siteLookupHosts } from "../../src/session/site-domain.js";
import { orderByPageUsername, usernameMatchesPage } from "../../src/session/username-match.js";
import { frameUrlsFor } from "../../src/session/frame-urls.js";
import { createLimiter, handleAgentRequest, hostAllowed, pickAllowedFrames, relayEvent, sanitizeReply } from "../../src/agent.js";
import { reportIssueUrl, reportText, scrubAttr, scrubText, scrubUrl } from "../../src/report-scrub.js";
import { UPDATE_CHECK_MS, availableUpdate, checkForUpdate, dismissUpdate, isNewerVersion, markUpdatedTo, takeUpdatedTo } from "../../src/update/check.js";
import { REPLACED_EVENT, createLifecycle, isInvalidated, reinjectContentScripts } from "../../src/reload-recovery.js";
import { digestHex, verifyRelease } from "../../src/update/verify.js";
import { downloadRelease, latestRelease } from "../../src/update/release.js";
import { autoInstallUpdate, installUpdate, updateHelper } from "../../src/update/install.js";
import { isWindows, updateRoute } from "../../src/update/platform.js";
import { manifestProblem, readZip } from "../../src/update/zip.js";
import { applyUpdate, hasInterruptedUpdate, isOwnFolder, recoverUpdate, setUpdating } from "../../src/update/files.js";
import { folderForUpdate, pickFolder } from "../../src/update/folder.js";
import { withUpdateLock } from "../../src/update/lock.js";
import { SETTINGS_DEFAULTS, colorSchemeFor, migrateSettingsToSync } from "../../src/settings.js";
import { OPTION_TABS, helperView, policyMessage, tabFromHash } from "../../src/ui/options-model.js";
import { buildExtension } from "../../scripts/build.mjs";
import { changeCount, issueBody, issueTitle, samePin, summarize, titlePrefix } from "../../scripts/upstream-check.mjs";

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
{
  const pasted = parseSetupInput("jbsw y3dp ehpk 3pxp", "chatgpt.com");
  ok("a pasted grouped setup key becomes an otpauth link", otpAuthSecret(pasted?.uri) === "JBSWY3DPEHPK3PXP" && pasted.account === "chatgpt.com");
  ok("a pasted otpauth link inside text is found", parseSetupInput("scan: otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&issuer=A ok")?.issuer === "A");
  ok("junk and short keys are refused", parseSetupInput("not a key!") === null && parseSetupInput("ABC") === null && parseSetupInput("") === null);
  const linked = withAccount(pasted.uri, { username: "me@x.com", issuer: "ChatGPT" });
  const lp = parseOtpAuth(linked);
  ok("the chosen login becomes the account and the secret is kept", lp?.account === "me@x.com" && lp?.issuer === "ChatGPT" && otpAuthSecret(linked) === "JBSWY3DPEHPK3PXP");
  ok("the client message carries only the link and the page", JSON.stringify(Object.keys(totpHandoff(linked, "https://chatgpt.com/connector/mfa")).sort()) === '["totpPageUrl","totpUri"]');
}
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

ok("agent: relay events set the state", relayEvent({ event: "standby" }) === "standby" && relayEvent({ event: "active" }) === "active");
ok("agent: requests and odd messages are not relay events", relayEvent({ id: "1", event: "standby" }) === null && relayEvent({ id: "1", op: "status" }) === null && relayEvent({ event: "x" }) === null && relayEvent(null) === null);

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
  // settings live in sync, machine state in local; one in-memory map serves both
  globalThis.chrome = { storage: { local, sync: local }, runtime: { lastError: undefined } };
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
  ok("update: no second request inside the interval", env.fetched.length === 0);
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW - 60_000 });
  const reached = await checkForUpdate(NOW, { force: true });
  ok("update: force skips the wait", env.fetched.length === 1 && reached === true && env.data.updateCheckedAt === NOW);
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: NOW - 60_000 });
  const reached = await checkForUpdate(NOW, { force: false });
  ok("update: without force the wait still applies", env.fetched.length === 0 && reached === false);
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

{
  // two areas this time, so a move from local to sync shows
  const area = (data) => ({
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (o) => void Object.assign(data, o),
    remove: async (keys) => keys.forEach((k) => delete data[k]),
  });
  const local = area({ askToSave: false, updateCheckedAt: 5 });
  const sync = area({});
  globalThis.chrome = { storage: { local, sync }, runtime: {} };
  await migrateSettingsToSync();
  ok("settings: a machine's local settings move to sync once", sync.data.askToSave === false && !("askToSave" in local.data));
  ok("settings: machine state stays in local", local.data.updateCheckedAt === 5 && !("updateCheckedAt" in sync.data));
  local.data.askToSave = true;
  sync.data.askToSave = false;
  await migrateSettingsToSync();
  ok("settings: values already in sync win over a second machine's", sync.data.askToSave === false && !("askToSave" in local.data));
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
function folderEnv(saved, { own = true, source = true, pickThrows = false } = {}) {
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
    isSource: async () => source,
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
  const env = folderEnv(null, { source: false });
  const r = await folderForUpdate(env.deps);
  ok("folder: a folder without the PassBridge manifest is refused and not kept", r.error === "notsource" && env.store.value === null);
}
{
  const env = folderEnv(savedFolder("granted"), { source: false });
  ok("folder: a kept folder that lost the PassBridge manifest is refused", (await folderForUpdate(env.deps)).error === "notsource");
}
{
  // the same lock semantics as navigator.locks with ifAvailable: the second request gets null while the first runs
  let held = false;
  const locks = { request: async (name, opts, cb) => (held ? cb(null) : ((held = true), cb({ name }).finally(() => (held = false)))) };
  let release;
  const first = withUpdateLock(() => new Promise((r) => (release = r)), locks);
  let ran = false;
  const second = await withUpdateLock(async () => (ran = true), locks);
  ok("lock: a second update started while one runs is refused and never runs", second.ok === false && second.error === "busy" && !ran);
  release("done");
  ok("lock: the first update still finishes", (await first).value === "done");
  ok("lock: after it finishes a new update can start", (await withUpdateLock(async () => 1, locks)).ok === true);
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

  const heldLocks = { request: async (name, opts, cb) => cb(null) };
  const busy = await installUpdate("1.4.1", { publicKey, locks: heldLocks });
  ok("helper update: refused with the plain message while another update holds the lock", !busy.ok && busy.error === "An update is already running in another PassBridge page.");

  // the updater host answering, with storage and reload stubbed
  const helperEnv = (hostReply) => {
    const env = fakeUpdateEnv();
    env.sent = [];
    env.reloads = 0;
    Object.assign(globalThis.chrome.runtime, {
      sendNativeMessage: async (host, msg) => (env.sent.push(msg), hostReply),
      reload: () => env.reloads++,
    });
    serve(releaseJson(full), { "passbridge.zip": zip, "passbridge.zip.sig": sig });
    return env;
  };
  let env = helperEnv({ ok: true });
  const installed = await installUpdate("1.4.1", { publicKey });
  await new Promise((r) => setTimeout(r, 350));
  ok("helper update: a finished install marks the version for the result page, then reloads", installed.ok && env.sent.some((m) => m.op === "install") && env.data.updatedTo === "1.4.2" && env.reloads === 1);
  env = helperEnv({ ok: false, error: "disk full" });
  const refused = await installUpdate("1.4.1", { publicKey });
  await new Promise((r) => setTimeout(r, 350));
  ok("helper update: a refused install marks nothing and does not reload", !refused.ok && env.data.updatedTo === undefined && env.reloads === 0);
  delete globalThis.chrome;
}
{
  const env = fakeUpdateEnv();
  await markUpdatedTo("1.4.2");
  const first = await takeUpdatedTo();
  ok("update: the marked version is handed over once", first === "1.4.2" && env.data.updatedTo === undefined && (await takeUpdatedTo()) === null);
  delete globalThis.chrome;
}
globalThis.fetch = realFetch;

{
  // automatic install: the setting, the host and the failed-once memory decide
  const setup = (seed) => {
    const env = fakeUpdateEnv({ latestRelease: "v1.5.0", ...seed });
    globalThis.chrome.runtime.getManifest = () => ({ version: "1.4.0" });
    env.installs = [];
    env.helpers = 0;
    env.deps = (host, installReply = { ok: true }) => ({
      available: async () => host,
      install: async (v, o) => (env.installs.push(o), installReply),
      helper: async () => (env.helpers++, { ok: true }),
    });
    return env;
  };
  let env = setup({});
  let r = await autoInstallUpdate(env.deps(true));
  ok("auto update: a newer release with the host present and the setting on installs by itself", r.ok && env.installs.length === 1 && env.installs[0].auto === true);
  env = setup({ autoInstallUpdates: false });
  r = await autoInstallUpdate(env.deps(true));
  ok("auto update: the setting off means nothing is installed", !r.ran && env.installs.length === 0);
  env = setup({});
  r = await autoInstallUpdate(env.deps(false));
  ok("auto update: no updater host means nothing is installed", !r.ran && r.why === "no-host" && env.installs.length === 0);
  env = setup({ canCheckForUpdates: false });
  ok("auto update: with update checks off nothing is installed", !(await autoInstallUpdate(env.deps(true))).ran);
  env = setup({});
  r = await autoInstallUpdate(env.deps(true, { ok: false, error: "x" }));
  ok("auto update: a failed install is remembered for that version", !r.ok && env.data.autoInstallFailed === "1.5.0");
  r = await autoInstallUpdate(env.deps(true));
  ok("auto update: the same version is not retried after a failure", !r.ran && r.why === "failed-before" && env.installs.length === 1);
  env = setup({ latestRelease: "v1.4.0" });
  r = await autoInstallUpdate(env.deps(true));
  ok("auto update: no newer extension release installs nothing but checks the helper", !r.ran && env.installs.length === 0 && env.helpers === 1);
  delete globalThis.chrome;
}
{
  // helper update: only when the helper is older than the release, verified like the extension zip
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
  const zip = new TextEncoder().encode("helper zip bytes ".repeat(500));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, zip));
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex");
  const asset = (name, extra) => ({ name, browser_download_url: `https://dl.test/${name}`, ...extra });
  const json = { tag_name: "v1.5.0", assets: ["passbridge-macos-helper.zip", "passbridge-windows-helper.zip"].flatMap((n) => [asset(n, { size: zip.length, digest: `sha256:${hex}` }), asset(`${n}.sig`)]) };
  const run = async (status, platform = "macOS", tamper = false) => {
    const env = fakeUpdateEnv({ latestRelease: "v1.5.0" });
    env.sent = [];
    env.urls = [];
    const bad = zip.slice();
    bad[3] ^= 1;
    globalThis.fetch = async (url) => {
      url = String(url);
      env.urls.push(url);
      if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(json));
      return new Response(url.endsWith(".sig") ? sig : tamper ? bad : zip);
    };
    const send = async (m) => (env.sent.push(m), m.op === "status" ? status : { ok: true });
    env.res = await updateHelper({ publicKey, send, platform });
    return env;
  };
  let e = await run({ ok: true, helperVersion: "1.4.5" });
  const inst = e.sent.find((m) => m.op === "install-helper");
  ok("helper update: an older helper is replaced with the verified macOS zip", e.res.ok && inst?.version === "1.5.0" && e.urls.some((u) => u.endsWith("/passbridge-macos-helper.zip")) && inst.zip.length > 0);
  e = await run({ ok: true, helperVersion: "1.5.0" });
  ok("helper update: a helper at the release version is left alone", e.res.skipped && !e.sent.some((m) => m.op === "install-helper") && e.urls.length === 0);
  e = await run({ ok: true, helperVersion: null }, "Windows");
  ok("helper update: an unknown helper version gets the Windows zip", e.sent.some((m) => m.op === "install-helper") && e.urls.some((u) => u.endsWith("/passbridge-windows-helper.zip")));
  e = await run({ ok: true, helperVersion: "1.4.5" }, "macOS", true);
  ok("helper update: a zip that fails verification is never sent", !e.res.ok && e.res.error === "verify" && !e.sent.some((m) => m.op === "install-helper"));
  e = await run({ ok: true });
  ok("helper update: an old helper without install-helper gets a one-time note and no download", e.res.error === "old-helper" && e.data.helperOutdatedNote === true && e.urls.length === 0);
  delete e.data.helperOutdatedNote; // the popup took the note
  await updateHelper({ publicKey, send: async () => ({ ok: true }), platform: "macOS" });
  ok("helper update: the old-helper note is not set again on the next check", !("helperOutdatedNote" in e.data));
  delete globalThis.chrome;
  globalThis.fetch = realFetch;
}

{
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const out = mkdtempSync(join(tmpdir(), "pb-build-guard-"));
  const source = { latestUrl: "http://127.0.0.1:1/releases/latest", publicKey: "AAAA" };
  ok("build: a release build refuses a test release source", (await settles(buildExtension({ out, releaseSource: source }))).startsWith("rejected"));
  ok("build: a release build refuses a test version", (await settles(buildExtension({ out, version: "9.9.9.1" }))).startsWith("rejected"));
  ok("build: a refused build writes nothing", readdirSync(out).length === 0);
  rmSync(out, { recursive: true, force: true });
}
{
  ok("upstream: a short pin matches the full latest sha", samePin("fc5de86", "fc5de86abc1234") === true);
  ok("upstream: a different sha does not match", samePin("fc5de86", "0123456abc") === false);
  ok("upstream: an empty pin never matches", samePin("", "abc") === false);
  const s = summarize({
    name: "bitwarden",
    repo: "bitwarden/clients",
    pinned: "fc5de86",
    latest: "aaaa111",
    diffs: [{ rel: "a.ts", kind: "changed" }, { rel: "b.ts", kind: "new" }],
    missing: [{ path: "gone.ts", status: 404 }, { path: "x.ts", status: 500 }],
  });
  ok("upstream: summary splits changed, new, removed and failed", s.changed.join() === "a.ts,b.ts" && s.new.join() === "b.ts" && s.removed.join() === "gone.ts" && s.failed.join() === "500 x.ts");
  ok("upstream: compare link uses pinned and latest", s.compare === "https://github.com/bitwarden/clients/compare/fc5de86...aaaa111");
  ok("upstream: a 404 counts as a change", changeCount(s) === 3);
  ok("upstream: title starts with the upstream prefix", issueTitle(s) === "Upstream: bitwarden changed 3 tracked file(s)" && issueTitle(s).startsWith(titlePrefix("bitwarden")));
  const body = issueBody(s);
  ok("upstream: body has commits, compare link, files and steps", body.includes("fc5de86") && body.includes("aaaa111") && body.includes(s.compare) && body.includes("`gone.ts`") && body.includes("npm run sync -- bitwarden aaaa111 --accept"));
}


{
  // sign-release.mjs signs a helper zip and the result verifies
  const { execFileSync } = await import("node:child_process");
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs"); const path = await import("node:path"); const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "pb-sign-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(path.join(dir, "k.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  const zipPath = path.join(dir, "passbridge-macos-helper.zip");
  writeFileSync(zipPath, "helper zip bytes");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  execFileSync("node", ["scripts/sign-release.mjs", "sign", zipPath, "--key", path.join(dir, "k.pem"), "--pub", raw], { stdio: "pipe" });
  const sigBytes = readFileSync(`${zipPath}.sig`);
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", readFileSync(zipPath))).toString("hex");
  ok("sign-release: a helper zip gets a .sig that verifies", sigBytes.length === 64 && (await verifyRelease(readFileSync(zipPath), sigBytes, hex, raw)));
}

ok("update page: Windows with the helper installs through it, never a folder write", updateRoute({ windows: true, helper: true }) === "native");
ok("update page: Windows without the helper offers the helper step first", updateRoute({ windows: true, helper: false }) === "helper");
ok("update page: Windows without the helper can choose the folder update instead", updateRoute({ windows: true, helper: false, noHelper: true }) === "folder");
ok("update page: Windows with the helper always installs through it", updateRoute({ windows: true, helper: true, noHelper: true }) === "native");
ok("update page: other systems keep the folder update", updateRoute({ windows: false, helper: false }) === "folder" && updateRoute({ windows: false, helper: true }) === "folder");
ok("update page: Windows is read from userAgentData or platform", isWindows({ userAgentData: { platform: "Windows" } }) && isWindows({ platform: "Win32" }) && !isWindows({ platform: "MacIntel" }) && !isWindows({}));

{
  const ids = (state) => menuItems(state).map((i) => i.id);
  const locked = ids({ ready: false, logins: [{ username: "a" }], hasCode: true });
  ok("menu: locked shows Unlock and no login or code items", locked.includes("pb-unlock") && !locked.some((id) => /^pb-(fill|user|pass|otp)/.test(id)));
  const none = menuItems({ ready: true, logins: [], hasCode: false });
  ok("menu: no logins shows a greyed note", none.find((i) => i.id === "pb-none")?.enabled === false && !none.some((i) => /^pb-(fill|user|pass)-/.test(i.id)));
  const one = menuItems({ ready: true, logins: [{ username: "me@x.com" }], hasCode: false });
  ok("menu: one login is flat and named", one.find((i) => i.id === "pb-fill-0")?.title === "Fill me@x.com" && one.find((i) => i.id === "pb-pass-0")?.parentId === "pb-root");
  ok("menu: no code item without a code", !one.some((i) => i.id === "pb-otp"));
  const noName = ids({ ready: true, logins: [{ username: "" }], hasCode: false });
  ok("menu: a login without a username has no Copy username", !noName.includes("pb-user-0"));
  const two = menuItems({ ready: true, logins: [{ username: "a" }, { username: "b" }], hasCode: true });
  ok("menu: several logins get one submenu each", two.filter((i) => i.parentId === "pb-acct-1").map((i) => i.id).join() === "pb-fill-1,pb-user-1,pb-pass-1");
  ok("menu: a submenu parent is not also an action", two.every((i) => !String(i.id).startsWith("pb-acct-") || !loginAction(i.id)));
  ok("menu: code item shows when the site has a code", two.some((i) => i.id === "pb-otp"));
  const gen = one.find((i) => i.id === "pb-gen"), genCopy = one.find((i) => i.id === "pb-gen-copy");
  ok("menu: fill a password only on fields, copy one only on pages", gen.contexts.join() === "editable" && genCopy.contexts.join() === "page");
  ok("menu: ids are unique", new Set(two.map((i) => i.id)).size === two.length);
  ok("menu: loginAction reads the id", JSON.stringify(loginAction("pb-pass-2")) === '{"action":"pass","index":2}' && loginAction("pb-acct-1") === null && loginAction("pb-otp") === null);
}

const backblazeForm = "Two-Factor Verification Enter the 6-digit verification code from your authentication application Code Enter Code";
ok("backblaze two-factor code field is a one-time code", isBareCodeOtp(["code-field", "code-field", "Code"], backblazeForm));
ok("a coupon code field is not a one-time code", !isBareCodeOtp(["coupon-code", "coupon-code", "Coupon code"], "Apply a coupon Coupon code Apply"));
ok("a bare code field with no two-factor text is not a one-time code", !isBareCodeOtp(["code", "code", "Code"], "Redeem your code Code Redeem"));
ok("a zip code field on a verification form is not a one-time code", !isBareCodeOtp(["zip-code", "zip", "Zip code"], backblazeForm));
ok("a big page around a bare code field is not used as context", !isBareCodeOtp(["code"], backblazeForm + " x".repeat(400)));

{
  ok("options: tabs in order", OPTION_TABS.map((t) => t.id).join() === "autofill,appearance,browser,agents,updates");
  ok("options: hash opens its tab", tabFromHash("#updates") === "updates");
  ok("options: odd hashes open autofill", ["", "#", "#AGENTS", "#agents?x", "#%E2"].every((h) => tabFromHash(h) === "autofill"));
  const view = (policy, updater, isWindows = false, canCheckForUpdates = true) => helperView({ helpers: { policy, updater }, isWindows, canCheckForUpdates });
  const all = view("present", "present");
  ok("options: helpers present, nothing locked or noticed", Object.values(all.rows).every((r) => r === "ready") && Object.values(all.notices).every((n) => n === null));
  const checking = view("checking", "checking");
  ok("options: checking locks nothing and shows no notice", checking.rows.policy === "checking" && checking.rows.autoInstall === "checking" && Object.values(checking.notices).every((n) => n === null));
  const noPolicy = view("missing", "present");
  ok("options: missing policy locks password manager and agents", noPolicy.rows.policy === "locked" && noPolicy.rows.agents === "locked" && noPolicy.rows.autoInstall === "ready");
  ok("options: missing policy links the macOS helper setup", noPolicy.notices.browser?.text === "Greyed-out settings need the PassBridge helper." && noPolicy.notices.browser.href === "https://github.com/MehdiMamas/passbridge/blob/main/SETUP.md#optional-macos-helper" && !!noPolicy.notices.agents?.href?.endsWith("#agent-sign-in-macos"));
  ok("options: missing updater on macOS links the one-click update", !!view("present", "missing").notices.updates?.href?.endsWith("#one-click-update-macos"));
  const win = view("present", "missing", true);
  ok("options: windows agents row is open while the helper is present", win.rows.agents === "ready" && win.notices.agents === null);
  const winNoPolicy = view("missing", "present", true);
  ok("options: windows agents row is locked without the helper and links the windows setup", winNoPolicy.rows.agents === "locked" && !!winNoPolicy.notices.agents?.href?.endsWith("#agent-sign-in-windows"));
  ok("options: standby relay shows the other-browser line", /another browser or profile/.test(helperView({ helpers: { policy: "present", updater: "present" }, isWindows: false, canCheckForUpdates: true, relay: "standby" }).notices.agents?.text || ""));
  ok("options: active relay shows no agents notice", helperView({ helpers: { policy: "present", updater: "present" }, isWindows: false, canCheckForUpdates: true, relay: "active" }).notices.agents === null);
  ok("options: windows updater notice links the windows setup", win.rows.autoInstall === "locked" && !!win.notices.updates?.href?.endsWith("#automatic-updates-windows"));
  ok("options: windows policy notice links the windows setup", !!view("missing", "present", true).notices.browser?.href?.endsWith("#windows"));
  ok("options: no updater notice while checks are off", view("present", "missing", false, false).notices.updates === null);
  ok("options: a toggle with no helper note still says to restart", policyMessage({ ok: true, hidden: false, needsApproval: true }, true) === "Fully quit and reopen the browser to apply this.");
  ok("options: a toggle shows the helper's own note", policyMessage({ ok: true, hidden: true, note: "Approve it in Windows." }, true) === "Approve it in Windows.");
  ok("options: a failed toggle shows the error or a fallback", policyMessage({ ok: false, error: "denied" }, true) === "denied" && policyMessage({ ok: false }, true) === "Couldn't change the policy.");
  ok("theme: system is the default", SETTINGS_DEFAULTS.theme === "system");
  ok("theme: light and dark force one scheme", colorSchemeFor("light") === "light" && colorSchemeFor("dark") === "dark");
  ok("theme: system or an unknown value follows the computer", ["system", undefined, null, "", "blue"].every((t) => colorSchemeFor(t) === "light dark"));
  ok("options: reading the policy shows only an error", policyMessage({ ok: true, hidden: true }, false) === "" && policyMessage({ ok: false, error: "no reply" }, false) === "no reply");
}
console.log(failed ? `\n${failed} failed` : "\nunit ok");
process.exit(failed ? 1 : 0);
