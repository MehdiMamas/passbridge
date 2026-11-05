// e2e: fill from the simulated helper's vault, then save a new login and an update through the real protocol,
// checking what the helper received. Both platforms.

import { BASE, clickMenu, main, ok } from "./lib.mjs";
import { PLATFORMS, pairFromMenu, startE2E } from "./e2e-lib.mjs";

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (/** @type {string} */ n) => `${platform}: ${n}`;
    const { ctx, helper } = await startE2E(platform);
    const url = `${BASE}/login-standard.html`;
    const barOf = async (/** @type {import("playwright-core").Page} */ page) => {
      for (let i = 0; i < 40; i++) {
        const f = page.frames().find((/** @type {import("playwright-core").Frame} */ fr) => fr.url().includes("overlay/save-bar.html"));
        if (f && (await f.locator("[data-field=password]").count())) return f;
        await page.waitForTimeout(150);
      }
      return null;
    };
    // the bar can be rebuilt right after it appears: let it settle, take the frame again, click without waiting on animation
    const press = async (/** @type {import("playwright-core").Page} */ page) => {
      await page.waitForTimeout(800);
      const f = /** @type {import("playwright-core").Frame} */ (await barOf(page));
      await f.locator("[data-action=save]:not([disabled])").waitFor();
      await f.locator("[data-action=save]").dispatchEvent("click");
      await page.waitForTimeout(1200);
    };

    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    ok(t("paired"), await pairFromMenu(page, helper));
    ok(t("the login's username was filled"), (await page.inputValue('input[name="username"]')) === "mia@pb-e2e.invalid", await page.inputValue('input[name="username"]'));
    ok(t("the login's password was filled"), (await page.inputValue('input[name="password"]')) === "e2e-Pass-1", await page.inputValue('input[name="password"]'));
    ok(t("the helper was asked to approve the password read"), helper.authPrompts === 1, String(helper.authPrompts));

    // a login the vault does not hold is offered for saving
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("input[name=username]", "new@pb-e2e.invalid");
    await page.fill("input[name=password]", "n3w-Pass");
    await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("button[type=submit]")).click());
    const bar = await barOf(page);
    ok(t("a new login offers to save"), !!bar, "no save bar");
    if (!bar) continue;
    await press(page);
    ok(t("the helper received the new login"), helper.saved.length === 1 && helper.saved[0].username === "new@pb-e2e.invalid" && helper.saved[0].password === "n3w-Pass" && !helper.saved[0].updated, JSON.stringify(helper.saved));

    // the same login with another password is an update
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.focus("input[name=username]");
    await page.waitForTimeout(600);
    await clickMenu(page, "new@pb-e2e.invalid");
    await page.waitForTimeout(1200);
    ok(t("the saved login fills"), (await page.inputValue("input[name=password]")) === "n3w-Pass", await page.inputValue("input[name=password]"));
    await page.fill("input[name=password]", "n3w-Pass-2");
    await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("button[type=submit]")).click());
    const bar2 = await barOf(page);
    ok(t("a changed password offers an update"), !!bar2 && /Update password/i.test(await bar2.locator("body").innerText()), bar2 ? await bar2.locator("body").innerText() : "no save bar");
    if (!bar2) continue;
    await press(page);
    ok(t("the helper updated the login"), helper.saved.length === 2 && helper.saved[1].updated && helper.saved[1].password === "n3w-Pass-2", JSON.stringify(helper.saved));
    await page.close();
  }
});
