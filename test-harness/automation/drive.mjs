import { join } from "path";
import { BASE, SHOTS, build, clickMenu, launchExtension, main, menuShown, menuText, ok, pierced } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  for (const pg of ["login-standard", "login-twostep", "signup", "forum"]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="username"]').catch(() => {});
    await page.waitForTimeout(500);
    const t1 = await menuText(page);
    ok(`unlocked/${pg}: offer on focus`, /test@example.com/i.test(t1), `got "${t1}"`);
    await page.screenshot({ path: join(SHOTS, `v4-${pg}-offer.png`) });
    await clickMenu(page, "test@example.com");
    await page.waitForTimeout(500);
    const val = await page.inputValue('input[name="username"]').catch(() => "");
    ok(`unlocked/${pg}: fills after click`, val === "test@example.com", `value="${val}"`);
    await page.click("body");
    await page.focus('input[name="username"]').catch(() => {});
    await page.waitForTimeout(300);
    ok(`unlocked/${pg}: no offer when filled`, !(await menuShown(page)), "dropdown reappeared on filled field");
    await page.close();
  }
  for (const [pg, sel] of [["otp-multibox", 'input[name="code1"]'], ["otp-singlefield", 'input[name="otp"]']]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus(sel).catch(() => {});
    await page.waitForTimeout(400);
    ok(`unlocked/${pg}: no dropdown on OTP`, !(await menuShown(page)), "dropdown appeared on OTP");
    await page.close();
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/forum.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="newsletter_email"]').catch(() => {});
  await page.waitForTimeout(400);
  ok(`unlocked/forum-newsletter: no dropdown`, !(await menuShown(page)), "false positive on newsletter");
  await page.close();

  const clickPage = await ctx.newPage();
  await clickPage.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await clickPage.waitForTimeout(300);
  await clickPage.focus('input[name="username"]');
  await clickPage.waitForTimeout(600);
  const view = await pierced(clickPage);
  const rowNode = view.menuElement("test@example.com");
  const r = rowNode ? await view.box(rowNode) : null;
  ok("clickthrough: row is up", !!r, "no row");
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
    ok("clickthrough: click did not reach the link behind", hash !== "#clicked-through", `hash="${hash}"`);
    ok("clickthrough: the row still filled", filled === "test@example.com", `value="${filled}"`);
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
    ok("shortcut: focuses the login field", focused === "username", `active="${focused}"`);
    const t = await menuText(shortcutPage);
    ok("shortcut: offer appears", /test@example\.com/.test(t), t);
    await shortcutPage.close();
  } else {
    ok("service worker available for shortcut checks", false, "no service worker");
  }
  await ctx.close();

  const locked = await launchExtension(build("locked", "OP_LOCKED"));
  const lp = await locked.newPage();
  await lp.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await lp.waitForTimeout(300);
  await lp.focus('input[name="username"]').catch(() => {});
  await lp.waitForTimeout(400);
  const lt = await menuText(lp);
  ok("locked: offer on focus", /Unlock to autofill/i.test(lt), lt);
  await clickMenu(lp, "Unlock to autofill");
  await lp.waitForTimeout(500);
  const t2 = await menuText(lp);
  ok("locked: PIN field after click", /Enter the code/i.test(t2), `got "${t2}"`);
  await lp.screenshot({ path: join(SHOTS, "v4-locked-pin.png") });
});
