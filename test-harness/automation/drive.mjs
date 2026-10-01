import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
import { join } from "path";
const SHOTS = fileURLToPath(new URL("./shots", import.meta.url));
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";

async function withExt(extPath, label, fn) {
  const ctx = await chromium.launchPersistentContext("/tmp/op-prof-" + label + "-" + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--headless=new", "--no-first-run"],
  });
  ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  try { return await fn(ctx); } finally { await ctx.close(); }
}
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`); }
const box = (page) => page.locator('[data-passbridge="suggestions"]');
const txt = async (page) => (await box(page).count()) ? (await box(page).innerText()).replace(/\s+/g, " ").trim() : "";

const UNLOCKED = fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const LOCKED = fileURLToPath(new URL("./.builds/locked", import.meta.url));

await withExt(UNLOCKED, "unlocked", async (ctx) => {
  for (const pg of ["login-standard", "login-twostep", "signup", "forum"]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="username"]').catch(() => {});
    await page.waitForTimeout(500);
    const t1 = await txt(page);
    check(`unlocked/${pg}: offer on focus`, /test@example.com/i.test(t1), `got "${t1}"`);
    await page.screenshot({ path: join(SHOTS, `v4-${pg}-offer.png`) });
    await box(page).locator("text=test@example.com").click().catch(() => {});
    await page.waitForTimeout(500);
    const val = await page.inputValue('input[name="username"]').catch(() => "");
    check(`unlocked/${pg}: fills after click`, val === "test@example.com", `value="${val}"`);
    await page.click("body");
    await page.focus('input[name="username"]').catch(() => {});
    await page.waitForTimeout(300);
    check(`unlocked/${pg}: no offer when filled`, (await box(page).count()) === 0, "dropdown reappeared on filled field");
    await page.close();
  }
  for (const [pg, sel] of [["otp-multibox", 'input[name="code1"]'], ["otp-singlefield", 'input[name="otp"]']]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus(sel).catch(() => {});
    await page.waitForTimeout(400);
    check(`unlocked/${pg}: no dropdown on OTP`, (await box(page).count()) === 0, "dropdown appeared on OTP");
    await page.close();
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/forum.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="newsletter_email"]').catch(() => {});
  await page.waitForTimeout(400);
  check(`unlocked/forum-newsletter: no dropdown`, (await box(page).count()) === 0, "false positive on newsletter");
  await page.close();

  const clickPage = await ctx.newPage();
  await clickPage.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await clickPage.waitForTimeout(300);
  await clickPage.focus('input[name="username"]');
  await clickPage.waitForTimeout(600);
  const row = box(clickPage).locator("text=test@example.com");
  const r = await row.boundingBox();
  check("clickthrough: row is up", !!r, "no row");
  if (r) {
    await clickPage.evaluate(({ x, y, w, h }) => {
      const a = document.createElement("a");
      a.href = "#clicked-through";
      a.id = "behind";
      a.textContent = "forgot password";
      Object.assign(a.style, { position: "fixed", left: x + "px", top: y + "px", width: w + "px", height: h + "px", zIndex: "2147483646", display: "block", background: "pink" });
      document.body.appendChild(a);
    }, { x: r.x, y: r.y, w: r.width, h: r.height });
    await clickPage.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await clickPage.waitForTimeout(500);
    const hash = await clickPage.evaluate(() => location.hash);
    const filled = await clickPage.inputValue('input[name="username"]');
    check("clickthrough: click did not reach the link behind", hash !== "#clicked-through", `hash="${hash}"`);
    check("clickthrough: the row still filled", filled === "test@example.com", `value="${filled}"`);
  }
  await clickPage.close();

  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    const shortcutPage = await ctx.newPage();
    await shortcutPage.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await shortcutPage.waitForTimeout(300);
    await shortcutPage.click("body");
    await shortcutPage.waitForTimeout(200);
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "*://127.0.0.1/login-standard.html" });
      await chrome.tabs.sendMessage(tab.id, { type: "shortcut" });
    });
    await shortcutPage.waitForTimeout(600);
    const focused = await shortcutPage.evaluate(() => document.activeElement?.name || "");
    check("shortcut: focuses the login field", focused === "username", `active="${focused}"`);
    check("shortcut: offer appears", /test@example\.com/.test(await txt(shortcutPage)), await txt(shortcutPage));
    await shortcutPage.close();
  } else {
    check("service worker available for shortcut checks", false, "no service worker");
  }
});

await withExt(LOCKED, "locked", async (ctx) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]').catch(() => {});
  await page.waitForTimeout(400);
  check("locked: offer on focus", /Unlock to autofill/i.test(await txt(page)), await txt(page));
  await box(page).locator("text=Unlock to autofill").click().catch(() => {});
  await page.waitForTimeout(500);
  const t2 = await txt(page);
  check("locked: PIN field after click", /Enter the code/i.test(t2), `got "${t2}"`);
  await page.screenshot({ path: join(SHOTS, "v4-locked-pin.png") });
  await page.close();
});

const failed = results.filter(r => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
