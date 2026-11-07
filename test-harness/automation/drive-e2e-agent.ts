// e2e: the agent relay with the simulated helper behind it. The relay (native/passbridge-agent.py) is started by the
// browser, and the reference client (native/passbridge-agent-cli.py) asks it to sign in; the password comes from the
// helper's vault and never appears in a reply. Both platforms.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { BASE, main, ok } from "./lib.ts";
import { seedVault } from "../fake-apple-helper/helper.ts";
import { AGENT_CLI, PLATFORMS, startE2E } from "./e2e-lib.ts";

const cli = (appDir: string, ...args: string[]) => cliIn(appDir, "", ...args);
// stdin is how pair-pin gets the code (never argv)
const cliIn = (appDir: string, input: string, ...args: string[]) =>
  new Promise<any>((resolve) => {
    const child = execFile("python3", ["-I", AGENT_CLI, ...args], { env: { ...process.env, PASSBRIDGE_APPDIR: appDir, PASSBRIDGE_NO_WSL_REEXEC: "1" }, timeout: 110000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: `unreadable: ${stdout} ${err?.message ?? ""}` });
      }
    });
    child.stdin?.end(input);
  });

// a second login that nothing has read yet, so a denied approval is not answered from the extension's memory
const vault = () => {
  const v = seedVault();
  v.logins.push({ username: "deny@pb-e2e.invalid", password: "deny-Pass", sites: ["127.0.0.1"] });
  return v;
};

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (n: string) => `${platform}: ${n}`;
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

    // pair through the agent: pair_start shows the code, pair_pin takes it from stdin
    const started = await cli(appDir, "pair-start");
    ok(t("pair-start asks for a code"), started.ok === true && started.state === "needs_pin", JSON.stringify(started));
    await page.waitForTimeout(1500);
    const badPin = await cliIn(appDir, "12ab\n", "pair-pin");
    ok(t("a pin that is not 6 digits is bad_pin"), badPin.ok === false && badPin.error === "bad_pin", JSON.stringify(badPin));
    const wrong = helper.code === "000000" ? "111111" : "000000";
    const wrongPin = await cliIn(appDir, wrong + "\n", "pair-pin");
    ok(t("a wrong pin is wrong_pin"), wrongPin.ok === false && wrongPin.error === "wrong_pin", JSON.stringify(wrongPin));
    const restart = await cli(appDir, "pair-start");
    ok(t("a spent code is replaced by pair-start"), restart.ok === true && restart.state === "needs_pin", JSON.stringify(restart));
    await page.waitForTimeout(1500);
    const paired = await cliIn(appDir, helper.code + "\n", "pair-pin");
    ok(t("the right pin pairs"), paired.ok === true && paired.state === "paired" && helper.paired, JSON.stringify(paired));
    const again = await cli(appDir, "pair-start");
    ok(t("pair-start when paired says paired"), again.ok === true && again.state === "paired", JSON.stringify(again));
    const log = (await sw.evaluate(async () => (await chrome.storage.local.get("agentLog")).agentLog ?? [])) as any[];
    ok(t("the request log has the pair ops"), log.filter((e: any) => e.op === "pair_pin").length === 3, JSON.stringify(log));
    // the timestamp is 13 digits by design, so look at every other field
    ok(t("the request log holds no run of 6 digits"), !/\d{6}/.test(JSON.stringify(log.map((e: any) => ({ ...e, t: 0 })))), JSON.stringify(log));
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
