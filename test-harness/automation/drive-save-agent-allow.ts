import { BASE, build, clickMenu, launchExtension, main, ok } from "./lib.ts";

// the save bar offers "Allow agents to sign in on <site>"; only a click in the bar's own frame adds it to the allowlist
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0];
  const host = new URL(BASE).hostname;
  const setup = (settings: Record<string, unknown>) =>
    sw.evaluate(async (s) => {
      await chrome.storage.sync.set(s);
    }, { agentAllowlist: ["github.com"], ...settings });
  const list = () => sw.evaluate(() => chrome.storage.sync.get("agentAllowlist").then((o) => (o.agentAllowlist as string[])));
  const barOf = async (page: import("playwright-core").Page) => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((fr: import("playwright-core").Frame) => fr.url().includes("overlay/save-bar.html"));
      if (f && (await f.locator("[data-field=password]").count())) return f;
      await page.waitForTimeout(150);
    }
    return null;
  };
  // a create-account page; generated = pick the menu's Strong password, else type the same one twice
  const signup = async (page: import("playwright-core").Page, generated: boolean) => {
    await page.goto(`${BASE}/signup.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("#email", "new@example.org");
    await page.fill("#username", "newuser");
    if (generated) {
      await page.focus("#new-password");
      await page.waitForTimeout(600);
      await clickMenu(page, "Strong password");
      await page.waitForTimeout(400);
    } else {
      await page.fill("#new-password", "typed-by-hand-1");
      await page.fill("#confirm-password", "typed-by-hand-1");
    }
    await page.click("button[type=submit]");
    const bar = await barOf(page);
    if (bar) await bar.locator("[data-action=save]:not([disabled])").waitFor();
    return bar;
  };

  // generated password: checkbox shown and checked, Save adds the host
  await setup({ agentSignIn: true });
  const page = await ctx.newPage();
  const bar = (await signup(page, true) as import("playwright-core").Frame);
  ok("bar appears after a generated sign-up", !!bar);
  const box = bar.locator("[data-field=allow-agent]");
  ok("agent checkbox shown", (await box.count()) === 1);
  ok("agent checkbox starts checked for a generated password", await box.isChecked());
  const lbl = await bar.locator("label:has([data-field=allow-agent])").textContent();
  ok("agent checkbox names the host", (lbl || "").includes(host), JSON.stringify(lbl));
  await bar.locator("[data-action=save]").click();
  await page.waitForTimeout(600);
  ok("Save adds the host to agentAllowlist", (await list()).includes(host), JSON.stringify(await list()));
  ok("existing allowlist entries are kept", (await list()).includes("github.com"));

  // typed password: shown, unchecked, saving leaves the list alone
  await setup({ agentSignIn: true });
  const page2 = await ctx.newPage();
  const bar2 = (await signup(page2, false) as import("playwright-core").Frame);
  ok("agent checkbox shown for a typed password", !!bar2 && (await bar2.locator("[data-field=allow-agent]").count()) === 1);
  ok("agent checkbox starts unchecked for a typed password", !(await bar2.locator("[data-field=allow-agent]").isChecked()));
  await bar2.locator("[data-action=save]").click();
  await page2.waitForTimeout(600);
  ok("unticked Save leaves the allowlist alone", (await list()).join() === "github.com", JSON.stringify(await list()));

  // agent sign-in off: no checkbox
  await setup({ agentSignIn: false });
  const page3 = await ctx.newPage();
  const bar3 = await signup(page3, true);
  ok("no agent checkbox with agent sign-in off", !!bar3 && (await bar3.locator("[data-field=allow-agent]").count()) === 0);

  // a content script asking for allowAgent is ignored
  await setup({ agentSignIn: true });
  const page4 = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page4);
  const worlds: number[] = [];
  cdp.on("Runtime.executionContextCreated", (e) => {
    if (String(e.context.origin).startsWith("chrome-extension://") && e.context.auxData?.type === "isolated") worlds.push(e.context.id);
  });
  await cdp.send("Runtime.enable");
  const bar4 = await signup(page4, true);
  ok("bar appears for the forged request", !!bar4 && worlds.length > 0, `worlds=${worlds.length}`);
  let reply = null;
  for (const contextId of worlds) {
    const r = await cdp.send("Runtime.evaluate", {
      contextId,
      awaitPromise: true,
      returnByValue: true,
      expression: `chrome.runtime.sendMessage({ type: "confirmSave", allowAgent: true }).catch((e) => ({ err: String(e) }))`,
    });
    if (r.result?.value?.ok) { reply = r.result.value; break; }
  }
  await page4.waitForTimeout(600);
  ok("content-script confirmSave was answered", !!reply, JSON.stringify(reply));
  ok("content-script allowAgent leaves the allowlist unchanged", (await list()).join() === "github.com", JSON.stringify(await list()));
});
