import { join } from "path";
import { BASE, SHOTS, build, clickMenu, launchExtension, main, menuText, ok, typeInMenu } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("pinflow"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  await page.focus('input[name="username"]');
  await page.waitForTimeout(400);
  const offer = await menuText(page);
  ok("offer on focus", /Unlock to autofill/i.test(offer), offer);

  await clickMenu(page, "Unlock to autofill");
  await page.waitForTimeout(600);
  const prompt = await menuText(page);
  ok("PIN field appears after click", /Enter the|code shown|6-digit/i.test(prompt), prompt);
  await page.screenshot({ path: join(SHOTS, "pin-1-field.png") });

  // a short code only goes in on Enter
  ok("typed a wrong 5-digit code", await typeInMenu(page, "00000"), "no PIN input");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const wrongTxt = await menuText(page);
  ok("wrong code on Enter shows error (not stuck on Verifying)", /incorrect/i.test(wrongTxt) && !/verifying/i.test(wrongTxt), `got "${wrongTxt}"`);
  await page.screenshot({ path: join(SHOTS, "pin-2-wrong.png") });

  // six digits submit by themselves; the box then closes, so no Enter
  ok("typed the right 6-digit code", await typeInMenu(page, "123456"), "no PIN input");
  await page.waitForTimeout(1500);
  const val = await page.inputValue('input[name="username"]').catch(() => "");
  ok("correct code unlocks + fills without Enter", val === "test@example.com", `username value="${val}", dropdown="${await menuText(page)}"`);
  await page.screenshot({ path: join(SHOTS, "pin-3-filled.png") });
});
