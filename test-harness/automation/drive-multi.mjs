import { BASE, build, launchExtension, main, menuText, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("multi"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
  const t = await menuText(page);
  ok("multi-account chooser shows both", /alice@example\.com/.test(t) && /bob@work\.com/.test(t), `"${t}"`);
});
