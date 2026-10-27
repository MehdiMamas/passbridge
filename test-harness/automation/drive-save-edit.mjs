import { BASE, build, launchExtension, main, ok } from "./lib.mjs";

// the save prompt shows the captured login for editing, and Save stores what is in the fields
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0];
  const barOf = async (page) => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((fr) => fr.url().includes("overlay/save-bar.html"));
      if (f && (await f.locator("[data-field=password]").count())) return f;
      await page.waitForTimeout(150);
    }
    return null;
  };
  const submit = async (page, user, pass) => {
    await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", pass);
    await page.click("button[type=submit]");
  };

  const page = await ctx.newPage();
  await submit(page, "alice@example.org", "hunter2-pw");
  const bar = await barOf(page);
  ok("save prompt appears", !!bar, "no save-bar frame");
  const u = bar.locator("[data-field=username]");
  const p = bar.locator("[data-field=password]");
  await bar.locator("[data-action=save]:not([disabled])").waitFor();
  ok("username shown prefilled", (await u.inputValue()) === "alice@example.org", await u.inputValue());
  ok("password shown prefilled", (await p.inputValue()) === "hunter2-pw", await p.inputValue());
  ok("password hidden by default", (await p.getAttribute("type")) === "password");
  await bar.locator("[data-action=toggle]").click();
  ok("toggle reveals the password", (await p.getAttribute("type")) === "text");
  ok("filled username is not highlighted", !/border-danger/.test((await u.getAttribute("class")) || ""));

  // keystrokes stay in the bar: the page's own fields are untouched
  await u.fill("");
  await u.pressSequentially("bob@example.org");
  ok("page username field unchanged by typing in the bar", (await page.inputValue("input[name=username]")) === "alice@example.org");
  await bar.locator("[data-action=save]").click();
  await page.waitForTimeout(500);
  const saved = await sw.evaluate(() => globalThis.__mockSaved || []);
  ok("Save stores the edited username and the password", saved.length === 1 && saved[0].username === "bob@example.org" && saved[0].password === "hunter2-pw", JSON.stringify(saved));
  ok("prompt closes after Save", !page.frames().some((fr) => fr.url().includes("overlay/save-bar.html")));

  // an emptied username stays savable but is flagged
  const page2 = await ctx.newPage();
  await submit(page2, "carol@example.org", "another-pw1");
  const bar2 = await barOf(page2);
  ok("second prompt appears", !!bar2);
  await bar2.locator("[data-action=save]:not([disabled])").waitFor();
  const u2 = bar2.locator("[data-field=username]");
  await u2.fill("");
  ok("empty username is highlighted", /border-danger/.test((await u2.getAttribute("class")) || ""));
  ok("empty username shows a placeholder", !!(await u2.getAttribute("placeholder")));
  ok("Save stays enabled with an empty username", await bar2.locator("[data-action=save]").isEnabled());
  await bar2.locator("[data-action=save]").click();
  await page2.waitForTimeout(500);
  const saved2 = await sw.evaluate(() => globalThis.__mockSaved || []);
  ok("empty username saves with the password", saved2.length === 2 && saved2[1].username === "" && saved2[1].password === "another-pw1", JSON.stringify(saved2));
});
