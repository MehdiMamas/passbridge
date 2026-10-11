import { BASE, build, launchExtension, main, menuShown, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/testbench.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  for (const [id, want] of [["#u1", true], ["#u2", true], ["#s1", false], ["#tag1", false], ["#c1", false], ["#n1", false]]) {
    await page.locator(id).focus().catch(() => {});
    await page.waitForTimeout(350);
    const shown = await menuShown(page);
    ok(`${id} dropdown=${shown} (want ${want})`, shown === want);
    await page.click("h1").catch(() => {});
    await page.waitForTimeout(150);
  }
});
