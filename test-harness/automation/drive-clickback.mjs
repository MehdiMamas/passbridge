// regression: a scroll listener used to destroy the dropdown on the focus-scroll
import { BASE, build, clickMenu, launchExtension, main, menuShown, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/testbench.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.locator("#u1").click();
  await page.waitForTimeout(400);
  ok("first fill from #u1", await clickMenu(page, "test@example.com"), "no row on #u1");
  await page.waitForTimeout(600);
  let allShow = true;
  for (let i = 0; i < 3; i++) {
    await page.locator("#u2").click();
    await page.waitForTimeout(350);
    const shown = await menuShown(page);
    ok(`cycle ${i}: dropdown shows on #u2`, shown);
    if (!shown) allShow = false;
    await page.locator("h1").click();
    await page.waitForTimeout(250);
    ok(`cycle ${i}: hides after click away`, !(await menuShown(page)));
  }
  ok("dropdown reappears on every click-back", allShow);
});
