import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/testbench.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.locator("#u2").focus();
  await page.waitForTimeout(400);
  ok("offer row on #u2", await clickMenu(page, "test@example.com"), "no row to click");
  await page.waitForTimeout(600);
  const u1 = await page.inputValue("#u1");
  const u2 = await page.inputValue("#u2");
  ok("fill targets #u2 (the field acted on), not #u1", u2 === "test@example.com" && u1 === "", `u1="${u1}" u2="${u2}"`);
});
