import { BASE, build, launchExtension, main, ok } from "./lib.ts";

// A password corrected after autofill is a change worth saving, not a re-login to ignore (#224).
// The vault holds a stale value, we fill it, the user retypes the one that works, and the login
// succeeds: the save bar has to come back as an update instead of staying silent.
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0];
  const barOf = async (page: import("playwright-core").Page) => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((fr: import("playwright-core").Frame) => fr.url().includes("overlay/save-bar.html"));
      if (f && (await f.locator("[data-field=password]").count())) return f;
      await page.waitForTimeout(150);
    }
    return null;
  };

  const page = await ctx.newPage();
  const url = `${BASE}/login-standard.html`;

  // 1. a login the vault will later hold a stale password for
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.fill("input[name=username]", "ada@example.org");
  await page.fill("input[name=password]", "stale-pw1");
  await page.click("button[type=submit]");
  const first = await barOf(page);
  ok("first save prompt appears", !!first, "no save-bar frame");
  if (!first) return;
  await first.locator("[data-action=save]").click();
  await page.waitForTimeout(600);
  const stored = await sw.evaluate(() => (globalThis as any).__mockSaved || []);
  ok("the stale password is now in the vault", stored.length === 1 && stored[0].password === "stale-pw1", JSON.stringify(stored));

  // 2. back to the login page, and fill from the vault so lastAutofill is the stale value
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await sw.evaluate(
    async ({ url }) => {
      const tab = (((await chrome.tabs.query({})).find((t) => t.url?.startsWith(url))) as chrome.tabs.Tab);
      return chrome.tabs
        .sendMessage((tab.id as number), {
          type: "fill",
          username: "ada@example.org",
          password: "stale-pw1",
          expectedHost: new URL((tab.url as string)).hostname,
        })
        .catch(() => null);
    },
    { url },
  );
  await page.waitForTimeout(400);
  ok("autofill put the stale password in the field", (await page.inputValue("input[name=password]")) === "stale-pw1", await page.inputValue("input[name=password]"));

  // 3. correct it the way a user does when the vault is behind, then submit
  await page.fill("input[name=password]", "fresh-pw2");
  await page.click("button[type=submit]");
  const second = await barOf(page);
  ok("a corrected password still offers to save", !!second, "no save bar: the correction was dropped as a plain re-login");
  if (!second) return;
  await second.locator("[data-action=save]:not([disabled])").waitFor();
  ok(
    "the bar offers an update, not a new login",
    /Update password/i.test(await second.locator("body").innerText()),
    await second.locator("body").innerText(),
  );

  // 4. saving it replaces the stale password in the vault
  await second.locator("[data-action=save]").click();
  await page.waitForTimeout(600);
  const after = await sw.evaluate(() => (globalThis as any).__mockSaved || []);
  ok("the corrected password is saved", after.length === 2 && after[1].password === "fresh-pw2", JSON.stringify(after));
});
