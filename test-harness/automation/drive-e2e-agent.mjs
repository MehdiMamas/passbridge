// e2e: the agent relay with the simulated helper behind it. The relay (native/passbridge-agent.py) is started by the
// browser, and the reference client (native/passbridge-agent-cli.py) asks it to sign in; the password comes from the
// helper's vault and never appears in a reply. Both platforms.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { BASE, main, ok } from "./lib.mjs";
import { seedVault } from "../fake-apple-helper/helper.mjs";
import { AGENT_CLI, PLATFORMS, pairFromMenu, startE2E } from "./e2e-lib.mjs";

const cli = (appDir, ...args) =>
  new Promise((resolve) => {
    execFile("python3", ["-I", AGENT_CLI, ...args], { env: { ...process.env, PASSBRIDGE_APPDIR: appDir }, timeout: 110000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: `unreadable: ${stdout} ${err?.message ?? ""}` });
      }
    });
  });

// a second login that nothing has read yet, so a denied approval is not answered from the extension's memory
const vault = () => {
  const v = seedVault();
  v.logins.push({ username: "deny@pb-e2e.invalid", password: "deny-Pass", sites: ["127.0.0.1"] });
  return v;
};

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (n) => `${platform}: ${n}`;
    const { ctx, helper, appDir } = await startE2E(platform, { agent: true, vault: vault() });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);

    // not paired yet: the relay answers and says so
    await sw.evaluate(() => chrome.storage.sync.set({ agentSignIn: true, agentAllowlist: ["127.0.0.1"], canFillOnHttp: true }));
    const sock = join(appDir, "agent.sock");
    for (let i = 0; i < 60 && !existsSync(sock); i++) await page.waitForTimeout(250);
    ok(t("the relay is listening once the setting is on"), existsSync(sock));
    const tabId = await sw.evaluate(async (base) => (await chrome.tabs.query({})).find((x) => x.url?.startsWith(base))?.id, BASE);
    const before = await cli(appDir, "status");
    ok(t("status: enabled and not paired"), before.ok && before.enabled === true && before.paired === false, JSON.stringify(before));
    const locked = await cli(appDir, "sign_in", String(tabId));
    ok(t("sign_in before pairing needs the user"), locked.ok === false && locked.error === "needs_user", JSON.stringify(locked));

    ok(t("paired"), await pairFromMenu(page, helper));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const status = await cli(appDir, "status");
    ok(t("status: paired"), status.ok && status.paired === true, JSON.stringify(status));
    const logins = await cli(appDir, "logins", String(tabId));
    ok(t("logins lists the saved usernames"), logins.ok && [...(logins.usernames ?? [])].sort().join() === "deny@pb-e2e.invalid,mia@pb-e2e.invalid", JSON.stringify(logins));

    // Touch ID denied: needs_user, nothing filled
    helper.auth = "deny";
    const denied = await cli(appDir, "sign_in", String(tabId), "deny@pb-e2e.invalid");
    ok(t("a denied approval is needs_user"), denied.ok === false && denied.error === "needs_user", JSON.stringify(denied));
    ok(t("and the page is untouched"), (await page.inputValue('input[name="password"]')) === "", await page.inputValue('input[name="password"]'));

    helper.auth = "approve";
    const done = await cli(appDir, "sign_in", String(tabId), "mia@pb-e2e.invalid");
    ok(t("sign_in succeeds"), done.ok === true && done.username === "mia@pb-e2e.invalid", JSON.stringify(done));
    ok(t("the page got the login"), (await page.inputValue('input[name="password"]')) === "e2e-Pass-1" && (await page.inputValue('input[name="username"]')) === "mia@pb-e2e.invalid");
    ok(t("no reply carries the password"), !JSON.stringify([status, logins, done]).includes("e2e-Pass-1"));

    const gone = await cli(appDir, "sign_in", "999999");
    ok(t("a tab that does not exist is no_tab"), gone.ok === false && gone.error === "no_tab", JSON.stringify(gone));
    await page.close();
  }
});
