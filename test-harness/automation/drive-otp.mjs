import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/otp", import.meta.url));
const results = [];
const ok = (n, c, d) => { results.push({ n, c }); console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " -> " + d}`); };

const ctx = await chromium.launchPersistentContext("/tmp/op-otp-" + Date.now(), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const box = (page) => page.locator('[data-passbridge="suggestions"]');
const txt = async (page) => (await box(page).count()) ? (await box(page).innerText()).replace(/\s+/g, " ").trim() : "";

{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/otp-multibox.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="code1"]');
  await page.waitForTimeout(600);
  const t = await txt(page);
  ok("multibox: code row offered on focus", /Verification code for acme\.example/.test(t) && /alice@example\.com/.test(t), `got "${t}"`);
  await box(page).locator("text=Verification code").click();
  await page.waitForTimeout(600);
  const digits = [];
  for (let i = 1; i <= 6; i++) digits.push(await page.inputValue(`input[name="code${i}"]`));
  ok("multibox: one digit per box", digits.join("") === "246810", `boxes="${digits.join(",")}"`);
  ok("multibox: dropdown closed after fill", (await box(page).count()) === 0, "still open");
  await page.close();
}

{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/otp-singlefield.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="otp"]');
  await page.waitForTimeout(600);
  ok("singlefield: code row offered on focus", /Verification code/.test(await txt(page)), await txt(page));
  await box(page).locator("text=Verification code").click();
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
  const t = await txt(page);
  ok("login field: no code row", /test@example\.com/.test(t) && !/Verification code/.test(t), `got "${t}"`);
  await page.close();
}

await ctx.close();
const failed = results.filter((r) => !r.c);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
