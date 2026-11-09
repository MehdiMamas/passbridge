import { Clock } from "lucide";
import { BASE, build, clickMenu, launchExtension, main, menuShown, menuText, ok, pierced } from "./lib.ts";

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
    const view = await pierced(page);
    const icon = view.find((n) => n.nodeName.toLowerCase() === "svg");
    const drawn = (icon?.children || []).map((c) => ({ tag: c.nodeName.toLowerCase(), attrs: view.attrs(c) }));
    const isClock = drawn.length === Clock.length && Clock.every(([tag, attrs], i) => drawn[i].tag === tag && Object.entries(attrs).every(([k, v]) => drawn[i].attrs[k] === String(v)));
    ok("singlefield: the code row icon is Lucide's clock", isClock, JSON.stringify(drawn));
    await clickMenu(page, "Verification code");
    await page.waitForTimeout(600);
    const v = await page.inputValue('input[name="otp"]');
    ok("singlefield: whole code filled", v === "246810", `value="${v}"`);
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-totp-pin.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="totpPin"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok("totpPin: code row offered on focus", /Verification code/.test(t), `got "${t}"`);
    ok("totpPin: not treated as a username", !/Fill login|Passwords for/i.test(t), `got "${t}"`);
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-totp-pin-chip.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="totpPin"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    const iTwo = t.indexOf("synthetic.two@example.test");
    const iAlice = t.indexOf("alice@example.com");
    ok(
      "otp: chip page puts this account's code first with \"This account\"",
      iTwo >= 0 && iAlice > iTwo && /This account/.test(t),
      `got "${t}"`,
    );
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-totp-pin.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="totpPin"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    const iTwo = t.indexOf("synthetic.two@example.test");
    const iAlice = t.indexOf("alice@example.com");
    ok(
      "otp: page without chip keeps order and shows no \"This account\"",
      iAlice >= 0 && iTwo > iAlice && !/This account/.test(t),
      `got "${t}"`,
    );
    await page.close();
  }

  for (const name of ["pivot", "autopilot"]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/otp-totp-pin.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate((n) => {
      const el = (document.querySelector("input") as HTMLInputElement);
      el.name = n;
      el.id = n;
    }, name);
    await page.waitForTimeout(300);
    await page.focus(`input[name="${name}"]`);
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok(`${name}: no code row`, !/Verification code/.test(t), `got "${t}"`);
    await page.close();
  }

  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login-okta-passcode.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      (document.querySelector('label[for="input28"]') as HTMLElement).textContent = "Enter code";
    });
    await page.waitForTimeout(300);
    await page.focus('input[name="credentials.passcode"]');
    await page.waitForTimeout(600);
    const t = await menuText(page);
    ok("okta passcode labelled as a code: code row offered", /Verification code/.test(t), `got "${t}"`);
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
