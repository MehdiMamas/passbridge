import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/clickjack.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus("input[name=username]");
  await page.waitForTimeout(400);
  ok("offer on the visible username field", await clickMenu(page, "test@example.com"), "no row");
  await page.waitForTimeout(600);
  const pval = await page.inputValue("input[name=password]").catch(() => "");
  ok("#18 hidden password field not filled (clickjack defense)", pval === "", "hidden field got filled");
});
