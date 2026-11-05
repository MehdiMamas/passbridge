import { BASE, build, launchExtension, main, menuShown, ok } from "./lib.mjs";

const ADV = `${BASE}/adversarial`;

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const negatives = [
    ["search-bar", ["#header-search", "#inline-search", "#form-search"]],
    ["social-tag", ["#tag-search", "#tag-combobox"]],
    ["compose-message", ["#dm-input", "#compose-textarea", "#compose-editable"]],
    ["comment-box", ["#comment-input", "#reply-input"]],
    ["checkout-address", ["#first-name", "#last-name", "#address", "#city", "#postal-code", "#email"]],
    ["newsletter", ["input[type=email]"]],
    ["profile-edit", ["#display-name", "#profile-email", "#profile-phone"]],
  ];
  for (const [pg, sels] of negatives) {
    const page = await ctx.newPage();
    await page.goto(`${ADV}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(250);
    for (const sel of sels) {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) {
        ok(`${pg} ${sel}: field exists`, false, "selector not found");
        continue;
      }
      await el.focus().catch(() => {});
      await page.waitForTimeout(300);
      ok(`${pg} ${sel}: no dropdown`, !(await menuShown(page)), "DROPDOWN APPEARED (false positive)");
      await page.click("body").catch(() => {});
    }
    await page.close();
  }

  const page = await ctx.newPage();
  await page.goto(`${ADV}/mixed-page.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  const searchSel = await page.evaluate(() => {
    const s = document.querySelector('input[type=search], [role=searchbox], input[name=q], input[placeholder*="Search" i]');
    return s ? (s.id ? "#" + s.id : "input[type=search]") : null;
  });
  if (searchSel) {
    await page.locator(searchSel).first().focus().catch(() => {});
    await page.waitForTimeout(300);
    ok("mixed-page search: no dropdown", !(await menuShown(page)), "dropdown on search box");
    await page.click("body").catch(() => {});
  } else ok("mixed-page search selector", false, "no search field found");
  const pwd = page.locator("input[type=password]").first();
  if (ok("mixed-page password field exists", (await pwd.count()) > 0, "no password field")) {
    await pwd.focus();
    await page.waitForTimeout(300);
    ok("mixed-page password: dropdown shows", await menuShown(page), "no dropdown on real password field");
  }
});
