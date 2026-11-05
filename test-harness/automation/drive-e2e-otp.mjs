// e2e: verification codes from the simulated helper: listed for the page's site only, read through the helper's
// approval, filled into one field or split boxes, and left unfilled when the approval is denied. Both platforms.

import { BASE, clickMenu, main, menuText, ok } from "./lib.mjs";
import { PLATFORMS, pairFromMenu, startE2E } from "./e2e-lib.mjs";

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (n) => `${platform}: ${n}`;
    const { ctx, helper } = await startE2E(platform);
    const login = await ctx.newPage();
    await login.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await login.waitForTimeout(300);
    ok(t("paired"), await pairFromMenu(login, helper));
    await login.close();

    const open = async (path, field) => {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(300);
      await page.focus(field);
      await page.waitForTimeout(800);
      return page;
    };

    const single = await open("otp-singlefield.html", 'input[name="otp"]');
    const text = await menuText(single);
    ok(t("the code for this site is offered"), /Verification code/.test(text) && /mia@pb-e2e\.invalid/.test(text), text);
    ok(t("another site's code is not offered"), !/other@pb-e2e\.invalid/.test(text), text);
    await clickMenu(single, "Verification code");
    await single.waitForTimeout(1200);
    ok(t("the whole code is filled"), (await single.inputValue('input[name="otp"]')) === "246810", await single.inputValue('input[name="otp"]'));
    await single.close();

    const multi = await open("otp-multibox.html", 'input[name="code1"]');
    await clickMenu(multi, "Verification code");
    await multi.waitForTimeout(1200);
    const digits = [];
    for (let i = 1; i <= 6; i++) digits.push(await multi.inputValue(`input[name="code${i}"]`));
    ok(t("split boxes get one digit each"), digits.join("") === "246810", digits.join(","));
    await multi.close();

    // Touch ID / Windows Hello says no: the code is not filled
    helper.auth = "deny";
    const denied = await open("otp-singlefield.html", 'input[name="otp"]');
    const prompts = helper.authPrompts;
    await clickMenu(denied, "Verification code");
    await denied.waitForTimeout(1500);
    ok(t("a denied approval fills nothing"), (await denied.inputValue('input[name="otp"]')) === "" && helper.authPrompts > prompts, `value="${await denied.inputValue('input[name="otp"]')}" prompts ${prompts} -> ${helper.authPrompts}`);
    await denied.close();
  }
});
