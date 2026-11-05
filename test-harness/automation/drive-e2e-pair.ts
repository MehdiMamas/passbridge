// e2e: the real extension against the simulated Apple helper. Pair with the code on the helper's screen (wrong code,
// then a code that expired, then the right one) on both platforms, and check no mock data is in the build.

import { readFile } from "fs/promises";
import { join } from "path";
import { BASE, HERE, build, clickMenu, main, menuText, ok, typeInMenu } from "./lib.ts";
import { PLATFORMS, startE2E } from "./e2e-lib.ts";

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (n: string) => `${platform}: ${n}`;
    const bundle = await readFile(join(build(`real-${platform}`, `OP_EXT_${platform.toUpperCase()}`), "src", "background.js"), "utf8");
    ok(t("the build holds no mock fixture data"), !bundle.includes("test@example.com"));

    const { ctx, helper } = await startE2E(platform);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="username"]');
    await page.waitForTimeout(600);
    ok(t("offers to unlock"), /Unlock to autofill/i.test(await menuText(page)), await menuText(page));
    await clickMenu(page, "Unlock to autofill");
    await page.waitForTimeout(1500);
    ok(t("the helper shows a code"), /^\d{6}$/.test(helper.code ?? ""), String(helper.code));

    const wrong = helper.code === "000000" ? "111111" : "000000";
    ok(t("typed a wrong code"), await typeInMenu(page, wrong), "no PIN input");
    await page.waitForTimeout(1500);
    ok(t("wrong code says incorrect"), /incorrect/i.test(await menuText(page)), await menuText(page));
    ok(t("the helper is not paired"), !helper.paired);

    // the person lets the code on screen lapse, then types it
    helper.expireChallenge();
    await page.waitForTimeout(200);
    await typeInMenu(page, helper.code);
    await page.waitForTimeout(1500);
    ok(t("a code the helper let lapse is refused"), /incorrect|new code|try again/i.test(await menuText(page)) && !helper.paired, await menuText(page));

    // the extension asks for a fresh code: type the one now on screen
    const fresh = helper.code;
    await page.keyboard.press("Escape");
    await page.focus('input[name="username"]').catch(() => {});
    await page.waitForTimeout(500);
    if (!(await typeInMenu(page, fresh))) {
      await clickMenu(page, "Unlock to autofill");
      await page.waitForTimeout(1500);
      await typeInMenu(page, helper.code);
    }
    await page.waitForTimeout(2000);
    ok(t("the right code pairs"), helper.paired, `dropdown="${await menuText(page)}"`);
    const val = await page.inputValue('input[name="username"]').catch(() => "");
    ok(t("and fills the only login"), val === "mia@pb-e2e.invalid", `username="${val}" dropdown="${await menuText(page)}"`);
    await page.close();
  }
});
