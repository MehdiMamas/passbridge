import { readFileSync } from "node:fs";
import { ApplePasswords, Command, normalizeOtpEntries } from "../../src/apple/protocol.ts";
import { isBareCodeOtp } from "../../src/otp-field.js";
import { otpAuthSecret, parseOtpAuth } from "../../src/otpauth.js";
import { parseSetupInput, totpHandoff, withAccount } from "../../src/totp-setup.js";
import { loginAction, menuItems } from "../../src/menu.js";
import { generateApplePassword } from "../../src/password-generate.js";
import { hostsRelated, passwordSearchSteps } from "../../src/session/password-search.js";
import { addToAllowlist, agentHostFor, agentOfferFor } from "../../src/session/agent-allow.js";
import { registrableDomain, siteLookupHosts } from "../../src/session/site-domain.js";
import { orderByPageUsername, usernameMatchesPage } from "../../src/session/username-match.js";
import { newPasswordContext, pickSaveTarget } from "../../src/save-target.js";
import { confirmLoginAdded, useNewLoginSheet } from "../../src/session/add-login-check.js";
import { frameUrlsFor } from "../../src/session/frame-urls.js";
import { agentSaveAllowed, createLimiter, initAgent, isCodeHost, pickCodeFrames, handleAgentRequest, handleUserCode, logEntry, hostAllowed, loginSavedFor, onSiteOrSubdomain, pickAllowedFrames, relayEvent, sanitizeReply } from "../../src/agent.js";
import { reportIssueUrl, reportText, scrubAttr, scrubText, scrubUrl } from "../../src/report-scrub.js";
import { UPDATE_CHECK_MS, availableUpdate, checkForUpdate, dismissUpdate, isNewerVersion, markUpdatedTo, takeUpdatedTo } from "../../src/update/check.js";
import { REPLACED_EVENT, createLifecycle, isInvalidated, reinjectContentScripts } from "../../src/reload-recovery.js";
import { digestHex, verifyRelease } from "../../src/update/verify.js";
import { downloadRelease, latestRelease } from "../../src/update/release.js";
import { autoInstallUpdate, installUpdate, updateHelper } from "../../src/update/install.js";
import { reloadIfStale } from "../../src/update/stale.js";
import { isWindows, updateRoute } from "../../src/update/platform.js";
import { manifestProblem, readZip } from "../../src/update/zip.js";
import { applyUpdate, hasInterruptedUpdate, isOwnFolder, recoverUpdate, setUpdating } from "../../src/update/files.js";
import { canKeepFolder, folderForUpdate, keepFolder, pickFolder } from "../../src/update/folder.js";
import { withUpdateLock } from "../../src/update/lock.js";
import { SETTINGS_DEFAULTS, colorSchemeFor, migrateSettingsToSync } from "../../src/settings.js";
import { OPTION_TABS, helperView, passkeyImportSummary, passkeysView, policyMessage, shouldRecheck, tabFromHash, visibleTabs } from "../../src/ui/options-model.js";
import { applyManaged, getEffectiveSettings, isManagedInstall, resetManagedCache } from "../../src/managed.js";
import { PASSKEY_HOST, decodeRecord, encodeRecord, isPasskeyHost, isPasskeyName, makeRecord, parseUsername, recordUsername, b64u as pkB64u, unb64u as pkUnb64u } from "../../src/passkeys/record.ts";
import { createPasskey, signAssertion } from "../../src/passkeys/webauthn.ts";
import { createPasskeyProxy } from "../../src/passkeys/proxy.ts";
import { isPasskeyLogin } from "../../src/passkeys/record.ts";
import { listPasskeys, passkeysForHost, readPasskey, savePasskey } from "../../src/passkeys/store.ts";
import { createMockClient } from "../../src/session/mock-client.js";
import { parseBitwarden, parseCxf, parseExport } from "../../src/passkeys/import.ts";
import { codesForLogins, filterByUsername } from "../../src/ui/username-filter.js";
import { buildExtension, buildStamp } from "../../scripts/build.ts";
import { changeCount, issueBody, issueTitle, samePin, summarize, titlePrefix } from "../../scripts/upstream-check.ts";

let failed = 0;
function ok(name: any, cond: any) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

{
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const b64 = async (k: any) => Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64");
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

ok("a subdomain also looks up its site", siteLookupHosts("account.apple.com").join(",") === "account.apple.com,apple.com,www.apple.com");
ok("deep subdomains walk up to the site and stop", siteLookupHosts("a.b.example.com").join(",") === "a.b.example.com,b.example.com,example.com,www.example.com");
ok("a site host also looks up its www form", siteLookupHosts("apple.com").join(",") === "apple.com,www.apple.com");
ok("a www host is not asked twice", siteLookupHosts("www.apple.com").join(",") === "www.apple.com,apple.com");
ok("a login subdomain also asks the www sibling", siteLookupHosts("login.example.com").join(",") === "login.example.com,example.com,www.example.com");
ok("a single-label host looks up only itself", siteLookupHosts("localhost").join(",") === "localhost");
ok("never save on a subdomain covers the whole site", registrableDomain("login.example.com") === "example.com" && registrableDomain("www.example.com") === "example.com");
ok("a two-label public suffix is never queried", siteLookupHosts("account.bbc.co.uk").join(",") === "account.bbc.co.uk,bbc.co.uk,www.bbc.co.uk" && registrableDomain("bbc.co.uk") === "bbc.co.uk");
ok("an IP address is not split", siteLookupHosts("192.168.1.10").join(",") === "192.168.1.10");
const viaSteps = passwordSearchSteps("account.apple.com", ["apple.com"], undefined, "apple.com");
ok(
  "a login listed under the parent site is searched there first",
  viaSteps[0].search === "apple.com" && viaSteps[0].envelope === "apple.com" &&
    viaSteps[1].search === "apple.com" && viaSteps[1].envelope === "account.apple.com",
);

const otp = (parseOtpAuth("otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub") as any);
ok("otpauth keeps issuer and account and hides the secret from the label", otp?.issuer === "GitHub" && otp?.account === "alice@example.com" && !("secret" in otp));
ok("setup key is the base32 secret without padding", otpAuthSecret(otp.uri) === "JBSWY3DPEHPK3PXP" && otpAuthSecret("otpauth://totp/Work?secret=JBSWY3DPEHPK3PXP====") === "JBSWY3DPEHPK3PXP");
ok("a non-setup link has no setup key", otpAuthSecret("https://example.com/?secret=JBSWY3DPEHPK3PXP") === "");
ok("wifi and migration QR codes are not setup links", parseOtpAuth("WIFI:S:cafe;T:WPA;P:secret;;") === null && parseOtpAuth("otpauth-migration://offline?data=abc") === null);
ok("a grouped setup key with spaces is accepted", otpAuthSecret("otpauth://totp/Work?secret=JBSW%20Y3DP%20EHPK%203PXP") === "JBSWY3DPEHPK3PXP");
{
  const pasted = (parseSetupInput("jbsw y3dp ehpk 3pxp", "chatgpt.com") as any);
  ok("a pasted grouped setup key becomes an otpauth link", otpAuthSecret(pasted?.uri) === "JBSWY3DPEHPK3PXP" && pasted.account === "chatgpt.com");
  ok("a pasted otpauth link inside text is found", parseSetupInput("scan: otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&issuer=A ok")?.issuer === "A");
  ok("junk and short keys are refused", parseSetupInput("not a key!") === null && parseSetupInput("ABC") === null && parseSetupInput("") === null);
  const linked = withAccount(pasted.uri, { username: "me@x.com", issuer: "ChatGPT" });
  const lp = parseOtpAuth(linked);
  ok("the chosen login becomes the account and the secret is kept", lp?.account === "me@x.com" && lp?.issuer === "ChatGPT" && otpAuthSecret(linked) === "JBSWY3DPEHPK3PXP");
  ok("the client message carries only the link and the page", JSON.stringify(Object.keys(totpHandoff((linked as any), "https://chatgpt.com/connector/mfa")).sort()) === '["totpPageUrl","totpUri"]');
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
  const port = ({ sent: [], msg: [], gone: [], disconnected: false } as any);
  port.postMessage = (m: any) => port.sent.push((m as any));
  port.disconnect = () => { port.disconnected = true; };
  port.onMessage = { addListener: (fn: any) => port.msg.push((fn as any)) };
  port.onDisconnect = { addListener: (fn: any) => port.gone.push((fn as any)) };
  port.reply = (m: any) => port.msg.forEach((fn: any) => (fn as any)(m));
  port.drop = () => port.gone.forEach((fn: any) => (fn as any)());
  return port;
}
async function settles(promise: any) {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return `rejected: ${e.message}`;
  }
}
async function connectedClient() {
  const port = (fakeNative() as any);
  (globalThis as any).chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  const client = new ApplePasswords();
  const connecting = client.connect();
  port.reply({ cmd: Command.GET_CAPABILITIES, capabilities: {} });
  await connecting;
  return { client, port };
}
{
  const port = (fakeNative() as any);
  (globalThis as any).chrome = { runtime: { connectNative: () => port, lastError: undefined } };
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
delete (globalThis as any).chrome;

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

// verify_code: the reader, probe, fill and notify are spies, no chrome
ok("relayEvent: event code -> \"code\"; a message with id -> null", relayEvent({ event: "code", rid: "r", ok: true }) === "code" && relayEvent({ id: "1", event: "code" }) === null);
ok("isCodeHost: exact sign-in hosts only", ["appleid.apple.com", "account.apple.com", "idmsa.apple.com", "www.icloud.com", "icloud.com"].every(isCodeHost) && !isCodeHost("support.apple.com") && !isCodeHost("evil.idmsa.apple.com") && !isCodeHost("apple.com") && !isCodeHost("github.com"));
{
  const host = (u: string) => new URL(u).hostname;
  const picked = pickCodeFrames(
    [{ frameId: 0, url: "https://account.apple.com/sign-in" }, { frameId: 3, url: "https://idmsa.apple.com/x" }, { frameId: 4, url: "https://support.apple.com/x" }, { frameId: 5, url: "https://evil.com/x" }, null],
    ["apple.com"],
    host,
  );
  ok("pickCodeFrames: keeps top frame and allowlisted idmsa.apple.com child, drops support.apple.com and other hosts", picked.map((f) => `${f.frameId}:${f.host}`).join() === "0:account.apple.com,3:idmsa.apple.com");
  ok("pickCodeFrames: an Apple frame off the allowlist is dropped", pickCodeFrames([{ frameId: 0, url: "https://idmsa.apple.com/" }], ["github.com"], host).length === 0);
}
{
  const l = createLimiter(5, 1000);
  ok("limiter: per-op cap and shared cap", l.take(0, "v", 2) && l.take(1, "v", 2) && !l.take(2, "v", 2) && l.take(3) && l.take(4) && l.take(5) && !l.take(6));
  const p = createLimiter(5, 1000);
  p.take(0, "v", 1);
  ok("limiter: peek spends nothing", !p.peek(1, "v", 1) && p.peek(1, "w", 1) && p.dump().length === 1);
  const o = createLimiter(2, 1000);
  o.load([10, 20]);
  ok("limiter: load accepts the old number list", !o.take(30) && o.dump().every((h: any) => h.op === "") && o.take(2000));
  const r = createLimiter(5, 1000);
  r.load(o.dump());
  ok("limiter: load accepts its own dump", r.dump().length === o.dump().length);
}
ok("settings: agentCodeReader not in SETTINGS_DEFAULTS, so migrateSettingsToSync leaves it", !("agentCodeReader" in SETTINGS_DEFAULTS) && !String(migrateSettingsToSync).includes("agentCodeReader"));
{
  const calls: any = { read: 0, probe: 0, fill: [] as any[], notify: [] as any[] };
  const frame = { frameId: 3, host: "idmsa.apple.com" };
  const base = (over: any = {}) => ({
    client: { ready: false },
    getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["apple.com"] }),
    getTab: async () => ({ id: 1, url: "https://account.apple.com/sign-in" }),
    hostnameOf: (u: any) => new URL(u).hostname,
    isFillUrlAllowed: async () => true,
    isLocalDevHost: () => false,
    platform: async () => "mac",
    codeReaderOn: async () => true,
    codeFrames: async () => [frame],
    probeCodeField: async () => { calls.probe++; return frame; },
    readCode: async () => { calls.read++; return { ok: true, code: "482915" }; },
    fillCode: async (tabId: any, f: any, code: any) => { calls.fill.push([tabId, f, code]); return true; },
    notifyCode: (h: any, filled: any) => calls.notify.push([h, filled]),
    ...over,
  });
  const reset = () => { calls.read = 0; calls.probe = 0; calls.fill = []; calls.notify = []; };
  const vc = async (msg: any = {}, over: any = {}, lim = createLimiter(), now = 0) => { reset(); return (await handleAgentRequest({ op: "verify_code", tabId: 1, ...msg }, base(over) as any, lim, now)).reply; };

  let r = await vc({}, { codeReaderOn: async () => false });
  ok("verify_code: reader off -> code_reader_off, readCode not called", r.error === "not_allowed" && r.reason === "code_reader_off" && calls.read === 0);
  r = await vc({}, { getSettings: async () => ({ agentSignIn: false, agentAllowlist: ["apple.com"] }) });
  ok("verify_code: sign-in off -> not_enabled", r.error === "not_enabled" && calls.read === 0);
  r = await vc({}, { platform: async () => "linux" });
  ok("verify_code: platform() resolves neither mac nor win -> mac_only", r.error === "not_allowed" && r.reason === "mac_only" && calls.read === 0);
  r = await vc({}, { platform: async () => "win" });
  ok("verify_code: platform() resolves win -> the read runs", r.ok === true && calls.read === 1);
  r = await vc({}, { platform: async () => "mac" });
  ok("verify_code: platform() resolves mac -> the read runs", r.ok === true && calls.read === 1);
  r = await vc({}, { getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"], agentAllowAll: true }) });
  ok("verify_code: not allowlisted, allowAll on -> not_allowed", r.error === "not_allowed" && !r.reason && calls.probe === 0 && calls.read === 0);
  r = await vc({}, { getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"] }), getTab: async () => ({ id: 1, url: "https://github.com/login" }) });
  ok("verify_code: allowlisted non-Apple host -> not_apple_site", r.error === "not_allowed" && r.reason === "not_apple_site" && calls.read === 0);
  r = await vc({}, { getTab: async () => ({ id: 1, url: "https://support.apple.com/" }) });
  ok("verify_code: allowlisted support.apple.com -> not_apple_site, probe not called", r.reason === "not_apple_site" && calls.probe === 0);
  r = await vc({ site: "github.com" });
  ok("verify_code: site mismatch", r.error === "not_allowed" && r.reason === "site_mismatch" && calls.read === 0);
  ok("verify_code: site match passes", (await vc({ site: "apple.com" })).ok === true);
  r = await vc({}, { getTab: async () => ({ id: 1, url: "http://account.apple.com/" }), isFillUrlAllowed: async () => false });
  const b = await vc({}, { getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["apple.com"], blockedDomains: ["apple.com"] }) });
  ok("verify_code: http / blocked -> not_allowed", r.error === "not_allowed" && b.error === "not_allowed" && calls.read === 0);
  r = await vc({ url: "https://account.apple.com/" });
  ok("verify_code: url field -> bad_request", r.error === "bad_request" && calls.read === 0);
  r = await vc({}, { probeCodeField: async () => null });
  ok("verify_code: no field -> no_field, readCode not called", r.error === "no_field" && calls.read === 0);

  const lim = createLimiter();
  const a = [await vc({}, {}, lim, 0), await vc({}, {}, lim, 1), await vc({}, {}, lim, 2)];
  r = await vc({}, {}, lim, 3);
  ok("verify_code: 4th in 10 min -> rate_limited, probe not called", a.every((x) => x.ok) && r.error === "rate_limited" && calls.probe === 0 && calls.read === 0);
  ok("verify_code: rate_limited again frees after the window", (await vc({}, {}, lim, 11 * 60 * 1000)).ok === true);
  const sh = createLimiter(10, 600000);
  for (let i = 0; i < 8; i++) sh.take(0);
  await vc({}, {}, sh, 1);
  await vc({}, {}, sh, 2);
  r = await vc({}, {}, sh, 3);
  ok("verify_code: counts toward the shared 10", r.error === "rate_limited" && calls.read === 0);
  const nf = createLimiter();
  for (let i = 0; i < 3; i++) await vc({}, { probeCodeField: async () => null }, nf, i);
  ok("verify_code: 3 no_field calls, then a call with a field still reaches readCode", (await vc({}, {}, nf, 4)).ok === true && calls.read === 1);

  ok("verify_code: busy passes through", (await vc({}, { readCode: async () => ({ ok: false, error: "busy" }) })).error === "busy");
  const map: Record<string, any[]> = {
    reader_missing: ["reader_missing"], not_configured: ["not_configured"], no_prompt: ["no_prompt"], several_prompts: ["several_prompts"], reader_failed: ["reader_failed"],
  };
  let allMapped = true;
  for (const [e] of Object.entries(map)) allMapped = allMapped && (await vc({}, { readCode: async () => ({ ok: false, error: e }) })).error === e;
  r = await vc({}, { readCode: async () => ({ ok: false, error: "reader_permission" }) });
  ok("verify_code: each reader error maps per the reply table", allMapped && r.error === "needs_user" && r.reason === "reader_permission" && (await vc({}, { readCode: async () => ({ ok: false, error: "code_reader_off" }) })).reason === "code_reader_off" && (await vc({}, { readCode: async () => ({ ok: false, error: "weird" }) })).error === "reader_failed");

  r = await vc({}, { readCode: async () => ({ ok: true, code: "12ab56" }) });
  ok("verify_code: reader returns 12ab56 -> reader_failed, fillCode not called", r.error === "reader_failed" && calls.fill.length === 0);
  let n = 0;
  r = await vc({}, { codeReaderOn: async () => n++ < 1 });
  ok("verify_code: switch off before fill -> code dropped, fillCode not called", r.reason === "code_reader_off" && calls.fill.length === 0 && !JSON.stringify(r).includes("482915"));
  r = await vc();
  ok("verify_code: fillCode gets only the probed frame", calls.fill.length === 1 && calls.fill[0][1] === frame && calls.fill[0][0] === 1);
  r = await vc({}, { fillCode: async () => false });
  ok("verify_code: fill fails -> fill_failed, notifyCode(host,false)", r.error === "fill_failed" && calls.notify.length === 1 && calls.notify[0][0] === "account.apple.com" && calls.notify[0][1] === false);
  reset();
  const full = await handleAgentRequest({ op: "verify_code", tabId: 1, id: "q" }, base() as any, createLimiter(), 0);
  const safe = sanitizeReply({ ...full.reply, id: "q" });
  ok("verify_code happy path: reply keys are exactly ok, domain, filled, id; no digits; notifyCode(host,true) once", Object.keys(safe).sort().join() === "domain,filled,id,ok" && !/\d{3}/.test(JSON.stringify(safe)) && safe.domain === "account.apple.com" && calls.notify.length === 1 && calls.notify[0][1] === true && calls.notify[0][0] === "account.apple.com");
  ok("sanitizeReply drops a code key from a verify_code reply", !("code" in sanitizeReply({ ok: true, domain: "a.com", filled: true, code: "482915" })));
  const le = logEntry({ op: "verify_code", tabId: 1 }, full, safe);
  ok("logEntry verify_code: no digits, username empty", le.username === "" && le.op === "verify_code" && le.result === "ok" && !/\d{4}/.test(JSON.stringify({ ...le, t: 0 })));
}
// your own Apple sign-in: handleUserCode
{
  const calls: any = { read: 0, probe: [] as any[], fill: [] as any[], notify: [] as any[] };
  const sender = (over: any = {}) => ({ id: "me", tab: { id: 7 }, frameId: 3, url: "https://idmsa.apple.com/auth", ...over });
  const deps = (over: any = {}) => ({
    getSettings: async () => ({ agentSignIn: false, agentAllowlist: [], blockedDomains: [] }),
    hostnameOf: (u: any) => new URL(u).hostname,
    isFillUrlAllowed: async () => true,
    platform: async () => "mac",
    codeReaderOn: async () => true,
    probeCodeField: async (t: any, fr: any) => { calls.probe.push([t, fr]); return fr[0]; },
    readCode: async () => { calls.read++; return { ok: true, code: "482915" }; },
    fillCode: async (t: any, f: any, c: any) => { calls.fill.push([t, f, c]); return true; },
    notifyCode: (h: any, f: any) => calls.notify.push([h, f]),
    ...over,
  });
  const uc = async (sOver: any = {}, over: any = {}, lim = createLimiter(), now = 0) => { calls.read = 0; calls.probe = []; calls.fill = []; calls.notify = []; return handleUserCode(sender(sOver) as any, deps(over) as any, lim, now); };
  const untouched = () => calls.read === 0 && calls.fill.length === 0 && calls.notify.length === 0;
  let r = await uc();
  ok("user code: happy path fills the sender's own frame only, with agent sign-in off", r === true && calls.fill.length === 1 && calls.fill[0][0] === 7 && calls.fill[0][1].frameId === 3 && calls.fill[0][2] === "482915" && calls.notify[0].join() === "idmsa.apple.com,true");
  await uc({}, { codeReaderOn: async () => false });
  ok("user code: given the switch is off -> nothing is read", untouched());
  for (const url of ["https://apple.com.evil.io/", "https://evil.apple.com/", "https://github.com/", "https://x.idmsa.apple.com/"]) { await uc({ url }); ok(`user code: given ${url} -> nothing is read`, untouched() && calls.probe.length === 0); }
  await uc({ url: "http://idmsa.apple.com/" });
  ok("user code: given plain http -> nothing is read", untouched());
  await uc({}, { getSettings: async () => ({ blockedDomains: ["idmsa.apple.com"] }) });
  ok("user code: given a blocked Apple host -> nothing is read", untouched());
  await uc({}, { isFillUrlAllowed: async () => false });
  ok("user code: given a dev host or refused url -> nothing is read", untouched());
  await uc({}, { platform: async () => "linux" });
  ok("user code: given another platform -> nothing is read", untouched());
  await uc({ tab: undefined });
  await uc({ frameId: undefined });
  ok("user code: given a sender with no tab or frame -> ignored", untouched() && calls.probe.length === 0);
  await uc({ url: "https://IDMSA.apple.com/x" });
  ok("user code: an upper-case host is lowered before the probe", calls.probe[0]?.[1][0].host === "idmsa.apple.com");
  await uc({}, { probeCodeField: async () => null });
  ok("user code: given no code field in the frame -> nothing is read", untouched());
  for (const err of ["no_prompt", "several_prompts", "busy", "reader_failed"]) { await uc({}, { readCode: async () => ({ ok: false, error: err }) }); ok(`user code: reader says ${err} -> silent, nothing filled`, calls.fill.length === 0 && calls.notify.length === 0); }
  await uc({}, { readCode: async () => ({ ok: true, code: "12ab56" }) });
  ok("user code: a reply that is not 6 digits -> nothing is filled", calls.fill.length === 0 && calls.notify.length === 0);
  let n = 0;
  await uc({}, { codeReaderOn: async () => n++ < 1 });
  ok("user code: given the switch goes off while the read runs -> nothing is filled", calls.fill.length === 0);
  r = await uc({}, { fillCode: async () => false });
  ok("user code: given the probed field is gone -> not filled, notification says so", r === false && calls.notify[0].join() === "idmsa.apple.com,false");
  const lim = createLimiter();
  const res = [];
  for (let i = 0; i < 4; i++) res.push(await uc({}, {}, lim, i));
  ok("user code: more than 3 reads in 10 minutes -> the 4th is dropped", res.join() === "true,true,true,false" && calls.read === 0);
  const lim2 = createLimiter(); lim2.load(lim.dump());
  ok("user code: the limit survives a restart (dump then load)", !(await uc({}, {}, lim2, 5)));
  const lim3 = createLimiter();
  for (let i = 0; i < 3; i++) await uc({}, {}, lim3, i);
  const vcr = (await handleAgentRequest({ op: "verify_code", tabId: 1 }, { client: { ready: false }, getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["apple.com"] }), getTab: async () => ({ id: 1, url: "https://idmsa.apple.com/" }), hostnameOf: (u: any) => new URL(u).hostname, isFillUrlAllowed: async () => true, isLocalDevHost: () => false, platform: async () => "mac", codeReaderOn: async () => true, codeFrames: async () => [{ frameId: 0, host: "idmsa.apple.com" }], probeCodeField: async (_t: any, f: any) => f[0], readCode: async () => ({ ok: true, code: "482915" }), fillCode: async () => true, notifyCode() {} } as any, lim3, 6)).reply;
  ok("user code: the agent verify_code limit is counted apart", vcr.ok === true);
  ok("user code: no digits in any notification or call except the one fill", !JSON.stringify(calls.notify).match(/\d{4}/));
}
// initAgent with a fake native port: a code event whose rid is not the read in flight is dropped, never reaches onRequest or the page
{
  const listeners: any[] = [];
  const posted: any[] = [];
  const port = { onMessage: { addListener: (f: any) => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: (m: any) => posted.push(m), disconnect() {} };
  const stub = { get: async (d: any) => ({ ...(d && typeof d === "object" ? d : {}) }), set: async () => {}, remove: async () => {} };
  (globalThis as any).chrome = {
    runtime: { connectNative: () => port, lastError: undefined },
    storage: { sync: { ...stub, get: (d: any, cb: any) => cb({ ...d, agentSignIn: true }) }, local: stub, session: stub, onChanged: { addListener() {} } },
  };
  const spy: any = { fill: [] as any[], notify: [] as any[] };
  const frame = { frameId: 0, host: "idmsa.apple.com" };
  const aclient = { ready: true };
  const pinSpy: string[] = [];
  const agentApi = initAgent({
    client: aclient,
    pairStart: async () => {},
    pairPin: async (pin: string) => { pinSpy.push(pin); return { ok: true }; },
    getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["apple.com"] }),
    getTab: async () => ({ id: 1, url: "https://idmsa.apple.com/" }),
    hostnameOf: (u: any) => new URL(u).hostname,
    isFillUrlAllowed: async () => true,
    isLocalDevHost: () => false,
    platform: async () => (aclient.ready ? "mac" : "win"),
    codeReaderOn: async () => true,
    codeFrames: async () => [frame],
    probeCodeField: async () => frame,
    fillCode: async (_t: any, _f: any, code: any) => { spy.fill.push(code); return true; },
    notifyCode: (h: any, filled: any) => spy.notify.push([h, filled]),
  } as any);
  const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await until(() => listeners.length > 0);
  const deliver = (m: any) => listeners.forEach((f) => f(m));
  deliver({ event: "active", code: true });
  deliver({ id: "r1", op: "verify_code", tabId: 1 });
  await until(() => posted.some((m) => m.cmd === "read_code"));
  const rid = posted.find((m) => m.cmd === "read_code")?.rid;
  deliver({ event: "code", rid: "not-the-read", ok: true, code: "111111" });
  deliver({ event: "code", rid: undefined, ok: true, code: "222222" });
  await new Promise((r) => setTimeout(r, 50));
  ok("initAgent: a code event with another rid is dropped, nothing is filled or answered", !!rid && spy.fill.length === 0 && !posted.some((m) => m.id === "r1"));
  deliver({ event: "code", rid, ok: true, code: "482915" });
  await until(() => posted.some((m) => m.id === "r1"));
  const answer = posted.find((m) => m.id === "r1");
  ok("initAgent: the matching rid fills once and the reply has no digits", spy.fill.join() === "482915" && answer?.ok === true && !/\d{4}/.test(JSON.stringify({ ...answer, id: "" })));
  // your own sign-in through the returned userCode: same relay read, nothing posted back with a result
  spy.fill = [];
  const before = posted.length;
  const done = agentApi.userCode({ id: "me", tab: { id: 1 }, frameId: 0, url: "https://idmsa.apple.com/" } as any);
  await until(() => posted.filter((m) => m.cmd === "read_code").length > 1);
  const rid2 = posted.filter((m) => m.cmd === "read_code")[1]?.rid;
  deliver({ event: "code", rid: rid2, ok: true, code: "135790" });
  await done;
  ok("initAgent: userCode reads through the relay, fills once and posts no reply or log row", spy.fill.join() === "135790" && posted.slice(before).every((m) => m.cmd === "read_code"));
  // a message from another extension, or one with no tab or frame, reaches no reader
  posted.length = 0;
  await agentApi.userCode({ id: "other-ext", url: "https://idmsa.apple.com/" } as any);
  await agentApi.userCode({ id: "other-ext", tab: { id: 1 }, url: "https://idmsa.apple.com/" } as any);
  ok("initAgent: userCode from a sender with no tab or frame posts no read_code", !posted.some((m) => m.cmd === "read_code"));
  // unlock through the port: a relay that says code but not pin (1.4.32) is never sent a pin read, it would press Allow
  aclient.ready = false;
  posted.length = 0;
  deliver({ id: "u1", op: "unlock" });
  await until(() => posted.some((m) => m.id === "u1"));
  ok("initAgent: a relay without pin: true -> unlock is reader_missing and no read_code is posted", posted.find((m) => m.id === "u1")?.error === "reader_missing" && !posted.some((m) => m.cmd === "read_code"));
  deliver({ event: "active", code: true, pin: true });
  posted.length = 0;
  deliver({ id: "u2", op: "unlock" });
  await until(() => posted.some((m) => m.cmd === "read_code"));
  const prid = posted.find((m) => m.cmd === "read_code");
  ok("initAgent: a relay with pin: true gets read_code with kind pin", prid?.kind === "pin");
  deliver({ event: "code", rid: prid.rid, ok: true, code: "482915" });
  await until(() => posted.some((m) => m.id === "u2"));
  const ua = posted.find((m) => m.id === "u2");
  ok("initAgent: the pin goes to pairPin only; the unlock reply has no digits", pinSpy.join() === "482915" && ua?.ok === true && ua?.state === "paired" && !JSON.stringify(ua).includes("482915"));
}

// the own-sign-in limit survives a restart of the service worker: a second initAgent reads the hits the first one saved
{
  const store: any = {};
  const make = () => {
    const listeners: any[] = [];
    const posted: any[] = [];
    const port = { onMessage: { addListener: (f: any) => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: (m: any) => posted.push(m), disconnect() {} };
    const stub = { get: async (d: any) => ({ ...(d && typeof d === "object" ? d : {}) }), set: async () => {}, remove: async () => {} };
    (globalThis as any).chrome = {
      runtime: { connectNative: () => port, lastError: undefined },
      storage: {
        sync: { ...stub, get: (d: any, cb: any) => cb({ ...d, agentSignIn: false }) },
        local: { ...stub, get: async (d: any) => ({ ...(d && typeof d === "object" ? d : {}), agentCodeReader: true }) },
        session: { get: async (k: any) => ({ [k]: store[k] }), set: async (o: any) => Object.assign(store, o), remove: async () => {} },
        onChanged: { addListener() {} },
      },
    };
    const frame = { frameId: 0, host: "idmsa.apple.com" };
    const aclient = { ready: true };
    const fills: any[] = [];
    const api = initAgent({
      client: aclient,
      pairStart: async () => {},
      pairPin: async () => ({ ok: true }),
      getSettings: async () => ({ agentSignIn: false, agentAllowlist: [] }),
      getTab: async () => ({ id: 1, url: "https://idmsa.apple.com/" }),
      hostnameOf: (u: any) => new URL(u).hostname,
      isFillUrlAllowed: async () => true,
      isLocalDevHost: () => false,
      platform: async () => "mac",
      codeReaderOn: async () => true,
      codeFrames: async () => [frame],
      probeCodeField: async () => frame,
      fillCode: async (_t: any, _f: any, code: any) => { fills.push(code); return true; },
      notifyCode: () => {},
    } as any);
    return { api, listeners, posted, fills };
  };
  const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
  const sender = { id: "me", tab: { id: 1 }, frameId: 0, url: "https://idmsa.apple.com/" } as any;
  const first = make();
  await until(() => first.listeners.length > 0);
  first.listeners.forEach((f) => f({ event: "active", code: true }));
  for (let i = 0; i < 3; i++) {
    const n = first.posted.filter((m) => m.cmd === "read_code").length;
    const done = first.api.userCode(sender);
    await until(() => first.posted.filter((m) => m.cmd === "read_code").length > n);
    const rid = first.posted.filter((m) => m.cmd === "read_code")[n]?.rid;
    first.listeners.forEach((f) => f({ event: "code", rid, ok: true, code: "135790" }));
    await done;
  }
  ok("initAgent: three own-sign-in reads fill three times", first.fills.length === 3);
  const second = make();
  await until(() => second.listeners.length > 0);
  second.listeners.forEach((f) => f({ event: "active", code: true }));
  await second.api.userCode(sender);
  ok("initAgent: after a restart the 4th own-sign-in read in 10 minutes is dropped, no read_code", !second.posted.some((m) => m.cmd === "read_code") && second.fills.length === 0);
}
// the background side of userCodeRequest: allowed from a content script, answered {ok:true} before the read starts, the page gets nothing else
{
  const bg = readFileSync(new URL("../../src/background.js", import.meta.url), "utf8");
  const allowed = bg.slice(bg.indexOf("const CONTENT_ALLOWED"), bg.indexOf("]);", bg.indexOf("const CONTENT_ALLOWED")));
  ok("background: userCodeRequest is in CONTENT_ALLOWED", allowed.includes('"userCodeRequest"'));
  const at = bg.indexOf('case "userCodeRequest":');
  const handler = bg.slice(at, bg.indexOf("break;", at));
  const reply = handler.indexOf("sendResponse({ ok: true })");
  const run = handler.indexOf("agent.userCode(sender)");
  ok("background: the page reply is exactly { ok: true }, sent before the read and without awaiting it", reply > -1 && run > reply && !handler.includes("await") && (handler.match(/sendResponse\(/g) || []).length === 1);
  ok("background: another extension is refused before the handler (sender id and tab are checked)", bg.includes("sender.id === chrome.runtime.id && sender.tab !== undefined") && /!fromUi && !\(fromContent && CONTENT_ALLOWED\.has/.test(bg));
}

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
    hostnameOf: (u: any) => new URL(u).hostname,
    isFillUrlAllowed: async () => true,
    siteLogins: async () => [{ username: "a@x.com" }, { username: "b@x.com" }],
    uniqueByUsername: (l: any) => l,
    fillLoginOnTab: async (tab: any, username: any) => ({ filled: true, username, password: "leak" }),
    ...over,
  });
  const run = (msg: any, d = deps(), lim = createLimiter(), now?: number) => handleAgentRequest(msg, (d as any), lim, now);
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

  // pairing: no tab, a pin of exactly 6 digits, 5 wrong in a row lock until pair_start
  {
    const store: Record<string, any> = {};
    (globalThis as any).chrome = { storage: { session: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: any) => Object.assign(store, o) } } };
    const asked: any[] = [];
    const tried: string[] = [];
    let good = "123456";
    const pd = (over = {}) =>
      deps({
        client: { ready: false },
        pairStart: async (o: any) => { asked.push(o); },
        pairPin: async (pin: string) => { tried.push(pin); return pin === good ? { ok: true, state: "ready" } : { ok: false, error: "x" }; },
        getTab: async () => { throw new Error("no tab needed"); },
        ...over,
      });
    ok("agent: pair_start while disabled is not_enabled", (await run({ op: "pair_start" }, deps({ getSettings: async () => ({ agentSignIn: false }) }))).reply.error === "not_enabled");
    ok("agent: pair_start needs no tab and asks for a code", (await run({ op: "pair_start" }, pd())).reply.state === "needs_pin" && asked[0].ifNeeded === true);
    const already = await run({ op: "pair_start" }, pd({ client: { ready: true } }));
    ok("agent: pair_start when already paired says paired and asks for nothing", already.reply.state === "paired" && asked.length === 1);
    for (const pin of [undefined, 123456, "12345", "1234567", "12ab56", " 12345"]) {
      ok(`agent: pair_pin ${JSON.stringify(pin)} is bad_pin`, (await run({ op: "pair_pin", pin }, pd())).reply.error === "bad_pin");
    }
    ok("agent: a bad_pin never reaches Apple", tried.length === 0);
    const wrong = await run({ op: "pair_pin", pin: "000000" }, pd());
    ok("agent: a wrong pin is wrong_pin", wrong.reply.ok === false && wrong.reply.error === "wrong_pin");
    for (let i = 0; i < 4; i++) await run({ op: "pair_pin", pin: "000000" }, pd());
    const lockedOut = await run({ op: "pair_pin", pin: good }, pd());
    ok("agent: after 5 wrong pins even the right one is locked", lockedOut.reply.error === "locked" && !tried.includes(good));
    await run({ op: "pair_start" }, pd());
    const okPin = await run({ op: "pair_pin", pin: good }, pd());
    ok("agent: pair_start unlocks and the right pin pairs", okPin.reply.ok === true && okPin.reply.state === "paired");
    ok("agent: the pair reply has only ok and state", Object.keys(okPin.reply).sort().join() === "ok,state");
    const entry = logEntry({ op: "pair_pin", pin: "123456" }, okPin, okPin.reply);
    ok("agent: the log entry for pair_pin has no pin", !JSON.stringify(entry).includes("123456") && entry.op === "pair_pin");
    const rl = createLimiter(1, 1000);
    await run({ op: "pair_pin", pin: "000000" }, pd(), rl);
    ok("agent: both pair ops count toward the rate limit", (await run({ op: "pair_start" }, pd(), rl)).reply.error === "rate_limited");
    delete (globalThis as any).chrome;
  }

  // unlock: pair a locked store with the code read on this computer (Windows, code-reader switch). the digits are made-up values
  {
    const store: Record<string, any> = {};
    (globalThis as any).chrome = { storage: { session: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: any) => Object.assign(store, o) } } };
    const spy: any = { start: 0, read: 0, kinds: [] as any[], tried: [] as string[] };
    const ud = (over = {}) =>
      deps({
        client: { ready: false },
        platform: async () => "win",
        codeReaderOn: async () => true,
        pairStart: async () => { spy.start++; },
        pairPin: async (pin: string) => { spy.tried.push(pin); return pin === "482915" ? { ok: true, state: "ready" } : { ok: false, error: "x" }; },
        readCode: async (kind: any) => { spy.read++; spy.kinds.push(kind); return { ok: true, code: "482915" }; },
        getTab: async () => { throw new Error("no tab needed"); },
        ...over,
      });
    const reset = () => { spy.start = 0; spy.read = 0; spy.kinds = []; spy.tried = []; store.agentPinFails = 0; };
    const un = async (over = {}, lim = createLimiter(), now = 0) => { reset(); return run({ op: "unlock" }, ud(over), lim, now); };
    let r = await un({ codeReaderOn: async () => false });
    ok("unlock: given the code-reader switch is off -> expect not_allowed with reason code_reader_off and no read started", r.reply.error === "not_allowed" && r.reply.reason === "code_reader_off" && spy.start === 0 && spy.read === 0);
    r = await un({ platform: async () => "mac" });
    ok("unlock: given the platform is Mac -> expect not_allowed with reason win_only", r.reply.error === "not_allowed" && r.reply.reason === "win_only" && spy.start === 0 && spy.read === 0);
    r = await un({ client: { ready: true } });
    ok("unlock: given the store is already paired -> expect ok state paired and no read started", r.reply.ok === true && r.reply.state === "paired" && spy.start === 0 && spy.read === 0);
    const lim = createLimiter();
    const rs = [await un({}, lim, 0), await un({}, lim, 1), await un({}, lim, 2), await un({}, lim, 3)];
    ok("unlock: given 3 unlocks in 10 minutes -> expect rate_limited on the 4th", rs.slice(0, 3).every((x) => x.reply.ok === true) && rs[3].reply.error === "rate_limited");
    reset();
    store.agentPinFails = 5;
    r = await run({ op: "unlock" }, ud());
    ok("unlock: given 5 wrong codes in a row -> expect locked", r.reply.error === "locked" && spy.read === 0 && spy.start === 0);
    r = await un({ readCode: async () => ({ ok: false, error: "no_prompt" }) });
    ok("unlock: given the pairing window never appears -> expect no_prompt and nothing entered", r.reply.error === "no_prompt" && spy.tried.length === 0);
    r = await un({ readCode: async () => ({ ok: false, error: "reader_missing" }) });
    ok("unlock: given the reader script is missing -> expect reader_missing", r.reply.error === "reader_missing" && spy.tried.length === 0);
    r = await un({ readCode: async () => ({ ok: true, code: "12ab56" }) });
    ok("unlock: given the reader returns something that is not 6 digits -> expect reader_failed and nothing entered", r.reply.error === "reader_failed" && spy.tried.length === 0);
    r = await un({ readCode: async () => ({ ok: true, code: "000000" }) });
    ok("unlock: given Apple rejects the code -> expect wrong_pin", r.reply.error === "wrong_pin" && store.agentPinFails === 1);
    let n = 0;
    r = await un({ codeReaderOn: async () => n++ < 1 });
    ok("unlock: given the switch is turned off during the read -> expect the read is cancelled and not_allowed with reason code_reader_off", r.reply.error === "not_allowed" && r.reply.reason === "code_reader_off" && spy.tried.length === 0);
    r = await un({ readCode: async () => ({ ok: false, error: "reader_missing" }) });
    ok("unlock: given an older relay without code support -> expect reader_missing", r.reply.error === "reader_missing");
    r = await un();
    const entry = logEntry({ op: "unlock" }, r, r.reply);
    const safe = sanitizeReply({ ...r.reply, id: "u" });
    ok("unlock: given a successful unlock -> expect the reply, the Activity log and storage hold no digits", r.reply.ok === true && spy.kinds[0] === "pin" && spy.tried[0] === "482915" && !JSON.stringify([safe, entry, store]).includes("482915") && Object.keys(safe).sort().join() === "id,ok,state");
    delete (globalThis as any).chrome;
  }

  // save: add-only, gated by its own setting
  let saves: any[] = [];
  const saveDeps = (over = {}, settings = {}) =>
    deps({
      getSettings: async () => ({ agentSignIn: true, agentSave: true, agentAllowlist: [], ...settings }),
      isLocalDevHost: (h: any) => h === "localhost",
      siteLogins: async () => [{ username: "a@x.com" }],
      saveLogin: async (...a: any[]) => { saves.push(a); return true; },
      notifySaved: () => {},
      ...over,
    });
  const save = (msg = {}, d = saveDeps(), l = createLimiter()) => run({ op: "save", tabId: 1, username: "new@x.com", password: "Sup3r-secret", ...msg }, d, l);
  ok("agent: agentSaveAllowed returns the setting", agentSaveAllowed({ agentSave: true }) === true && agentSaveAllowed({ agentSave: false }) === false && agentSaveAllowed({}) === false && agentSaveAllowed(null) === false);
  const off = await save({}, saveDeps({}, { agentSave: false }));
  ok("agent: save with the setting off is not_allowed and saves nothing", off.reply.error === "not_allowed" && off.reply.reason === "save_off" && saves.length === 0);
  const none = await save({}, saveDeps({}, { agentSave: undefined }));
  ok("agent: save with the setting missing is not_allowed", none.reply.error === "not_allowed");
  const added = await save();
  ok("agent: save adds a new login on a site not on the allowlist", added.reply.ok && added.reply.username === "new@x.com" && added.reply.domain === "github.com" && saves.length === 1 && saves[0][3] === "Sup3r-secret");
  ok("agent: the save reply and the log entry hold no password", !JSON.stringify(sanitizeReply({ ...added.reply, id: "1" })).includes("Sup3r-secret") && !JSON.stringify(logEntry({ op: "save", tabId: 1, username: "new@x.com", password: "Sup3r-secret" }, added, sanitizeReply(added.reply))).includes("Sup3r-secret"));
  const entry = logEntry({ op: "save", tabId: 1, username: "new@x.com", password: "Sup3r-secret" }, added, sanitizeReply(added.reply), 5);
  ok("agent: the save log entry is op, tabId, site and username", entry.op === "save" && entry.tabId === 1 && entry.host === "github.com" && entry.username === "new@x.com" && !("password" in entry));
  saves = [];
  const dup = await save({ username: " A@x.com " });
  ok("agent: save of an existing username is exists and never calls the save", dup.reply.error === "exists" && saves.length === 0 && !JSON.stringify(dup).includes("Sup3r-secret"));
  ok("agent: save without a password is bad_request", (await save({ password: "" })).reply.error === "bad_request");
  ok("agent: save without a username is bad_request", (await save({ username: "" })).reply.error === "bad_request");
  ok("agent: save on plain http is not_allowed", (await save({}, saveDeps({ getTab: async () => ({ id: 1, url: "http://shop.example.org/" }) }))).reply.error === "not_allowed");
  ok("agent: save on a dev host is not_allowed", (await save({}, saveDeps({ getTab: async () => ({ id: 1, url: "https://localhost/" }) }))).reply.error === "not_allowed");
  ok("agent: save with a site that does not match the tab is site_mismatch", (await save({ site: "other.com" })).reply.reason === "site_mismatch");
  // save by url: no tab
  saves = [];
  const byUrl = (msg: any = {}, d = saveDeps({ getTab: async () => { throw new Error("no tab expected"); } })) => run({ op: "save", url: "https://github.com/login", username: "new@x.com", password: "Sup3r-secret", ...msg }, d, createLimiter());
  const viaUrl = await byUrl();
  ok("agent: save by url adds a login with no tab", viaUrl.reply.ok && viaUrl.reply.domain === "github.com" && saves.length === 1 && saves[0][0] === undefined && saves[0][1] === "https://github.com/login" && saves[0][3] === "Sup3r-secret");
  ok("agent: save by url on plain http is not_allowed", (await byUrl({ url: "http://github.com/login" })).reply.error === "not_allowed");
  ok("agent: save by url on a dev host is not_allowed", (await byUrl({ url: "https://localhost/login" })).reply.error === "not_allowed");
  ok("agent: save by url that is not a url is bad_request", (await byUrl({ url: "not a url" })).reply.error === "bad_request" && (await byUrl({ url: 5 })).reply.error === "bad_request");
  ok("agent: save with both tabId and url is bad_request", (await byUrl({ tabId: 1 })).reply.error === "bad_request");
  ok("agent: save with neither tabId nor url is bad_request", (await run({ op: "save", username: "new@x.com", password: "Sup3r-secret" }, saveDeps(), createLimiter())).reply.error === "bad_request");
  ok("agent: logins and sign_in with a url are bad_request", (await run({ op: "logins", url: "https://github.com/" }, saveDeps(), createLimiter())).reply.error === "bad_request" && (await run({ op: "sign_in", url: "https://github.com/" }, saveDeps(), createLimiter())).reply.error === "bad_request");
  saves = [];
  ok("agent: save by url of an existing username is exists", (await byUrl({ username: "A@x.com" })).reply.error === "exists" && saves.length === 0);
  ok("agent: save by url with a site that does not match is site_mismatch", (await byUrl({ site: "other.com" })).reply.reason === "site_mismatch");
  const urlEntry = logEntry({ op: "save", url: "https://github.com/login?next=/secret", username: "new@x.com", password: "Sup3r-secret" }, viaUrl, sanitizeReply(viaUrl.reply), 5);
  ok("agent: the url save log entry has the origin, no tabId, path, query or password", urlEntry.url === "https://github.com" && !("tabId" in urlEntry) && !JSON.stringify(urlEntry).includes("Sup3r-secret") && !JSON.stringify(urlEntry).includes("secret?") && !JSON.stringify(urlEntry).includes("/login"));
  ok("agent: save an unpaired client is needs_user", (await save({}, saveDeps({ client: { ready: false } }))).reply.error === "needs_user");
  ok("agent: save with an unanswered Apple prompt is needs_user", (await save({}, saveDeps({ saveLogin: async () => { throw new Error("timeout"); } }))).reply.error === "needs_user");
  const slim = createLimiter(1, 1000);
  await save({}, saveDeps(), slim);
  ok("agent: save counts toward the rate limit", (await save({}, saveDeps(), slim)).reply.error === "rate_limited");
  ok("agent: status shows save", (await run({ op: "status" }, saveDeps())).save === true && (await run({ op: "status" }, saveDeps({}, { agentSave: false }))).save === false);

  // every-site: the host is off the list and the setting decides
  const isDev = (h: any) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".test");
  const saved = (...sites: any[]) => ({ username: "u@x.com", sites, saved: sites });
  const all = (over = {}, settings = {}) =>
    deps({
      getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"], agentAllowAll: true, ...settings }),
      getTab: async () => ({ id: 1, url: "https://shop.example.org/login" }),
      isLocalDevHost: isDev,
      siteLogins: async () => [saved("example.org")],
      ...over,
    });
  const tabAt = (url: any) => ({ getTab: async () => ({ id: 1, url }) });
  const logins = (d: any, msg = {}) => run({ op: "logins", tabId: 1, ...msg }, d);
  ok("every-site: default off refuses an unlisted host", (await logins(all({}, { agentAllowAll: false }))).reply.error === "not_allowed");
  ok("every-site: a missing setting refuses", (await logins(all({}, { agentAllowAll: undefined }))).reply.error === "not_allowed");
  ok("every-site: on allows an unlisted https host", (await logins(all())).reply.usernames?.join() === "u@x.com");
  ok("every-site: http with canFillOnHttp is refused", (await logins(all(tabAt("http://shop.example.org/"), { canFillOnHttp: true }))).reply.error === "not_allowed");
  ok("every-site: https://localhost is refused", (await logins(all(tabAt("https://localhost/")))).reply.error === "not_allowed");
  ok("every-site: a .test host is refused", (await logins(all(tabAt("https://shop.example.test/")))).reply.error === "not_allowed");
  ok("every-site: a lookalike saved site is refused", (await logins(all({ siteLogins: async () => [saved("evilexample.org")] }))).reply.usernames?.length === 0);
  ok("every-site: a login saved for another domain is filtered out", (await logins(all({ siteLogins: async () => [saved("college.edu"), saved("example.org")] }))).reply.usernames?.length === 1);
  ok("every-site: a login with no sites is filtered out", (await logins(all({ siteLogins: async () => [{ username: "n@x.com", sites: [], saved: [] }, { username: "m@x.com", sites: ["shop.example.org"] }] }))).reply.usernames?.length === 0);
  ok("every-site: sign_in with nothing saved is no_login", (await run({ op: "sign_in", tabId: 1 }, all({ siteLogins: async () => [saved("college.edu")] }))).reply.error === "no_login");
  let seen = (null as any);
  const fillSeen = async (tab: any, username: any, opts: any) => ((seen = opts), { filled: true, username });
  const filled = await run({ op: "sign_in", tabId: 1 }, all({ fillLoginOnTab: fillSeen }));
  ok("every-site: sign_in fills with savedOnly and no frame allowlist", filled.reply.ok && seen?.savedOnly === true && !("frameAllowlist" in seen));
  ok("every-site: a request carrying agentAllowAll changes nothing", (await logins(all({}, { agentAllowAll: false }), { agentAllowAll: true, settings: { agentAllowAll: true } })).reply.error === "not_allowed");
  ok("every-site: a listed site is unchanged with the setting on", (await run({ op: "sign_in", tabId: 1, username: "a@x.com" }, deps({ getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"], agentAllowAll: true }), fillLoginOnTab: fillSeen }))).reply.ok && Array.isArray(seen?.frameAllowlist) && !seen.savedOnly);
  ok("every-site: a blocked domain is refused", (await logins(all({}, { blockedDomains: ["example.org"] }))).reply.error === "not_allowed");
  ok("every-site: a blocked domain is refused on a listed site too", (await logins(deps({ getSettings: async () => ({ agentSignIn: true, agentAllowlist: ["github.com"], blockedDomains: ["github.com"] }) }))).reply.error === "not_allowed");
  ok("every-site: status reports allowAll", (await run({ op: "status" }, all())).allowAll === true && (await run({ op: "status" })).allowAll === false);
  ok("every-site: no password in any reply", !/leak|password/i.test(JSON.stringify([filled.reply, await logins(all()), await run({ op: "status" }, all())])));

  // the site field
  const withSite = (site: any, d = deps()) => logins(d, { site });
  ok("site: the exact host matches", (await withSite("github.com")).reply.ok === true);
  ok("site: a URL matches", (await withSite("https://github.com/login")).reply.ok === true);
  ok("site: a subdomain of the site matches", (await withSite("github.com", deps(tabAt("https://gist.github.com/")))).reply.ok === true);
  const mismatch = await withSite("example.org");
  ok("site: a different site is site_mismatch", mismatch.reply.error === "not_allowed" && mismatch.reply.reason === "site_mismatch");
  ok("site: the parent of the tab host does not match a deeper site", (await withSite("gist.github.com")).reply.reason === "site_mismatch");
  ok("site: a lookalike is site_mismatch", (await withSite("hub.com")).reply.reason === "site_mismatch");
  ok("site: absent still works", (await logins(deps())).reply.ok === true);
  ok("site: a bad value is site_mismatch", (await withSite("")).reply.reason === "site_mismatch" && (await withSite("http://")).reply.reason === "site_mismatch" && (await withSite(42)).reply.reason === "site_mismatch");
  ok("site: the guard applies to every-site too", (await logins(all(), { site: "github.com" })).reply.reason === "site_mismatch");

  ok("site helpers: onSiteOrSubdomain", onSiteOrSubdomain("a.b.com", "b.com") && onSiteOrSubdomain("b.com", "b.com") && !onSiteOrSubdomain("ab.com", "b.com") && !onSiteOrSubdomain("a.com", "com") && onSiteOrSubdomain("localhost", "localhost"));
  ok("site helpers: loginSavedFor", loginSavedFor("x.org", ["https://www.x.org/"]) && loginSavedFor("sub.x.org", ["x.org"]) && !loginSavedFor("x.org", ["evilx.org"]) && !loginSavedFor("x.org", []) && !loginSavedFor("x.org", undefined) && !loginSavedFor("www.x.org", ["y.org"]));
}
ok("update: a higher release tag is newer", isNewerVersion("v1.4.0", "1.3.1") && isNewerVersion("1.3.10", "1.3.9"));
ok("update: the same or an older release is not newer", !isNewerVersion("v1.3.1", "1.3.1") && !isNewerVersion("1.3", "1.3.0") && !isNewerVersion("v1.2.9", "1.3.0"));
ok("update: a tag that is no version is never newer", !isNewerVersion("desktop-preview", "1.3.1") && !isNewerVersion(undefined, "1.3.1"));
{
  const run = async (fetchManifest: () => Promise<unknown>, running = "1.4.26") => {
    let reloads = 0;
    const did = await reloadIfStale({ fetchManifest, running, reload: () => void reloads++ });
    return did && reloads === 1 ? "reloaded" : !did && reloads === 0 ? "kept" : "mismatch";
  };
  ok("stale: newer files on disk reload this profile", (await run(async () => ({ version: "1.4.27" }))) === "reloaded");
  ok("stale: the same or an older version on disk keeps running", (await run(async () => ({ version: "1.4.26" }))) === "kept" && (await run(async () => ({ version: "1.4.25" }))) === "kept");
  ok("stale: a failed read or a manifest with no version keeps running", (await run(async () => { throw new Error("gone"); })) === "kept" && (await run(async () => null)) === "kept" && (await run(async () => ({ version: "garbage" }))) === "kept");
}

// chrome.storage.local in memory, callback and promise forms, plus a fetch that counts its calls
const realFetch = globalThis.fetch;
const signedAssets = [
  { name: "passbridge.zip", size: 1, digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://dl.test/passbridge.zip" },
  { name: "passbridge.zip.sig", browser_download_url: "https://dl.test/passbridge.zip.sig" },
];
function fakeUpdateEnv(seed: any = {}, reply: any = { ok: true, json: async () => ({ tag_name: "v1.4.0", assets: signedAssets }) }) {
  const data = ({ ...seed } as any);
  const pick = (keys: any) => {
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    return { ...keys, ...data };
  };
  const local = {
    get: (keys: any, cb: any) => (cb ? cb(pick(keys)) : Promise.resolve(pick(keys))),
    set: (o: any, cb: any) => {
      Object.assign(data, o);
      cb?.();
      return Promise.resolve();
    },
    remove: (keys: any) => {
      for (const k of [keys].flat()) delete data[k];
      return Promise.resolve();
    },
  };
  // settings live in sync, machine state in local; one in-memory map serves both
  (globalThis as any).chrome = { storage: { local, sync: local }, runtime: { lastError: undefined } };
  const env = ({ data, fetched: [], inits: [] } as any);
  globalThis.fetch = ((async (url: any, init: any) => {
    env.fetched.push((String(url) as any));
    env.inits.push((init as any));
    if (reply instanceof Error) throw reply;
    return reply;
  }) as any);
  return env;
}
const NOW = Date.UTC(2026, 9, 25);
{
  const env = fakeUpdateEnv();
  await checkForUpdate(NOW);
  ok("update: a first check asks GitHub for the latest release", env.fetched.join() === "https://api.github.com/repos/MehdiMamas/passbridge/releases/latest");
  ok("update: the check keeps the tag and the time", (env.data as any).latestRelease === "v1.4.0" && (env.data as any).updateCheckedAt === NOW);
  const update = await availableUpdate("1.3.1");
  ok("update: a newer release is offered with its release page", update?.version === "1.4.0" && update?.url === "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.0");
  ok("update: the installed version is not offered", (await availableUpdate("1.4.0")) === null);
  await dismissUpdate();
  ok("update: a dismissed release is not offered again", (await availableUpdate("1.3.1")) === null);
  (env.data as any).latestRelease = "v1.5.0";
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
  ok("update: force skips the wait", env.fetched.length === 1 && reached === true && (env.data as any).updateCheckedAt === NOW);
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
  // managed install: the marker file turns the update flags off whatever is saved
  const managedSettings = async () => applyManaged({ canCheckForUpdates: true, autoInstallUpdates: true }, true);
  const env = fakeUpdateEnv({ canCheckForUpdates: true, autoInstallUpdates: true, latestRelease: "v1.9.0" });
  await checkForUpdate(NOW, { force: true, getSettingsFn: managedSettings });
  ok("managed: no request to the release URL", env.fetched.length === 0);
  ok("managed: a stored release is not offered", (await availableUpdate("1.3.1", { getSettingsFn: managedSettings })) === null);
  ok("managed: without the marker the stored release is offered", (await availableUpdate("1.3.1"))?.version === "1.9.0");
  const installs: any[] = [];
  const r = await autoInstallUpdate({ getSettingsFn: managedSettings, available: async () => true, install: async (v: any, o: any) => (installs.push(o), { ok: true }), helper: (async () => ({ ok: true })) as any });
  ok("managed: nothing is installed automatically", !r.ran && installs.length === 0);
  delete (globalThis as any).chrome;
}
{
  const flags = { canCheckForUpdates: true, autoInstallUpdates: true, theme: "dark" };
  const forced = applyManaged(flags, true);
  ok("managed: applyManaged forces both flags off and keeps the rest", forced.canCheckForUpdates === false && forced.autoInstallUpdates === false && forced.theme === "dark" && flags.canCheckForUpdates === true);
  ok("managed: applyManaged returns the same object when not managed", applyManaged(flags, false) === flags);
  ok("managed: visibleTabs(true) has no updates tab", !visibleTabs(true).some((t) => t.id === "updates") && visibleTabs(true).length === OPTION_TABS.length - 1);
  ok("managed: visibleTabs(false) is OPTION_TABS", visibleTabs(false) === OPTION_TABS);
  ok("managed: #updates opens autofill when managed", tabFromHash("#updates", visibleTabs(true)) === "autofill");
  let t = 1000;
  let calls = 0;
  let reply: any = { ok: false };
  const env = { fetchFn: (async (u: any) => (calls++, u === "chrome://x/managed.json" ? (reply instanceof Error ? Promise.reject(reply) : reply) : { ok: false })) as any, getUrl: (p: string) => `chrome://x/${p}`, now: () => t };
  resetManagedCache();
  ok("managed: a non-ok answer is not managed", (await isManagedInstall(env)) === false);
  reply = { ok: true, json: async () => ({ managed: false }) };
  t += 60_000;
  ok("managed: the shipped managed:false is not managed", (await isManagedInstall(env)) === false);
  reply = { ok: true, json: async () => ({ managed: true }) };
  ok("managed: a false answer is not looked up again within 60 s", (await isManagedInstall(env)) === false && calls === 2);
  t += 60_000;
  ok("managed: managed.json set to true later is picked up after 60 s", (await isManagedInstall(env)) === true && calls === 3);
  ok("managed: a true answer is cached", (await isManagedInstall(env)) === true && calls === 3);
  resetManagedCache();
  reply = new Error("missing");
  ok("managed: a rejected fetch is not managed", (await isManagedInstall(env)) === false);
  resetManagedCache();
  calls = 0;
  reply = { ok: true, json: async () => (await new Promise((r) => setTimeout(r, 20)), { managed: true }) };
  const both = await Promise.all([isManagedInstall(env), isManagedInstall(env)]);
  ok("managed: two calls at once both see managed, one fetch", both[0] === true && both[1] === true && calls === 1);
  resetManagedCache();
  (globalThis as any).chrome = { storage: { sync: { get: (k: any, cb: any) => cb({ canCheckForUpdates: true, autoInstallUpdates: true }) } }, runtime: { getURL: (p: string) => `chrome://x/${p}` } };
  const realFetchHere = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ managed: true }) })) as any;
  const eff = await getEffectiveSettings();
  ok("managed: effective settings are off with the marker and a saved true", eff.canCheckForUpdates === false && eff.autoInstallUpdates === false);
  globalThis.fetch = realFetchHere;
  delete (globalThis as any).chrome;
  resetManagedCache();
  const bg = readFileSync(new URL("../../src/background.js", import.meta.url), "utf8");
  const stateReply = bg.slice(bg.indexOf('case "getState"'), bg.indexOf('case "getOneTimeCodes"'));
  ok("managed: the getState reply uses effective settings and update", /settings: await getEffectiveSettings\(\)/.test(stateReply) && /availableUpdate\(undefined, \{ getSettingsFn: getEffectiveSettings \}\)/.test(stateReply) && (stateReply.match(/availableUpdate\(/g) || []).length === 1 && !/getSettings\(\)/.test(stateReply));
  const content = readFileSync(new URL("../../src/content.js", import.meta.url), "utf8");
  ok("managed: content.js does not import managed.js", !/managed\.js/.test(content));
  const opts = readFileSync(new URL("../../src/ui/options.jsx", import.meta.url), "utf8");
  ok("managed: the options page saves only the changed key and never writes the clamped copy", /function persist\(partial\) \{\n    setSettings\(\(s\) => \(\{ \.\.\.s, \.\.\.partial \}\)\);\n    queueSettings\(partial\);/.test(opts) && !/settingsStore\(\)\.set\(shown/.test(opts));
}
{
  const env = fakeUpdateEnv({}, (new Error("offline") as any));
  await checkForUpdate(NOW);
  ok("update: a failed request is retried on the next alarm", (env.data as any).updateCheckedAt === undefined);
}
{
  const env = fakeUpdateEnv({ latestRelease: "v1.4.0" }, { ok: false, status: 403, json: async () => (({ message: "rate limited" }) as any) });
  await checkForUpdate(NOW);
  ok("update: a refused request is retried on the next alarm and keeps the last tag", (env.data as any).updateCheckedAt === undefined && (env.data as any).latestRelease === "v1.4.0");
}
{
  const unsigned = fakeUpdateEnv({}, { ok: true, json: async () => ({ tag_name: "v1.4.0", assets: signedAssets.slice(0, 1) }) });
  await checkForUpdate(NOW);
  ok("update: a newer release without its .sig is not offered", (await availableUpdate("1.3.1")) === null && (unsigned.data as any).latestRelease === "v1.4.0");
  fakeUpdateEnv();
  await checkForUpdate(NOW);
  ok("update: a newer release with its .sig is offered", (await availableUpdate("1.3.1"))?.version === "1.4.0");
}
{
  const env = fakeUpdateEnv({ updateCheckedAt: 5 }, { ok: false, status: 403, json: async () => (({}) as any) });
  await checkForUpdate(NOW, { force: true });
  ok("update: a refused request does not stamp the check time", (env.data as any).updateCheckedAt === 5);
}
{
  const env = fakeUpdateEnv();
  await checkForUpdate(NOW, { force: true });
  ok("update: the check bypasses the HTTP cache", (env.inits[0] as any)?.cache === "no-store");
}
{
  const env = fakeUpdateEnv();
  await Promise.all([checkForUpdate(NOW), checkForUpdate(NOW)]);
  ok("update: overlapping checks share one request", env.fetched.length === 1);
}
{
  fakeUpdateEnv();
  // what chrome answers while the worker is shutting down for a reload
  (globalThis as any).chrome.storage.local.get = (keys: any, cb: any) => (cb ? cb({}) : Promise.reject(new Error("No SW")));
  ok("update: a check while the worker shuts down settles quietly", (await settles(checkForUpdate(NOW))) === "resolved");
}

{
  // two areas this time, so a move from local to sync shows
  const area = (data: any) => ({
    data,
    get: async (keys: any) => Object.fromEntries(keys.filter((k: any) => k in data).map((k: any) => [k, data[k]])),
    set: async (o: any) => void Object.assign(data, o),
    remove: async (keys: any) => keys.forEach((k: any) => delete data[k]),
  });
  const local = area({ askToSave: false, updateCheckedAt: 5 });
  const sync = area({});
  (globalThis as any).chrome = { storage: { local, sync }, runtime: {} };
  await migrateSettingsToSync();
  ok("settings: a machine's local settings move to sync once", sync.data.askToSave === false && !("askToSave" in local.data));
  ok("settings: machine state stays in local", local.data.updateCheckedAt === 5 && !("updateCheckedAt" in sync.data));
  local.data.askToSave = true;
  sync.data.askToSave = false;
  await migrateSettingsToSync();
  ok("settings: values already in sync win over a second machine's", sync.data.askToSave === false && !("askToSave" in local.data));
}

function fakePage() {
  const win = (new EventTarget() as any);
  const hosts = [{ removed: false, remove() { this.removed = true; } }, { removed: false, remove() { this.removed = true; } }];
  win.document = { querySelectorAll: () => hosts };
  return { win, hosts };
}
{
  const { win, hosts } = fakePage();
  const runtime = ({ id: "abc" } as any);
  const life = createLifecycle(({ win, runtime } as any));
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
  const old = createLifecycle(({ win, runtime: { id: "abc" } } as any));
  ok("lifecycle: the first copy does not tear itself down", !old.isDead());
  const fresh = createLifecycle(({ win, runtime: { id: "abc" } } as any));
  ok("lifecycle: a newer copy replaces the older one", old.isDead() && hosts.every((h) => h.removed));
  ok("lifecycle: the newer copy survives its own event", !fresh.isDead() && fresh.alive());
  ok("lifecycle: the replaced event name is stable", REPLACED_EVENT === "passbridge:replaced");
}
{
  const calls = ([] as any[]);
  const runtime = { getManifest: () => ({ content_scripts: [{ js: ["src/content.js"] }] }) };
  const tabs = { query: async (q: any) => (calls.push(["query", q]), [{ id: 1, url: "https://a.test/" }, { id: 2, url: "https://locked.test/" }, { id: 3, url: "http://b.test/" }, { url: "https://noid.test/" }]) };
  const scripting = {
    executeScript: async (o: any) => {
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
delete (globalThis as any).chrome;
globalThis.fetch = realFetch;

// a zip built in the test: stored or deflated entries, with optional flags, unix mode and a wrong declared size
async function makeZip(entries: any) {
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
  const text = (f: any) => new TextDecoder().decode(f.data);
  ok("zip: stored and deflated files come out with their paths", files.map((f) => f.path).join() === "manifest.json,src/a.js" && text(files[0]) === '{"version":"1.4.2"}' && text(files[1]) === "A".repeat(500));
  const bad = ["../x", "/x", "a\\b", "C:/x", "a//b", "./x", ".update-staging/x"];
  const refused = await Promise.all(bad.map(async (name) => (await settles(readZip(await makeZip([{ name, data: "x" }])))).startsWith("rejected")));
  ok("zip: unsafe paths and our own work folders are refused", refused.every(Boolean));
  ok("zip: a link is refused", (await settles(readZip(await makeZip([{ name: "l", data: "/etc", mode: 0o120777 }])))).startsWith("rejected"));
  ok("zip: an encrypted entry is refused", (await settles(readZip(await makeZip([{ name: "a", data: "x", flags: 1 }])))).startsWith("rejected"));
  ok("zip: a size that does not match is refused", (await settles(readZip(await makeZip([{ name: "a", data: "abc", size: 9 }])))).startsWith("rejected"));
  ok("zip: bytes that are no zip are refused", (await settles(readZip(new Uint8Array([1, 2, 3])))).startsWith("rejected"));
  const pkg = (manifest: any) => [{ path: "manifest.json", data: new TextEncoder().encode(typeof manifest === "string" ? manifest : JSON.stringify(manifest)) }];
  const want = { key: "K", version: "1.4.2" };
  ok("zip: a manifest with this install's key and the expected version passes", manifestProblem(pkg({ key: "K", version: "1.4.2" }), want) === null);
  ok("zip: a different key is refused", manifestProblem(pkg({ key: "X", version: "1.4.2" }), want) === "key");
  ok("zip: an unexpected version is refused", manifestProblem(pkg({ key: "K", version: "1.4.3" }), want) === "version");
  ok("zip: no manifest or an unreadable one is refused", manifestProblem([], want) === "manifest" && manifestProblem(pkg("{nope"), want) === "manifest");
}

// FileSystemDirectoryHandle in memory. failAt(op, path) makes the next matching call throw; noMove drops move() like an older Chrome
function fakeFs({ noMove = false } = {}) {
  const faults = ([] as any[]);
  const join = (a: any, b: any) => (a ? `${a}/${b}` : b);
  const trip = (op: any, path: any) => {
    const i = faults.findIndex((f) => f.op === op && f.path === path);
    if (i >= 0) {
      faults.splice(i, 1);
      throw new Error(`fault ${op} ${path}`);
    }
  };
  const missing = () => new DOMException("not found", "NotFoundError");
  function file(name: any, parent: any) {
    const f = (({
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
          write: async (d: any) => {
            trip("write", f.path());
            next = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d);
          },
          close: async () => {
            f.data = next;
          },
        };
      },
    }) as any);
    if (!noMove) {
      f.move = async (a: any, b: any) => {
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
  function dir(name: any, parent: any) {
    const d = {
      kind: "directory",
      name,
      kids: new Map(),
      get path() {
        return parent ? join(parent.path, name) : "";
      },
      async getDirectoryHandle(n: any, { create = false } = {}) {
        const k = d.kids.get(n);
        if (k?.kind === "directory") return k;
        if (k || !create) throw missing();
        const sub = dir(n, d);
        d.kids.set(n, sub);
        return sub;
      },
      async getFileHandle(n: any, { create = false } = {}) {
        const k = d.kids.get(n);
        if (k?.kind === "file") return k;
        if (k || !create) throw missing();
        const f = file(n, d);
        d.kids.set(n, f);
        return f;
      },
      async removeEntry(n: any, { recursive = false } = {}) {
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
  return { root, failAt: (op: any, path: any) => faults.push({ op, path }) };
}
async function put(root: any, path: any, text: any) {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}
async function snapshot(d: any, prefix: string = ""): Promise<string[]> {
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind === "directory") {
      const inner = await snapshot(h, `${prefix}${name}/`);
      out.push(...(inner.length ? inner : [`${prefix}${name}/`]));
    } else out.push(`${prefix}${name}=${await (await h.getFile()).text()}`);
  }
  return out.sort();
}
const newFile = (path: any, text: any) => ({ path, data: new TextEncoder().encode(text) });
async function oldInstall(opts?: any) {
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
  const steps = ([] as any[]);
  await applyUpdate((fs.root as any), NEXT, { version: "1.4.2", onProgress: (done, total) => steps.push([done, total]) });
  ok("files: the folder ends up holding exactly the new release", (await snapshot(fs.root)).join() === NEW);
  ok("files: progress climbs one step at a time to the total", steps.length === 8 && steps.every(([d, t], i) => d === i + 1 && t === 8));
}
{
  const fs = await oldInstall();
  fs.failAt("write", ".update-staging/src/a.js");
  const err = await applyUpdate((fs.root as any), NEXT, { version: "1.4.2" }).then(() => null, (e) => e);
  ok("files: a failed write while staging leaves the old install untouched", err?.restored === false && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall();
  fs.failAt("move", ".update-staging/src/new/n.js");
  const err = await applyUpdate((fs.root as any), NEXT, { version: "1.4.2" }).then(() => null, (e) => e);
  ok("files: a failed move halfway puts the old install back", err?.restored === true && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall();
  fs.failAt("move", "legacy/x.js");
  await settles(applyUpdate((fs.root as any), NEXT, { version: "1.4.2" }));
  ok("files: a failure while setting aside a dropped file also puts the old install back", (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await oldInstall({ noMove: true });
  await applyUpdate((fs.root as any), NEXT, { version: "1.4.2" });
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
  const first = await recoverUpdate((fs.root as any));
  ok("files: an interrupted update is rolled back to the old install", first === true && (await snapshot(fs.root)).join() === OLD);
  ok("files: a second recovery finds nothing to do", (await recoverUpdate((fs.root as any))) === false);
}
{
  const fs = await oldInstall();
  await put(fs.root, ".update-staging/src/a.js", "A2");
  ok("files: staging left without a journal is only cleaned up", (await recoverUpdate((fs.root as any))) === false && (await snapshot(fs.root)).join() === OLD);
}
{
  const fs = await crashedHalfway();
  await applyUpdate((fs.root as any), NEXT, { version: "1.4.2" });
  ok("files: a new update first recovers an interrupted one", (await snapshot(fs.root)).join() === NEW);
}
{
  const fs = await oldInstall();
  const other = await oldInstall();
  const readFrom = (root: any) => async (name: any) => (await snapshot(root)).find((l: any) => l.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  ok("files: the folder the extension runs from is recognised", (await isOwnFolder((fs.root as any), readFrom(fs.root))) === true);
  ok("files: a copy elsewhere is not", (await isOwnFolder((fs.root as any), readFrom(other.root))) === false);
  ok("files: the probe file is removed afterwards", (await snapshot(fs.root)).join() === OLD);
}

{
  const journalEnv = (journal: any) => {
    const env = fakeUpdateEnv();
    (globalThis as any).chrome.runtime.getURL = (p: any) => `chrome-extension://pb/${p}`;
    globalThis.fetch = async (url: any) => {
      env.fetched.push((String(url) as any));
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
  ok("interrupted: a run that left no journal is forgotten", (await hasInterruptedUpdate()) === false && (env.data as any).isUpdating === undefined);
  await setUpdating(true);
  await setUpdating(false);
  ok("interrupted: a finished run clears its mark", (env.data as any).isUpdating === undefined);
  delete (globalThis as any).chrome;
  globalThis.fetch = realFetch;
}

// a saved folder handle with scripted permission answers, counting what the user would be asked
function savedFolder(query: any, request = "granted") {
  const h = ({ asked: 0 } as any);
  h.queryPermission = async () => query;
  h.requestPermission = async (opts: any) => {
    h.asked++;
    h.askedMode = opts?.mode;
    return request;
  };
  return h;
}
function folderEnv(saved: any, { own = true, source = true, pickThrows = false } = {}) {
  const env = (({ picked: 0, startIn: [], store: { value: saved, get: async () => env.store.value, set: async (v: any) => (env.store.value = v) } }) as any);
  env.picked_handle = savedFolder("granted");
  env.deps = {
    store: env.store,
    pick: async (startIn: any) => {
      env.picked++;
      env.startIn.push((startIn as any));
      if (pickThrows) throw new DOMException("cancelled", "AbortError");
      return env.picked_handle;
    },
    isSource: async () => source,
    isOwn: async () => own,
  };
  return env;
}
{
  const env = (folderEnv(null) as any);
  const r = await folderForUpdate(env.deps);
  ok("folder: the first update asks for the folder once and keeps it", r.ok && r.folder === env.picked_handle && env.picked === 1 && env.startIn[0] === undefined && env.store.value === env.picked_handle);
}
{
  const saved = savedFolder("prompt", "granted");
  const env = (folderEnv(saved) as any);
  const r = await folderForUpdate(env.deps);
  ok("folder: after a restart the picker opens at the kept folder instead of the bare permission prompt", r.ok && env.picked === 1 && env.startIn[0] === saved && saved.asked === 0 && env.store.value === env.picked_handle);
}
{
  const saved = savedFolder("granted");
  const env = (folderEnv(saved) as any);
  const r = await folderForUpdate(env.deps);
  ok("folder: with allow on every visit nothing is asked", r.ok && saved.asked === 0 && env.picked === 0);
}
{
  const saved = savedFolder("denied");
  const env = (folderEnv(saved) as any);
  const r = await folderForUpdate(env.deps);
  ok("folder: a refused permission opens the picker at the kept folder again", r.ok && env.picked === 1 && env.startIn[0] === saved);
}
ok("folder: a kept folder that lost its permission can be kept", await canKeepFolder((folderEnv(savedFolder("prompt")) as any).store));
ok("folder: a folder allowed on every visit has nothing left to keep", !(await canKeepFolder((folderEnv(savedFolder("granted")) as any).store)));
ok("folder: with no kept folder there is nothing to keep", !(await canKeepFolder((folderEnv(null) as any).store)));
{
  const saved = savedFolder("prompt");
  const env = (folderEnv(saved) as any);
  await keepFolder(env.store);
  ok("folder: keeping asks chrome for write access to the kept folder, with no picker", saved.asked === 1 && saved.askedMode === "readwrite" && env.picked === 0);
}
{
  await keepFolder((folderEnv(null) as any).store);
  ok("folder: keeping with no kept folder does nothing", true);
}
{
  const env = (folderEnv(null, { own: false }) as any);
  const r = (await folderForUpdate(env.deps) as any);
  ok("folder: a folder that is not this install is refused and not kept", r.error === "notown" && env.store.value === null);
}
{
  const env = (folderEnv(null, { source: false }) as any);
  const r = (await folderForUpdate(env.deps) as any);
  ok("folder: a folder without the PassBridge manifest is refused and not kept", r.error === "notsource" && env.store.value === null);
}
{
  const env = (folderEnv(savedFolder("granted"), { source: false }) as any);
  ok("folder: a kept folder that lost the PassBridge manifest is refused", ((await folderForUpdate(env.deps)) as any).error === "notsource");
}
{
  // the same lock semantics as navigator.locks with ifAvailable: the second request gets null while the first runs
  let held = false;
  const locks = { request: async (name: any, opts: any, cb: any) => (held ? cb(null) : ((held = true), cb({ name }).finally(() => (held = false)))) };
  let release;
  const first = withUpdateLock(() => new Promise((r) => (release = r)), locks);
  let ran = false;
  const second = await withUpdateLock(async () => (ran = true), locks);
  ok("lock: a second update started while one runs is refused and never runs", second.ok === false && second.error === "busy" && !ran);
  (release as any)("done");
  ok("lock: the first update still finishes", ((await first) as any).value === "done");
  ok("lock: after it finishes a new update can start", (await withUpdateLock(async () => 1, locks)).ok === true);
}
{
  const env = (folderEnv(null, { pickThrows: true }) as any);
  ok("folder: closing the picker is reported as cancelled", ((await folderForUpdate(env.deps)) as any).error === "cancelled");
}
{
  const env = (folderEnv(savedFolder("granted"), { own: false }) as any);
  ok("folder: a kept folder that no longer holds this install is reported", ((await folderForUpdate(env.deps)) as any).error === "notown");
}
{
  const env = (folderEnv(savedFolder("granted")) as any);
  const r = await pickFolder(env.deps);
  ok("folder: change folder always opens the picker", r.ok && env.picked === 1 && env.store.value === env.picked_handle);
}

{
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
  const zip = new TextEncoder().encode("release zip bytes ".repeat(4000));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, zip));
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex");
  const asset = (name: any, extra: any) => ({ name, browser_download_url: `https://dl.test/${name}`, ...extra });
  const releaseJson = (assets: any) => ({ tag_name: "v1.4.2", assets });
  const full = [asset("passbridge.zip", { size: zip.length, digest: `sha256:${hex}` }), asset("passbridge.zip.sig", { size: 64 })];
  const cacheModes = new Set();
  const serve = (json: any, files = {}) => {
    globalThis.fetch = async (url, init) => {
      cacheModes.add(init?.cache);
      url = String(url);
      if (url.startsWith("https://api.github.com/")) return json instanceof Error ? Promise.reject(json) : new Response(JSON.stringify(json), { status: 200 });
      const body = (files as any)[url.slice("https://dl.test/".length)];
      return body ? new Response(body) : new Response("missing", { status: 404 });
    };
  };
  serve(releaseJson(full));
  const release = await latestRelease("1.4.1");
  ok("release: a newer signed release is described", release.ok && release.version === "1.4.2" && release.size === zip.length && release.pageUrl === "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.2");
  serve(releaseJson([full[0]]));
  const unsigned = (await latestRelease("1.4.1") as any);
  ok("release: no .sig means unsigned, with the version and the page to download by hand", !unsigned.ok && unsigned.error === "unsigned" && unsigned.version === "1.4.2" && unsigned.pageUrl.endsWith("/v1.4.2"));
  serve(releaseJson([asset("passbridge.zip", { size: zip.length }), full[1]]));
  ok("release: no digest also means unsigned", ((await latestRelease("1.4.1")) as any).error === "unsigned");
  serve(releaseJson(full));
  ok("release: the installed version is reported as current", ((await latestRelease("1.4.2")) as any).error === "current");
  serve(new Error("offline"));
  ok("release: no answer from GitHub is a network error", ((await latestRelease("1.4.1")) as any).error === "network");

  serve(releaseJson(full), { "passbridge.zip": zip, "passbridge.zip.sig": sig });
  const seen = ([] as any[]);
  const got = await downloadRelease((release as any), { publicKey, onProgress: (n, total) => seen.push([n, total]) });
  ok("release: the download is verified and handed back", got.ok && got.zip.length === zip.length);
  ok("release: download progress reaches the full size", seen.length > 0 && seen.at(-1)[0] === zip.length && seen.at(-1)[1] === zip.length);
  const tampered = zip.slice();
  tampered[10] ^= 1;
  serve(releaseJson(full), { "passbridge.zip": tampered, "passbridge.zip.sig": sig });
  ok("release: a changed zip fails verification", ((await downloadRelease((release as any), { publicKey })) as any).error === "verify");
  serve(releaseJson(full), { "passbridge.zip.sig": sig });
  ok("release: a missing file is a download error", ((await downloadRelease((release as any), { publicKey })) as any).error === "download");
  ok("release: the lookup and the downloads skip the browser cache", cacheModes.size === 1 && cacheModes.has("no-store"));

  serve(releaseJson([full[0]]));
  const helper = await installUpdate("1.4.1");
  ok("helper update: an unsigned release says so instead of blaming the download", !helper.ok && /isn't signed/.test((helper.error as any)));

  const heldLocks = { request: async (name: any, opts: any, cb: any) => cb(null) };
  const busy = await installUpdate("1.4.1", { publicKey, locks: heldLocks });
  ok("helper update: refused with the plain message while another update holds the lock", !busy.ok && busy.error === "An update is already running in another PassBridge page.");

  // the updater host answering, with storage and reload stubbed
  const helperEnv = (hostReply: any) => {
    const env = (fakeUpdateEnv() as any);
    env.sent = [];
    env.reloads = 0;
    Object.assign((globalThis as any).chrome.runtime, {
      sendNativeMessage: async (host: any, msg: any) => (env.sent.push(msg), hostReply),
      reload: () => env.reloads++,
    });
    serve(releaseJson(full), { "passbridge.zip": zip, "passbridge.zip.sig": sig });
    return env;
  };
  let env = (helperEnv({ ok: true }) as any);
  const installed = await installUpdate("1.4.1", { publicKey });
  await new Promise((r) => setTimeout(r, 350));
  ok("helper update: a finished install marks the version for the result page, then reloads", installed.ok && env.sent.some((m: any) => m.op === "install") && (env.data as any).updatedTo === "1.4.2" && env.reloads === 1);
  env = helperEnv({ ok: false, error: "disk full" });
  const refused = await installUpdate("1.4.1", { publicKey });
  await new Promise((r) => setTimeout(r, 350));
  ok("helper update: a refused install marks nothing and does not reload", !refused.ok && (env.data as any).updatedTo === undefined && env.reloads === 0);
  ok("helper update: a refused install shows the catalog text and the helper's detail", refused.error === "Couldn't install the update. disk full");
  delete (globalThis as any).chrome;
}
{
  const env = fakeUpdateEnv();
  await markUpdatedTo("1.4.2");
  const first = await takeUpdatedTo();
  ok("update: the marked version is handed over once", first === "1.4.2" && (env.data as any).updatedTo === undefined && (await takeUpdatedTo()) === null);
  delete (globalThis as any).chrome;
}
globalThis.fetch = realFetch;

{
  // automatic install: the setting, the host and the failed-once memory decide
  const setup = (seed: any) => {
    const env = (fakeUpdateEnv({ latestRelease: "v1.5.0", ...seed }) as any);
    (globalThis as any).chrome.runtime.getManifest = () => ({ version: "1.4.0" });
    env.installs = [];
    env.helpers = 0;
    env.deps = (host: any, installReply = { ok: true }) => ({
      available: async () => host,
      install: async (v: any, o: any) => (env.installs.push(o), installReply),
      helper: async () => (env.helpers++, { ok: true }),
    });
    return env;
  };
  let env = (setup({}) as any);
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
  ok("auto update: a failed install is remembered for that version", !r.ok && (env.data as any).autoInstallFailed === "1.5.0");
  r = await autoInstallUpdate(env.deps(true));
  ok("auto update: the same version is not retried after a failure", !r.ran && r.why === "failed-before" && env.installs.length === 1);
  env = setup({ latestRelease: "v1.4.0" });
  r = await autoInstallUpdate(env.deps(true));
  ok("auto update: no newer extension release installs nothing but checks the helper", !r.ran && env.installs.length === 0 && env.helpers === 1);
  delete (globalThis as any).chrome;
}
{
  // helper update: only when the helper is older than the release, verified like the extension zip
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
  const zip = new TextEncoder().encode("helper zip bytes ".repeat(500));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, zip));
  const hex = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex");
  const asset = (name: any, extra?: any) => ({ name, browser_download_url: `https://dl.test/${name}`, ...extra });
  const json = { tag_name: "v1.5.0", assets: ["passbridge-macos-helper.zip", "passbridge-windows-helper.zip"].flatMap((n) => [asset(n, { size: zip.length, digest: `sha256:${hex}` }), asset(`${n}.sig`)]) };
  const run = async (status: any, platform = "macOS", tamper = false) => {
    const env = (fakeUpdateEnv({ latestRelease: "v1.5.0" }) as any);
    env.sent = [];
    env.urls = [];
    const bad = zip.slice();
    bad[3] ^= 1;
    globalThis.fetch = async (url: any) => {
      url = String(url);
      env.urls.push(url);
      if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(json));
      return new Response(url.endsWith(".sig") ? sig : tamper ? bad : zip);
    };
    const send = async (m: any) => (env.sent.push(m), m.op === "status" ? status : { ok: true });
    env.res = await updateHelper({ publicKey, send, platform });
    return env;
  };
  let e = (await run({ ok: true, helperVersion: "1.4.5" }) as any);
  const inst = e.sent.find((m: any) => m.op === "install-helper");
  ok("helper update: an older helper is replaced with the verified macOS zip", e.res.ok && inst?.version === "1.5.0" && e.urls.some((u: any) => u.endsWith("/passbridge-macos-helper.zip")) && inst.zip.length > 0);
  e = await run({ ok: true, helperVersion: "1.5.0" });
  ok("helper update: a helper at the release version is left alone", e.res.skipped && !e.sent.some((m: any) => m.op === "install-helper") && e.urls.length === 0);
  e = await run({ ok: true, helperVersion: null }, "Windows");
  ok("helper update: an unknown helper version gets the Windows zip", e.sent.some((m: any) => m.op === "install-helper") && e.urls.some((u: any) => u.endsWith("/passbridge-windows-helper.zip")));
  e = await run({ ok: true, helperVersion: "1.4.5" }, "macOS", true);
  ok("helper update: a zip that fails verification is never sent", !e.res.ok && e.res.error === "verify" && !e.sent.some((m: any) => m.op === "install-helper"));
  e = await run({ ok: true });
  ok("helper update: an old helper without install-helper gets a one-time note and no download", e.res.error === "old-helper" && (e.data as any).helperOutdatedNote === true && e.urls.length === 0);
  delete (e.data as any).helperOutdatedNote; // the popup took the note
  await updateHelper({ publicKey, send: async () => ({ ok: true }), platform: "macOS" });
  ok("helper update: the old-helper note is not set again on the next check", !("helperOutdatedNote" in e.data));
  delete (globalThis as any).chrome;
  globalThis.fetch = realFetch;
}

{
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const out = mkdtempSync(join(tmpdir(), "pb-build-guard-"));
  const source = { latestUrl: "http://127.0.0.1:1/releases/latest", publicKey: "AAAA" };
  ok("build: a release build refuses a test release source", (await settles(buildExtension({ out, releaseSource: (source as any) }))).startsWith("rejected"));
  ok("build: a release build refuses a test version", (await settles(buildExtension({ out, version: "9.9.9.1" }))).startsWith("rejected"));
  ok("build: a refused build writes nothing", readdirSync(out).length === 0);
  rmSync(out, { recursive: true, force: true });
}
{
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "pb-stamp-repo-"));
  const git = (...a: any[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "a");
  git("add", ".");
  git("commit", "-qm", "init");
  ok("build stamp: a clean repo gives the short sha", /^[0-9a-f]{7,}$/.test(buildStamp(repo)));
  writeFileSync(join(repo, "new.txt"), "n");
  ok("build stamp: an untracked file alone stays clean", /^[0-9a-f]{7,}$/.test(buildStamp(repo)));
  writeFileSync(join(repo, "a.txt"), "b");
  ok("build stamp: uncommitted changes add -dirty", /^[0-9a-f]{7,}-dirty$/.test(buildStamp(repo)));
  rmSync(repo, { recursive: true, force: true });
  const plain = mkdtempSync(join(tmpdir(), "pb-stamp-plain-"));
  ok("build stamp: a folder without git gives an empty stamp", buildStamp(plain) === "");
  rmSync(plain, { recursive: true, force: true });
  // each build runs tailwind and esbuild, so these two take a few seconds
  const manifestOf = (dir: any) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const off = mkdtempSync(join(tmpdir(), "pb-stamp-off-"));
  await buildExtension({ out: off, quiet: true, stamp: false });
  ok("build stamp: stamp false leaves version_name out", !("version_name" in manifestOf(off)));
  rmSync(off, { recursive: true, force: true });
  const on = mkdtempSync(join(tmpdir(), "pb-stamp-on-"));
  await buildExtension({ out: on, quiet: true, stamp: true });
  const m = manifestOf(on);
  ok("build stamp: stamp true sets version_name to version+sha", /^\d+\.\d+\.\d+\+[0-9a-f]{7,}/.test(m.version_name) && m.version_name.startsWith(`${m.version}+`));
  rmSync(on, { recursive: true, force: true });
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
    diffs: ([{ rel: "a.ts", kind: "changed" }, { rel: "b.ts", kind: "new" }] as any),
    missing: ([{ path: "gone.ts", status: 404 }, { path: "x.ts", status: 500 }] as any),
  });
  ok("upstream: summary splits changed, new, removed and failed", s.changed.join() === "a.ts,b.ts" && s.new.join() === "b.ts" && s.removed.join() === "gone.ts" && s.failed.join() === "500 x.ts");
  ok("upstream: compare link uses pinned and latest", s.compare === "https://github.com/bitwarden/clients/compare/fc5de86...aaaa111");
  ok("upstream: a 404 counts as a change", changeCount(s) === 3);
  ok("upstream: title starts with the upstream prefix", issueTitle(s) === "Upstream: bitwarden changed 3 tracked file(s)" && issueTitle(s).startsWith(titlePrefix("bitwarden")));
  const body = issueBody(s);
  ok("upstream: body has commits, compare link, files and steps", body.includes("fc5de86") && body.includes("aaaa111") && body.includes(s.compare) && body.includes("`gone.ts`") && body.includes("pnpm sync bitwarden aaaa111 --accept"));
}


{
  // sign-release.ts signs a helper zip and the result verifies
  const { execFileSync } = await import("node:child_process");
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs"); const path = await import("node:path"); const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "pb-sign-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(path.join(dir, "k.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  const zipPath = path.join(dir, "passbridge-macos-helper.zip");
  writeFileSync(zipPath, "helper zip bytes");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  execFileSync("node", ["scripts/sign-release.ts", "sign", zipPath, "--key", path.join(dir, "k.pem"), "--pub", raw], { stdio: "pipe" });
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
  const ids = (state: any) => menuItems(state).map((i) => i.id);
  const locked = ids({ ready: false, logins: [{ username: "a" }], hasCode: true });
  ok("menu: locked shows Unlock and no login or code items", locked.includes("pb-unlock") && !locked.some((id) => /^pb-(fill|user|pass|otp)/.test((id as any))));
  const offSite = ids({ ready: true, onSite: false, logins: [], hasCode: false });
  ok("menu: unlocked on a non-web page (settings, chrome://) has no Unlock and no login lines", !offSite.includes("pb-unlock") && !offSite.includes("pb-none") && !offSite.some((id) => /^pb-(fill|user|pass|otp)/.test((id as any))));
  ok("menu: locked on a non-web page still offers Unlock", ids({ ready: false, onSite: false, logins: [], hasCode: false }).includes("pb-unlock"));
  const none = menuItems({ ready: true, logins: [], hasCode: false });
  ok("menu: no logins shows a greyed note", none.find((i) => i.id === "pb-none")?.enabled === false && !none.some((i) => /^pb-(fill|user|pass)-/.test((i.id as any))));
  const one = menuItems({ ready: true, logins: [{ username: "me@x.com" }], hasCode: false });
  ok("menu: one login is flat and named", one.find((i) => i.id === "pb-fill-0")?.title === "Fill me@x.com" && one.find((i) => i.id === "pb-pass-0")?.parentId === "pb-root");
  ok("menu: no code item without a code", !one.some((i) => i.id === "pb-otp"));
  const noName = ids({ ready: true, logins: [{ username: "" }], hasCode: false });
  ok("menu: a login without a username has no Copy username", !noName.includes("pb-user-0"));
  const two = menuItems({ ready: true, logins: [{ username: "a" }, { username: "b" }], hasCode: true });
  ok("menu: several logins get one submenu each", two.filter((i) => i.parentId === "pb-acct-1").map((i) => i.id).join() === "pb-fill-1,pb-user-1,pb-pass-1");
  ok("menu: a submenu parent is not also an action", two.every((i) => !String(i.id).startsWith("pb-acct-") || !loginAction(i.id)));
  ok("menu: code item shows when the site has a code", two.some((i) => i.id === "pb-otp"));
  const gen = ((one.find((i) => i.id === "pb-gen")) as any), genCopy = ((one.find((i) => i.id === "pb-gen-copy")) as any);
  ok("menu: fill a password only on fields, copy one only on pages", gen.contexts.join() === "editable" && genCopy.contexts.join() === "page");
  const alnum = ((one.find((i) => i.id === "pb-gen-alnum")) as any), alnumCopy = ((one.find((i) => i.id === "pb-gen-copy-alnum")) as any);
  ok("menu: no-special-characters fill on fields, copy on pages", alnum?.contexts.join() === "editable" && alnumCopy?.contexts.join() === "page");
  ok("menu: copy generated password only when one is held", !one.some((i) => i.id === "pb-gen-last") && menuItems({ ready: true, logins: [], hasCode: false, hasGenerated: true }).some((i) => i.id === "pb-gen-last"));
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
  ok("options: passkeys row on Windows points at the phone steps", passkeysView(true).helpKey === "passkeysHelpWin");
  ok("options: passkeys row off Windows says the browser uses iCloud Passwords passkeys", passkeysView(false).helpKey === "passkeysHelpMac");
  const sum = passkeyImportSummary(([{ status: "saved" }, { status: "saved" }, { status: "exists" }, { status: "skipped" }, { status: "failed" }] as any));
  ok("options: passkey import summary counts each outcome", sum.total === 5 && sum.saved === 2 && sum.exists === 1 && sum.skipped === 1 && sum.failed === 1);
  ok("options: passkeys help opens the SETUP.md Passkeys section", passkeysView(false).url.endsWith("SETUP.md#passkeys"));
  ok("options: tabs in order", OPTION_TABS.map((t) => t.id).join() === "autofill,appearance,browser,agents,updates");
  ok("options: hash opens its tab", tabFromHash("#updates") === "updates");
  ok("options: odd hashes open autofill", ["", "#", "#AGENTS", "#agents?x", "#%E2"].every((h) => tabFromHash(h) === "autofill"));
  const view = (policy: any, updater: any, isWindows = false, canCheckForUpdates = true) => helperView({ helpers: { policy, updater }, isWindows, canCheckForUpdates });
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
  ok("options: recheck waits for the 5 s gap", !shouldRecheck(1000, 5999) && shouldRecheck(1000, 6000));
  ok("options: a recheck that finds the helper clears the notice", view("missing", "missing").notices.browser !== null && view("present", "present").notices.browser === null && view("present", "present").notices.updates === null);
  {
    const { readFileSync, existsSync } = await import("node:fs");
    const rel = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    ok("release: windows helper zip gets the .cmd files", rel.includes("native/windows/install.cmd") && rel.includes("native/windows/uninstall.cmd"));
    for (const n of ["install", "uninstall"]) {
      const u = new URL(`../../native/windows/${n}.cmd`, import.meta.url);
      ok(`windows: ${n}.cmd runs ${n}.ps1`, existsSync(u) && readFileSync(u, "utf8").includes(`%~dp0${n}.ps1`));
    }
  }
  ok("options: no updater notice while checks are off", view("present", "missing", false, false).notices.updates === null);
  ok("options: a toggle with no helper note still says to restart", policyMessage(({ ok: true, hidden: false, needsApproval: true } as any), true) === "Quit and reopen the browser to apply this.");
  ok("options: a toggle shows the helper's own note", policyMessage(({ ok: true, hidden: true, note: "Approve it in Windows." } as any), true) === "Approve it in Windows.");
  ok("options: a failed toggle shows the error or a fallback", policyMessage({ ok: false, error: "denied" }, true) === "denied" && policyMessage({ ok: false }, true) === "Couldn't change the policy.");
  ok("theme: system is the default", SETTINGS_DEFAULTS.theme === "system");
  ok("theme: light and dark force one scheme", colorSchemeFor("light") === "light" && colorSchemeFor("dark") === "dark");
  ok("theme: system or an unknown value follows the computer", ["system", undefined, null, "", "blue"].every((t) => colorSchemeFor(t) === "light dark"));
  ok("options: reading the policy shows only an error", policyMessage(({ ok: true, hidden: true } as any), false) === "" && policyMessage({ ok: false, error: "no reply" }, false) === "no reply");
}
  {
    const on = { agentSignIn: true, agentAllowAll: false, agentAllowlist: ["github.com"] };
    const list = addToAllowlist(["github.com"], "Amazon.jobs");
    ok("agent allow: adds a host once, lowercase", list.join() === "github.com,amazon.jobs" && addToAllowlist(list, "amazon.jobs").join() === list.join());
    ok("agent allow: a Workday tenant host stays whole", agentHostFor("acme.wd5.myworkdayjobs.com") === "acme.wd5.myworkdayjobs.com");
    ok("agent allow: a normal site gives its registrable domain", agentHostFor("www.amazon.jobs") === "amazon.jobs");
    ok("agent allow: offer hidden with agentSignIn off", !agentOfferFor({ ...on, agentSignIn: false }, "amazon.jobs", true).show);
    ok("agent allow: offer hidden with allow every site on", !agentOfferFor({ ...on, agentAllowAll: true }, "amazon.jobs", true).show);
    ok("agent allow: offer hidden for an allowed host", !agentOfferFor(on, "gist.github.com", true).show);
    ok("agent allow: suggested follows generated", agentOfferFor(on, "amazon.jobs", true).suggested === true && agentOfferFor(on, "amazon.jobs", false).suggested === false && agentOfferFor(on, "amazon.jobs", true).show);
  }
{
  const run = (script: any, { before = 0, ready = ((() => true) as () => boolean) } = {}) => {
    let t = 0;
    let i = 0;
    const lookup = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === "throw") throw new Error("busy");
      return step;
    };
    return confirmLoginAdded({ lookup, username: " Me@X.com ", before, isReady: ready, now: () => t, sleep: async (ms) => { t += ms; } });
  };
  const me = { username: "me@x.com" };
  ok("add login: found on the 2nd poll is saved", (await run([[], [me]])) === "saved");
  ok("add login: never found times out", (await run([[]])) === "timeout");
  ok("add login: a throw then found is saved", (await run(["throw", [me]])) === "saved");
  ok("add login: an old entry that stays is not saved", (await run([[me]], { before: 1 })) === "timeout");
  let calls = 0;
  ok("add login: locked mid-check stops", (await run([[]], { ready: () => ++calls < 3 })) === "locked");
}
{
  // passkeys: record, webauthn, import (synthetic keys only)
  const rec = makeRecord({ rpId: "example.test", credentialId: "AbCdEfGh1234", userHandle: "dXNlcg", userName: "ann · test", key: "a2V5" });
  ok("passkey record: encode then decode round-trips", JSON.stringify(decodeRecord(encodeRecord(rec))) === JSON.stringify(rec));
  ok("passkey record: a newer version is refused", decodeRecord(pkB64u(new TextEncoder().encode(JSON.stringify({ ...rec, v: 2 })))) === null);
  ok("passkey record: garbage and missing fields are refused", decodeRecord("!!") === null && decodeRecord(pkB64u(new TextEncoder().encode('{"v":1}'))) === null);
  ok("passkey record: username holds site, user and 8 chars of the id", recordUsername(rec) === "example.test · ann · test · AbCdEfGh");
  const parsed = (parseUsername(recordUsername(rec)) as any);
  ok("passkey record: username parses back", parsed.rpId === "example.test" && parsed.userName === "ann · test" && parsed.idPrefix === "AbCdEfGh");
  ok("passkey record: a normal login name is not a passkey", !isPasskeyName("me@example.com") && !isPasskeyName("a · b") && isPasskeyName(recordUsername(rec)));
  ok("passkey record: the dedicated host is recognised", isPasskeyHost(`https://${PASSKEY_HOST}/`) && isPasskeyHost(PASSKEY_HOST) && !isPasskeyHost("https://example.com"));

  const origin = "https://login.example.test";
  const getDetails = (over = {}) => ({ rpId: "example.test", challenge: "Y2hhbGxlbmdl", allowCredentials: [], userVerification: "preferred", extensions: { remoteDesktopClientOverride: { origin, sameOriginWithAncestors: true } }, ...over });
  const createDetails = (over = {}) => ({ rp: { id: "example.test", name: "Example" }, user: { id: "dXNlcjE", name: "ann", displayName: "Ann" }, challenge: "Y2hhbGxlbmdl", pubKeyCredParams: [{ type: "public-key", alg: -7 }], extensions: { remoteDesktopClientOverride: { origin, sameOriginWithAncestors: true } }, ...over });
  const derToRaw = (der: any) => {
    let i = 3;
    const rl = der[i++];
    let r = der.slice(i, i + rl);
    i += rl + 1;
    const sl = der[i++];
    let s = der.slice(i, i + sl);
    const fix = (x: any) => (x.length > 32 ? x.slice(x.length - 32) : Uint8Array.from([...new Array(32 - x.length).fill(0), ...x]));
    return Uint8Array.from([...fix(r), ...fix(s)]);
  };
  const sha = async (d: any) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
  const verifyWith = async (spki: any, authData: any, cdj: any, derSig: any) => {
    const pub = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const msg = new Uint8Array([...authData, ...(await sha(cdj))]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, derToRaw(derSig), msg);
  };

  const made = await createPasskey(createDetails());
  const cr = JSON.parse(made.responseJson);
  const crAd = pkUnb64u(cr.response.authenticatorData);
  const crCdj = JSON.parse(new TextDecoder().decode(pkUnb64u(cr.response.clientDataJSON)));
  const rpHash = await sha(new TextEncoder().encode("example.test"));
  ok("passkey create: clientDataJSON has type, challenge and the page origin", crCdj.type === "webauthn.create" && crCdj.challenge === "Y2hhbGxlbmdl" && crCdj.origin === origin);
  ok("passkey create: rpIdHash, flags UP+BE+BS+AT without UV, counter 0", Buffer.from(crAd.slice(0, 32)).equals(Buffer.from(rpHash)) && crAd[32] === 0x59 && crAd.slice(33, 37).every((b) => b === 0));
  const idLen = (crAd[53] << 8) | crAd[54];
  ok("passkey create: attested data carries the credential id and an ES256 COSE key", pkB64u(crAd.slice(55, 55 + idLen)) === cr.id && crAd.slice(55 + idLen).length === 77 && crAd[55 + idLen] === 0xa5);
  ok("passkey create: the stored record matches the answer", made.record.credentialId === cr.rawId && made.record.rpId === "example.test" && made.record.userName === "ann" && made.record.userHandle === "dXNlcjE");
  ok("passkey create: UV flag set only when asked", ((await createPasskey(createDetails(), { userVerified: true }).then((m) => pkUnb64u(JSON.parse(m.responseJson).response.authenticatorData)))[32] & 0x04) === 0x04 && (crAd[32] & 0x04) === 0);
  ok("passkey create: the attestation object is CBOR with fmt none", Buffer.from(pkUnb64u(cr.response.attestationObject)).toString("latin1").includes("fmtdnone"));

  const spki = pkUnb64u(cr.response.publicKey);
  const sign = async (opts?: any) => {
    const g = JSON.parse(await signAssertion(getDetails(), made.record, opts));
    return { g, ad: pkUnb64u(g.response.authenticatorData), cdj: pkUnb64u(g.response.clientDataJSON), sig: pkUnb64u(g.response.signature) };
  };
  const got = await sign();
  ok("passkey get: the signature verifies with the public key from create", await verifyWith(spki, got.ad, got.cdj, got.sig));
  ok("passkey get: flags UP+BE+BS without UV, counter 0", got.ad[32] === 0x19 && got.ad.length === 37 && got.ad.slice(33).every((b) => b === 0));
  ok("passkey get: UV flag set when the vault read verified the user", (await sign({ userVerified: true })).ad[32] === 0x1d);
  ok("passkey get: a signature over other data does not verify", !(await verifyWith(spki, got.ad, new TextEncoder().encode("{}"), got.sig)));
  ok("passkey get: answer carries id, user handle and clientDataJSON origin", got.g.id === made.record.credentialId && got.g.response.userHandle === "dXNlcjE" && JSON.parse(new TextDecoder().decode(got.cdj)).origin === origin);
  const refused = async (fn: any) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e.name;
    }
  };
  ok("passkey get: another site's origin is refused", (await refused(() => signAssertion(getDetails({ extensions: { remoteDesktopClientOverride: { origin: "https://evil.test" } } }), made.record))) === "SecurityError");
  ok("passkey get: a missing origin is refused", (await refused(() => signAssertion(getDetails({ extensions: {} }), made.record))) === "SecurityError");
  ok("passkey get: a credential not on the allow list is refused", (await refused(() => signAssertion(getDetails({ allowCredentials: [{ type: "public-key", id: "b3RoZXI" }] }), made.record))) === "NotAllowedError");
  ok("passkey get: a listed credential is allowed", !!(await signAssertion(getDetails({ allowCredentials: [{ type: "public-key", id: made.record.credentialId }] }), made.record)));
  ok("passkey create: an rp id that is not the page's site is refused", (await refused(() => createPasskey(createDetails({ rp: { id: "other.test" } })))) === "SecurityError");
  ok("passkey create: no ES256 offered is refused", (await refused(() => createPasskey(createDetails({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] })))) === "NotSupportedError");

  // import
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const k256 = pkB64u(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const kp384 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
  const k384 = pkB64u(await crypto.subtle.exportKey("pkcs8", kp384.privateKey));
  const guid = "e8d88789-e916-e196-3cbd-81dafae71bbc";
  const bw = {
    encrypted: false,
    items: [
      { login: { username: "x", fido2Credentials: [
        { credentialId: guid, keyType: "public-key", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: k256, rpId: "example.test", userHandle: "dXNlcjE", userName: "ann", counter: "0", discoverable: "true" },
        { credentialId: "b64.AAECAwQFBgcICQoLDA0ODw", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: k256, rpId: "two.example.test", userName: "bob", counter: "0" },
        { credentialId: guid, keyAlgorithm: "ECDSA", keyCurve: "P-384", keyValue: k384, rpId: "p384.example.test", userName: "cy", counter: "0" },
        { credentialId: guid, keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: "", rpId: "nokey.example.test", userName: "di" },
        { credentialId: "not-a-guid", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: k256, rpId: "badid.example.test" },
        { credentialId: guid, keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: "AAECAwQFBg", rpId: "badkey.example.test" },
      ] } },
      { login: { username: "plain" } },
      { card: {} },
    ],
  };
  const bwOut = await parseBitwarden(bw);
  ok("import bitwarden: the two good P-256 passkeys are kept", bwOut.records.length === 2 && bwOut.records[0].rpId === "example.test" && bwOut.records[1].rpId === "two.example.test");
  ok("import bitwarden: a GUID credential id becomes the raw id in base64url", bwOut.records[0].credentialId === "6NiHiekW4ZY8vYHa-ucbvA" && bwOut.records[1].credentialId === "AAECAwQFBgcICQoLDA0ODw");
  ok("import bitwarden: fields map to the record", bwOut.records[0].userName === "ann" && bwOut.records[0].userHandle === "dXNlcjE" && bwOut.records[0].v === 1 && bwOut.records[1].userHandle === "");
  ok("import bitwarden: four skipped, each with a reason", bwOut.skipped.length === 4 && bwOut.skipped.every((s) => s.label && s.reason) && bwOut.skipped[0].reason.includes("P-256") && bwOut.skipped[1].reason.includes("key") && bwOut.skipped[2].reason.includes("credential id"));
  const imported = bwOut.records[0];
  const sigRec = JSON.parse(await signAssertion(getDetails(), imported));
  const importedPub = await crypto.subtle.importKey("jwk", { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)) }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  ok("import bitwarden: an imported key signs and verifies against its public key", await verifyWith(new Uint8Array(await crypto.subtle.exportKey("spki", importedPub)), pkUnb64u(sigRec.response.authenticatorData), pkUnb64u(sigRec.response.clientDataJSON), pkUnb64u(sigRec.response.signature)));
  ok("import bitwarden: an encrypted export is refused with a reason", (await parseBitwarden({ encrypted: true, items: [] })).skipped[0].reason.includes("encrypted"));
  const cxf = { version: { major: 1, minor: 0 }, accounts: [{ id: "a", items: [{ id: "i", title: "Ex", credentials: [
    { type: "basic-auth", username: { fieldType: "string", value: "x" } },
    { type: "passkey", credentialId: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.test", username: "ann", userDisplayName: "Ann", userHandle: "dXNlcjE", key: k256 },
    { type: "passkey", credentialId: "AAECAwQFBgcICQoLDA0ODw", rpId: "p384.example.test", username: "cy", userDisplayName: "Cy", userHandle: "dXNlcjE", key: k384 },
  ] }] }] };
  const cxfOut = await parseCxf(cxf);
  ok("import cxf: the P-256 passkey is kept, the P-384 one skipped with a reason", cxfOut.records.length === 1 && cxfOut.records[0].userName === "ann" && cxfOut.skipped.length === 1 && cxfOut.skipped[0].reason.includes("P-256"));
  ok("import: parseExport reads a Credential Exchange file only", (await parseExport(JSON.stringify(cxf))).records.length === 1 && (await refused(() => parseExport(JSON.stringify(bw)))) === "Error");
  ok("import: not JSON and unknown JSON give a plain error", (await refused(() => parseExport("nope"))) === "Error" && (await refused(() => parseExport("{}"))) === "Error");
}
{
  // passkeys: store over the mock client
  const client = createMockClient("unlocked");
  const rec = (rpId: any, id: any, name = "ann") => makeRecord({ rpId, credentialId: id, userHandle: "dXNlcjE", userName: name, key: "a2V5" });
  const a = rec("example.test", "AAAAAAAAAAAA");
  ok("passkey store: nothing listed at first", (await listPasskeys(client, 1)).length === 0);
  ok("passkey store: save is confirmed from the vault", (await savePasskey(client, 1, a, { pollMs: 1 })) === "saved");
  ok("passkey store: saving the same passkey again writes nothing", (await savePasskey(client, 1, a, { pollMs: 1 })) === "exists" && (await listPasskeys(client, 1)).length === 1);
  await savePasskey(client, 1, rec("other.test", "BBBBBBBBBBBB", "bo"), { pollMs: 1 });
  const list = await listPasskeys(client, 1);
  ok("passkey store: list parses the names", list.length === 2 && list[0].rpId === "example.test" && list[0].userName === "ann");
  ok("passkey store: a site sees its own passkeys and its parent domain's", passkeysForHost(list, "login.example.test").length === 1 && passkeysForHost(list, "example.test").length === 1 && passkeysForHost(list, "badexample.test").length === 0 && passkeysForHost(list, "none.test").length === 0);
  const read = (await readPasskey(client, 1, list[0]) as any);
  ok("passkey store: read returns the saved record, UV off by default", JSON.stringify(read.record) === JSON.stringify(a) && read.userVerified === false);
  (globalThis as any).__mockVerified = true;
  ok("passkey store: UV is reported only when the client says it verified", ((await readPasskey(client, 1, list[0])) as any).userVerified === true);
  delete (globalThis as any).__mockVerified;
  const locked = createMockClient("locked");
  ok("passkey store: a locked vault throws on list and save", (await Promise.all([listPasskeys(locked, 1).then(() => "ok", () => "throw"), savePasskey(locked, 1, a).then(() => "ok", () => "throw")])).join() === "throw,throw");
  const unreadable = { getPasswordForLoginName: async () => ({ username: "x", password: "not a record" }) };
  ok("passkey store: a password that is not a record reads as null", (await readPasskey(unreadable, 1, list[0])) === null);
}
{
  // passkeys: proxy (attach rules and request handling) with a fake chrome.webAuthenticationProxy
  const origin = "https://login.example.test";
  const ext = { remoteDesktopClientOverride: { origin, sameOriginWithAncestors: true } };
  const getJson = (o = {}) => JSON.stringify({ rpId: "example.test", challenge: "Y2g", allowCredentials: [], extensions: ext, ...o });
  const createJson = (o = {}) => JSON.stringify({ rp: { id: "example.test", name: "E" }, user: { id: "dXNlcjE", name: "ann", displayName: "Ann" }, challenge: "Y2g", pubKeyCredParams: [{ type: "public-key", alg: -7 }], extensions: ext, ...o });
  // a stand-in for chrome.storage.session
  const memory = () => {
    const data = ({} as any);
    return { data, get: async (d: any) => ({ ...d, ...Object.fromEntries(Object.keys(d).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])) }), set: async (o: any) => void Object.assign(data, structuredClone(o)), remove: async (k: any) => void delete data[k] };
  };
  const setup = async ({ enabled = true, url = origin + "/", kind = "unlocked", allSites = false, stayUnlocked = false } = {}) => {
    const calls = ([] as any[]);
    const api = {
      attach: async () => void calls.push("attach"),
      detach: async () => void calls.push("detach"),
      completeGetRequest: async (d: any) => void calls.push({ get: d }),
      completeCreateRequest: async (d: any) => void calls.push({ create: d }),
      completeIsUvpaaRequest: async (d: any) => void calls.push({ uvpaa: d }),
      onCreateRequest: { addListener: () => {} },
      onGetRequest: { addListener: () => {} },
      onIsUvpaaRequest: { addListener: () => {} },
      onRequestCanceled: { addListener: () => {} },
    };
    const state = { url, enabled, allSites, stayUnlocked };
    const client = createMockClient(kind);
    const session = memory();
    const proxy = createPasskeyProxy({ api: () => api, client, ensureConnected: async () => {}, enabled: async () => state.enabled, settings: async () => ({ allSites: state.allSites, stayUnlocked: state.stayUnlocked }), session: () => session, getTab: async () => ({ id: 1, url: state.url }), sleep: async () => { await new Promise((r) => setTimeout(r, 1)); }, pollMs: 1 });
    return { calls, api, state, client, proxy, session };
  };
  const seed = (client: any) => createPasskey(JSON.parse(createJson())).then(({ record }) => savePasskey(client, 1, record, { pollMs: 1 }).then(() => record));

  let w = await setup();
  await w.proxy.refresh();
  ok("passkey proxy: no stored passkey for the site stays detached", w.calls.join() === "detach");
  await seed(w.client);
  w.proxy.invalidate();
  await w.proxy.refresh();
  ok("passkey proxy: a stored passkey for the site attaches", w.calls.join() === "detach,attach");
  await w.proxy.refresh();
  ok("passkey proxy: no change means no call", w.calls.length === 2);
  w.state.url = "https://other.test/";
  await w.proxy.refresh();
  ok("passkey proxy: another site detaches", w.calls.join() === "detach,attach,detach");
  w.state.url = "chrome://extensions/";
  await w.proxy.refresh();
  ok("passkey proxy: a non-web page stays detached", w.calls.length === 3);
  const off = await setup({ enabled: false });
  await seed(off.client);
  await off.proxy.refresh();
  ok("passkey proxy: the setting off detaches even with stored passkeys", off.calls.join() === "detach");

  w = await setup();
  const rec = await seed(w.client);
  await w.proxy.onGet({ requestId: (1 as any), requestDetailsJson: getJson() });
  const g = w.calls.find((c) => c.get)?.get;
  ok("passkey proxy: a get request is answered with a response for the stored passkey", g?.requestId === 1 && !g.error && JSON.parse(g.responseJson).id === rec.credentialId);
  w.calls.length = 0;
  await w.proxy.onGet({ requestId: (2 as any), requestDetailsJson: getJson({ extensions: { remoteDesktopClientOverride: { origin: "https://evil.test" } } }) });
  ok("passkey proxy: a get from the wrong origin is refused", w.calls[0].get.error?.name === "SecurityError" && !w.calls[0].get.responseJson);
  w.calls.length = 0;
  await w.proxy.onGet({ requestId: (3 as any), requestDetailsJson: getJson({ allowCredentials: [{ type: "public-key", id: "zzzzzzzzzzzz" }] }) });
  ok("passkey proxy: a get that allows only other credentials is refused", w.calls[0].get.error?.name === "NotAllowedError");
  w.calls.length = 0;
  await w.proxy.onCreate({ requestId: (4 as any), requestDetailsJson: createJson({ user: { id: "dXNlcjI", name: "bo", displayName: "Bo" } }) });
  const c = w.calls.find((x) => x.create)?.create;
  ok("passkey proxy: a create request is saved to the vault, then answered", !!c?.responseJson && (await listPasskeys(w.client, 1)).length === 2);
  w.calls.length = 0;
  await w.proxy.onCreate({ requestId: (5 as any), requestDetailsJson: createJson({ rp: { id: "other.test" } }) });
  ok("passkey proxy: a create for another site's rp id is refused and nothing is saved", w.calls[0].create.error?.name === "SecurityError" && (await listPasskeys(w.client, 1)).length === 2);
  const failing = { ...w.client, saveLogin: async () => true, getLoginNamesForURL: w.client.getLoginNamesForURL, get ready() { return true; } };
  const p2 = createPasskeyProxy({ api: () => w.api, client: failing, ensureConnected: async () => {}, enabled: async () => true, getTab: async () => ({ id: 1, url: origin }), sleep: async () => {}, pollMs: 1 });
  w.calls.length = 0;
  const realNow = Date.now;
  let tick = 0;
  Date.now = () => realNow() + (tick += 20000);
  await p2.onCreate({ requestId: (6 as any), requestDetailsJson: createJson({ user: { id: "dXNlcjM", name: "cy", displayName: "Cy" } }) });
  Date.now = realNow;
  ok("passkey proxy: a create that never shows in the vault is reported as failed", w.calls[0].create.error?.name === "NotAllowedError" && !w.calls[0].create.responseJson);

  const lk = await setup({ kind: "locked" });
  await lk.proxy.onGet({ requestId: (7 as any), requestDetailsJson: getJson({ timeout: 30 }) });
  ok("passkey proxy: a locked vault waits, then ends with Chrome's normal error", lk.calls[0].get.error?.name === "NotAllowedError");
  ok("passkey proxy: a locked vault is not attached before it can list passkeys", (await lk.proxy.refresh(), !lk.calls.includes("attach")));

  // all sites on: attached on any web page, even with nothing stored
  const all = await setup({ allSites: true, url: "https://new-site.test/" });
  await all.proxy.refresh();
  ok("passkey proxy: all sites on attaches on a site with no passkey", all.calls.join() === "attach");
  all.state.allSites = false;
  all.proxy.invalidate();
  await all.proxy.refresh();
  ok("passkey proxy: all sites off goes back to attaching only where a passkey is stored", all.calls.join() === "attach,detach");
  all.state.url = "chrome://extensions/";
  all.state.allSites = true;
  await all.proxy.refresh();
  ok("passkey proxy: all sites on still stays detached on a non-web page", all.calls.join() === "attach,detach");

  // create, then get: the assertion verifies with the public key returned at registration
  const cr = await setup({ allSites: true });
  await cr.proxy.onCreate({ requestId: (20 as any), requestDetailsJson: createJson() });
  const created = JSON.parse(cr.calls.find((x) => x.create).create.responseJson);
  ok("passkey proxy: create on a site with no passkey stores it", (await listPasskeys(cr.client, 1)).length === 1 && !!created.id);
  await cr.proxy.onGet({ requestId: (21 as any), requestDetailsJson: getJson({ allowCredentials: [{ type: "public-key", id: created.rawId }] }) });
  const got = JSON.parse(cr.calls.find((x) => x.get).get.responseJson);
  const pub = await crypto.subtle.importKey("spki", pkUnb64u(created.response.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const der = pkUnb64u(got.response.signature);
  const derInt = (at: any) => { const l = der[at + 1]; let x = der.slice(at + 2, at + 2 + l); while (x.length > 32) x = x.slice(1); const o = new Uint8Array(32); o.set(x, 32 - x.length); return [o, at + 2 + l]; };
  const [r1, next] = derInt(2);
  const [r2] = derInt(next);
  const sigRaw = new Uint8Array(64);
  sigRaw.set(r1);
  sigRaw.set(r2, 32);
  const adBytes = pkUnb64u(got.response.authenticatorData);
  const cdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", pkUnb64u(got.response.clientDataJSON)));
  const signed = new Uint8Array(adBytes.length + 32);
  signed.set(adBytes);
  signed.set(cdHash, adBytes.length);
  ok("passkey proxy: a get after a create verifies with the public key from the create", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sigRaw, signed));

  // excludeCredentials that matches a stored passkey
  cr.calls.length = 0;
  await cr.proxy.onCreate({ requestId: (22 as any), requestDetailsJson: createJson({ excludeCredentials: [{ type: "public-key", id: created.rawId }] }) });
  ok("passkey proxy: excludeCredentials matching a stored passkey gives InvalidStateError and saves nothing", cr.calls[0].create.error?.name === "InvalidStateError" && (await listPasskeys(cr.client, 1)).length === 1);
  cr.calls.length = 0;
  await cr.proxy.onCreate({ requestId: (23 as any), requestDetailsJson: createJson({ excludeCredentials: [{ type: "public-key", id: "zzzzzzzzzzzz" }] }) });
  ok("passkey proxy: excludeCredentials that match nothing still creates", !!cr.calls[0].create.responseJson);

  // two passkeys of one user on one site both exist; the same credential id is skipped
  ok("passkey store: a second passkey for the same user and site is saved", (await listPasskeys(cr.client, 1)).length === 2);
  const again = await listPasskeys(cr.client, 1);
  const rd = (await readPasskey(cr.client, 1, again[0]) as any);
  ok("passkey store: a record with an existing credential id is skipped", (await savePasskey(cr.client, 1, rd.record, { pollMs: 1 })) === "exists" && (await listPasskeys(cr.client, 1)).length === 2);

  // stay-unlocked cache: off keeps nothing, on keeps the read passkey, a locked helper still signs, clearing drops it
  const stay = await setup();
  const kept = await seed(stay.client);
  await stay.proxy.onGet({ requestId: (30 as any), requestDetailsJson: getJson() });
  ok("passkey proxy: stay unlocked off keeps nothing in the session cache", !("passkeyCache" in stay.session.data));
  stay.state.stayUnlocked = true;
  await stay.proxy.onGet({ requestId: (31 as any), requestDetailsJson: getJson() });
  ok("passkey proxy: stay unlocked on keeps the passkey after a read", !!(stay.session.data as any).passkeyCache?.["example.test"]?.[kept.credentialId]);
  const reads = { n: 0 };
  const realRead = stay.client.getPasswordForLoginName;
  stay.client.getPasswordForLoginName = async (...a) => (reads.n++, realRead(...a));
  stay.calls.length = 0;
  await stay.proxy.onGet({ requestId: (32 as any), requestDetailsJson: getJson() });
  ok("passkey proxy: a cached passkey signs without reading through the helper", reads.n === 0 && !!stay.calls[0].get.responseJson);
  stay.client.state = "locked";
  Object.defineProperty(stay.client, "ready", { get: () => false, configurable: true });
  stay.calls.length = 0;
  await stay.proxy.onGet({ requestId: (33 as any), requestDetailsJson: getJson() });
  ok("passkey proxy: a cached passkey signs while the helper is locked", !!stay.calls[0].get.responseJson);
  await stay.proxy.clearCache();
  ok("passkey proxy: clearing the cache drops the kept passkeys", !("passkeyCache" in stay.session.data));

  // nudge: a get with no passkey for the site leaves its rp id for the popup
  const nd = await setup({ allSites: true });
  await nd.proxy.onGet({ requestId: (40 as any), requestDetailsJson: getJson() });
  ok("passkey proxy: a get with no passkey saves the nudge and ends with Chrome's normal error", (nd.session.data as any).passkeyNudge?.rpId === "example.test" && nd.calls.find((x) => x.get).get.error?.name === "NotAllowedError");
  ok("passkey login filter: passkey rows are hidden from fill lists", isPasskeyLogin({ username: "example.test · ann · AAAAAAAA", sites: [] }) && isPasskeyLogin({ username: "x", sites: ["passkeys.passbridge.invalid"] }) && !isPasskeyLogin({ username: "me@example.com", sites: ["example.com"] }));
  const logins = [{ username: "Alex@Mail.com" }, { username: "sam" }, { username: "" }];
  const names = (q: any) => filterByUsername(logins, q).map((l) => l.username);
  ok("username filter: case is ignored", names("ALEX").join() === "Alex@Mail.com");
  ok("username filter: outer spaces are ignored", names("  sam ").join() === "sam");
  ok("username filter: part of a name matches", names("mail").join() === "Alex@Mail.com");
  ok("username filter: empty query keeps all", names("").length === 3 && names("   ").length === 3);
  ok("username filter: no match gives an empty list", names("zzz").length === 0);
  const codes = [{ id: 1, username: "sam" }, { id: 2, username: "alex@mail.com" }, { id: 3, username: "bob" }, { id: 4 }];
  const ids = (q: any) => codesForLogins(codes, filterByUsername(logins, q), q).map((c) => c.id).join();
  ok("codes: grouped codes follow their kept login", ids("sam") === "1");
  ok("codes: an ungrouped code stays when its username matches", ids("bo") === "3");
  ok("codes: empty query keeps every code", ids("") === "1,2,3,4");
  ok("codes: an ungrouped code without a username is hidden by a query", !ids("sam").includes("4"));
}
// the save offer for a login we just autofilled: a corrected password is a change, not a re-login
{
  const target = (p: any) => pickSaveTarget(p);
  const existing = ["ada@example.com"];

  ok("save: an unchanged autofilled login is not offered", target({ existing, detected: "ada@example.com", newPwCtx: false }) === null);
  ok(
    "save: a password corrected after autofill is offered as an update",
    target({ existing, detected: "ada@example.com", newPwCtx: newPasswordContext(({ passwordCount: 1, correctedAfterFill: true } as any)) }) === "ada@example.com",
  );
  ok(
    "save: a corrected password with no username read off the form attaches to the recent login",
    target({ existing, detected: "", newPwCtx: newPasswordContext(({ passwordCount: 1, correctedAfterFill: true } as any)), recent: "ada@example.com" }) === "ada@example.com",
  );
  ok("save: no username and no change still saves nothing", target({ existing, detected: "", newPwCtx: false }) === null);
  ok("save: an unknown username is saved as typed", target({ existing, detected: "new@example.com", newPwCtx: false }) === "new@example.com");
  ok("save: a generated password updates the matched login", target({ existing, detected: "ada@example.com", generated: true }) === "ada@example.com");
  ok("save: a generated password with no match lets Apple's sheet ask", target({ existing: [], detected: "", generated: true }) === "");
  ok("save: the username match ignores case", target({ existing: ["Ada@Example.com"], detected: "ada@example.com", newPwCtx: true }) === "Ada@Example.com");

  ok("new password context: a plain one-field login is not a new password", !newPasswordContext(({ passwordCount: 1 } as any)));
  ok("new password context: a correction after autofill is", newPasswordContext(({ passwordCount: 1, correctedAfterFill: true } as any)));
  ok("new password context: two password fields are", newPasswordContext(({ passwordCount: 2 } as any)));
  ok("new password context: autocomplete=new-password is", newPasswordContext(({ passwordCount: 1, hasNewPasswordMark: true } as any)));
  ok("new password context: a generated password is", newPasswordContext(({ passwordCount: 1, generated: true } as any)));
}

ok("add login: same username shown takes the new-login sheet", useNewLoginSheet({ username: "me@x.com", before: 1, canSheet: true }));
ok("add login: no match saves normally", !useNewLoginSheet({ username: "me@x.com", before: 0, canSheet: true }));
ok("add login: empty username saves normally", !useNewLoginSheet({ username: "  ", before: 2, canSheet: true }));
ok("add login: helper without the sheet saves normally", !useNewLoginSheet({ username: "me@x.com", before: 1, canSheet: false }));

console.log(failed ? `\n${failed} failed` : "\nunit ok");
process.exit(failed ? 1 : 0);
