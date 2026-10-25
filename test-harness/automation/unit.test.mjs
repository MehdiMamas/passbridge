import { ApplePasswords, Command, normalizeOtpEntries } from "../../src/apple/protocol.js";
import { otpAuthSecret, parseOtpAuth } from "../../src/otpauth.js";
import { generateApplePassword } from "../../src/password-generate.js";
import { hostsRelated, passwordSearchSteps } from "../../src/session/password-search.js";
import { registrableDomain, siteLookupHosts } from "../../src/session/site-domain.js";
import { orderByPageUsername, usernameMatchesPage } from "../../src/session/username-match.js";
import { frameUrlsFor } from "../../src/session/frame-urls.js";
import { reportIssueUrl, reportText, scrubAttr, scrubText, scrubUrl } from "../../src/report-scrub.js";

let failed = 0;
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
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

console.log(failed ? `\n${failed} failed` : "\nunit ok");
process.exit(failed ? 1 : 0);
