import { BASE, build, launchExtension, main, menuShown, ok, waitFor } from "./lib.ts";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/testbench.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  for (const [id, want] of ([["#u1", true], ["#u2", true], ["#s1", false], ["#tag1", false], ["#c1", false], ["#n1", false]] as [string, boolean][])) {
    await page.locator(id).focus().catch(() => {});
    // a field that should show the menu gets time to; one that should not must stay without it for a settle period
    if (want) await waitFor(() => menuShown(page), 5000);
    else await page.waitForTimeout(700);
    const shown = await menuShown(page);
    ok(`${id} dropdown=${shown} (want ${want})`, shown === want);
    await page.click("h1").catch(() => {});
    // the next field must start with no menu left over from this one
    await waitFor(async () => !(await menuShown(page)), 5000);
  }
});
