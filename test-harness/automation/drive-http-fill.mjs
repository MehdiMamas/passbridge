// plain-http pages: the login still lists, fill and save stay refused until canFillOnHttp is on
import { BASE, build, clickMenu, launchExtension, main, menuShown, menuText, ok } from "./lib.mjs";

// nip.io resolves 127.0.0.1.nip.io back to this machine, and it is not a local-dev
// hostname, so the same harness server serves a page the extension treats as plain http
const HTTP_BASE = BASE.replace("//127.0.0.1", "//127.0.0.1.nip.io");

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));

  const page = await ctx.newPage();
  await page.goto(`${HTTP_BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
  const t1 = await menuText(page);
  ok("http: login still offered", /test@example\.com/.test(t1), `got "${t1}"`);
  await clickMenu(page, "test@example.com");
  await page.waitForTimeout(600);
  const u1 = await page.inputValue('input[name="username"]');
  ok("http default: fill refused", u1 === "", `username="${u1}"`);
  const t2 = await menuText(page);
  ok("http default: refusal names HTTPS", /non-HTTPS/.test(t2), `got "${t2}"`);

  await sw.evaluate(() => chrome.storage.sync.set({ canFillOnHttp: true }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
  await clickMenu(page, "test@example.com");
  await page.waitForTimeout(600);
  const u2 = await page.inputValue('input[name="username"]');
  const p2 = await page.inputValue('input[name="password"]');
  ok("http opted in: fill works", u2 === "test@example.com" && p2 === "TestPass123", `user="${u2}" pass="${p2 ? "set" : "empty"}"`);
  ok("http opted in: menu closed after fill", !(await menuShown(page)), "still open");
});
