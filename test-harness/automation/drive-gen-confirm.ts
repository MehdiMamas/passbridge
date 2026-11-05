import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.ts";

// a page with no form whose script clears the confirm box when the first one changes (#169)
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  for (const [label, row, alnum] of /** @type {[string, string, boolean][]} */ ([
    ["strong", "Strong Password", false],
    ["no special characters", "Without Special Characters", true],
  ])) {
    await page.goto(`${BASE}/signup-noform-clears.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus("#pw1");
    await page.waitForTimeout(600);
    ok(`${label}: generator row clicked`, await clickMenu(page, row), "no row");
    await page.waitForTimeout(900);
    const a = await page.inputValue("#pw1");
    const b = await page.inputValue("#pw2");
    ok(`${label}: both boxes hold the same password`, a.length > 0 && a === b, `first=${a.length} chars, second=${b.length} chars`);
    if (alnum) ok(`${label}: letters and digits only`, /^[A-Za-z0-9]+$/.test(a), "has other characters");
  }
});
