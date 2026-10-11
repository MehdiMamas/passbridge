import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__ev = { input: 0, change: 0 };
    for (const sel of ["input[name=username]", "input[name=password]"]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.addEventListener("input", () => window.__ev.input++);
      el.addEventListener("change", () => window.__ev.change++);
    }
  });
  await page.waitForTimeout(200);
  await page.focus("input[name=username]");
  await page.waitForTimeout(400);
  ok("offer row is up", await clickMenu(page, "test@example.com"), "no row");
  await page.waitForTimeout(600);
  const ev = await page.evaluate(() => window.__ev);
  const uval = await page.inputValue("input[name=username]");
  const pval = await page.inputValue("input[name=password]");
  ok("username and password filled", uval === "test@example.com" && pval.length > 0, `username="${uval}" password=${pval ? "(filled)" : "(empty)"}`);
  ok("#9 input+change events fire on fill", ev.input >= 2 && ev.change >= 2, JSON.stringify(ev));
});
