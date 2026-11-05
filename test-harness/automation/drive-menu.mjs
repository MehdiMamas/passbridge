import { BASE, build, launchExtension, main, menuText, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]');
  await page.waitForTimeout(500);

  ok("menu host is up", (await page.locator('[data-passbridge-host="menu"]').count()) > 0, "no host");
  const shadow = await page.evaluate(() => {
    const el = document.querySelector('[data-passbridge-host="menu"]');
    if (!el) return "missing";
    return el.shadowRoot === null ? "closed" : "open";
  });
  ok("menu host shadow is closed", shadow === "closed", shadow);
  ok("field icon is up", (await page.locator("[data-passbridge-icon]").count()) > 0, "no icon");
  const text = await menuText(page);
  ok("suggestions still readable", /test@example.com/.test(text), text);

  // numeric id username next to a password still gets the menu (issue #49)
  await page.goto(`${BASE}/login-numeric-id.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus("#idField");
  await page.waitForTimeout(500);
  ok("numeric id username gets the menu", (await page.locator('[data-passbridge-host="menu"]').count()) > 0, "no host");
  ok("numeric id username gets the field icon", (await page.locator("[data-passbridge-icon]").count()) > 0, "no icon");
});
