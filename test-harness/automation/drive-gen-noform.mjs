import { BASE, build, clickMenu, launchExtension, main, menuText, ok } from "./lib.mjs";

// a no-form page whose script clears the confirm box when the first changes: the generated fill must still reach both
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/signup-noform.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus("#pw1");
  await page.waitForTimeout(500);
  const text = await menuText(page);
  const clicked = await clickMenu(page, "Strong Password");
  ok("generator row found", clicked, `menu="${text}"`);
  await page.waitForTimeout(900);
  const a = await page.inputValue("#pw1"), b = await page.inputValue("#pw2");
  ok("both new-password boxes hold the same generated password", a.length > 0 && a === b, `first=${a.length} second=${b.length}`);
});
