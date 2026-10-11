import { BASE, build, clickMenu, launchExtension, main, menuShown, menuText, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("otp"));

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-multibox.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="code1"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok("multibox: code row offered on focus", /Verification code for acme\.example/.test(t) && /alice@example\.com/.test(t), `got "${t}"`);
    await clickMenu(page, "Verification code");
    await page.waitForTimeout(600);
    const digits = [];
    for (let i = 1; i <= 6; i++) digits.push(await page.inputValue(`input[name="code${i}"]`));
    ok("multibox: one digit per box", digits.join("") === "246810", `boxes="${digits.join(",")}"`);
    ok("multibox: dropdown closed after fill", !(await menuShown(page)), "still open");
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-singlefield.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="otp"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok("singlefield: code row offered on focus", /Verification code/.test(t), t);
    await clickMenu(page, "Verification code");
    await page.waitForTimeout(600);
    const v = await page.inputValue('input[name="otp"]');
    ok("singlefield: whole code filled", v === "246810", `value="${v}"`);
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="username"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok("login field: no code row", /test@example\.com/.test(t) && !/Verification code/.test(t), `got "${t}"`);
    await page.close();
  }
});
