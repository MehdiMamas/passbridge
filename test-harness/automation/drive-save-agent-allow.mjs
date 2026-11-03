import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.mjs";

// the save bar's "Let agents sign in" checkbox: shown and ticked for a generated password,
// saving adds the site to the agent allowlist, and a page can never add one itself
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0];
  const setSettings = (o) => sw.evaluate((v) => chrome.storage.sync.set(v), o);
  const list = () => sw.evaluate(() => chrome.storage.sync.get({ agentAllowlist: [] }).then((o) => o.agentAllowlist));
  const barOf = async (page) => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((fr) => fr.url().includes("overlay/save-bar.html"));
      if (f && (await f.locator("[data-field=password]").count())) return f;
      await page.waitForTimeout(150);
    }
    return null;
  };
  // signup page: pick the generator row, then submit
  const signup = async () => {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/signup.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("#email", "new@example.org");
    await page.fill("#username", "newuser");
    await page.focus("#new-password");
    await page.waitForTimeout(600);
    await clickMenu(page, "Strong Password");
    await page.waitForTimeout(400);
    await page.click("button[type=submit]");
    return page;
  };

  await setSettings({ agentSignIn: true, agentAllowAll: false, agentAllowlist: ["github.com"] });
  const page = await signup();
  const bar = await barOf(page);
  ok("save bar appears after a generated password", !!bar);
  const box = bar.locator("[data-field=allow-agent]");
  await box.waitFor({ timeout: 3000 });
  ok("checkbox shown and ticked for a generated password", (await box.count()) === 1 && (await box.isChecked()));
  await bar.locator("[data-action=save]:not([disabled])").waitFor();
  await bar.locator("[data-action=save]").click();
  await page.waitForTimeout(600);
  const after = await list();
  ok("saving with it ticked adds the host once", after.includes("127.0.0.1") && after.filter((h) => h === "127.0.0.1").length === 1 && after.includes("github.com"), JSON.stringify(after));

  // already listed: no checkbox
  const again = await signup();
  const bar2 = await barOf(again);
  ok("no checkbox for a host already allowed", !!bar2 && (await bar2.locator("[data-field=allow-agent]").count()) === 0);

  // a content script cannot add a site: the page frame is not the bar
  await setSettings({ agentAllowlist: ["github.com"] });
  const forged = await ctx.newPage();
  await forged.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await forged.fill("input[name=username]", "x@example.org");
  await forged.fill("input[name=password]", "hunter2-pw");
  await forged.click("button[type=submit]");
  const bar3 = await barOf(forged);
  ok("typed password: checkbox shown but not ticked", !!bar3 && (await bar3.locator("[data-field=allow-agent]").count()) === 1 && !(await bar3.locator("[data-field=allow-agent]").isChecked()));
  await bar3.locator("[data-action=save]:not([disabled])").waitFor();
  await bar3.locator("[data-action=save]").click();
  await forged.waitForTimeout(600);
  ok("saving unticked leaves the allowlist unchanged", JSON.stringify(await list()) === JSON.stringify(["github.com"]), JSON.stringify(await list()));

  // agent sign-in off: no checkbox
  await setSettings({ agentSignIn: false });
  const off = await signup();
  const bar4 = await barOf(off);
  ok("no checkbox with agent sign-in off", !!bar4 && (await bar4.locator("[data-field=allow-agent]").count()) === 0);
});
