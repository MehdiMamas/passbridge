// e2e: the agent save op through the relay and the real extension, with the simulated helper behind it.
// The reference client (native/passbridge-agent-cli.py) saves a login for an https site, logins lists it, a second save is
// exists, and with the setting off the answer is not_allowed. The password is read from stdin and never appears in a reply. Both platforms.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { BASE, main, ok } from "./lib.ts";
import { seedVault } from "../fake-apple-helper/helper.ts";
import { AGENT_CLI, PLATFORMS, pairFromMenu, startE2E } from "./e2e-lib.ts";

const SITE = "https://save.pb-e2e.example/";
const PASSWORD = "Sav3d-Secret-9";

const cli = (appDir: string, stdin: string, ...args: string[]) =>
  new Promise<any>((resolve) => {
    const child = execFile("python3", ["-I", AGENT_CLI, ...args], { env: { ...process.env, PASSBRIDGE_APPDIR: appDir, PASSBRIDGE_NO_WSL_REEXEC: "1" }, timeout: 110000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: `unreadable: ${stdout} ${err?.message ?? ""}` });
      }
    });
    child.stdin?.end(stdin);
  });

await main(async () => {
  for (const platform of PLATFORMS) {
    const t = (n: string) => `${platform}: ${n}`;
    const vault = seedVault();
    vault.logins.push({ username: "old@pb-e2e.invalid", password: "old-Pass", sites: ["save.pb-e2e.example"] });
    const { ctx, helper, appDir } = await startE2E(platform, { agent: true, vault });
    await ctx.route(SITE + "**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>save</title><form><input name=username><input name=password type=password></form>" }));
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
    const home = await ctx.newPage();
    await home.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await home.waitForTimeout(300);
    await sw.evaluate(() => chrome.storage.sync.set({ agentSignIn: true, agentSave: false, agentAllowlist: [] }));
    const sock = join(appDir, "agent.sock");
    for (let i = 0; i < 60 && !existsSync(sock); i++) await home.waitForTimeout(250);
    ok(t("paired"), await pairFromMenu(home, helper));

    const page = await ctx.newPage();
    await page.goto(SITE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const tabId = String(await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url?.startsWith(u))?.id, SITE));

    const status = await cli(appDir, "", "status");
    ok(t("status shows save off"), status.ok && status.save === false, JSON.stringify(status));
    const off = await cli(appDir, PASSWORD, "save", tabId, "new@pb-e2e.invalid");
    ok(t("save with the setting off is not_allowed"), off.ok === false && off.error === "not_allowed" && off.reason === "save_off", JSON.stringify(off));
    ok(t("and nothing was saved"), helper.saved.length === 0);

    await sw.evaluate(() => chrome.storage.sync.set({ agentSave: true }));
    await page.waitForTimeout(300);
    const on = await cli(appDir, "", "status");
    ok(t("status shows save on"), on.save === true, JSON.stringify(on));
    const saved = await cli(appDir, PASSWORD, "save", tabId, "new@pb-e2e.invalid");
    ok(t("save succeeds"), saved.ok === true && saved.username === "new@pb-e2e.invalid" && saved.domain === "save.pb-e2e.example", JSON.stringify(saved));
    ok(t("the helper got the login"), helper.saved.length === 1 && helper.saved[0].username === "new@pb-e2e.invalid" && helper.saved[0].password === PASSWORD && !helper.saved[0].updated);
    // logins keeps its own rules, so the site goes on the allowlist for the read (save needed no allowlist)
    await sw.evaluate(() => chrome.storage.sync.set({ agentAllowlist: ["save.pb-e2e.example"] }));
    await page.waitForTimeout(300);
    const list = await cli(appDir, "", "logins", tabId);
    ok(t("logins lists the new username"), list.ok && [...(list.usernames ?? [])].sort().join() === "new@pb-e2e.invalid,old@pb-e2e.invalid", JSON.stringify(list));
    const again = await cli(appDir, "other-Pass", "save", tabId, "NEW@pb-e2e.invalid");
    ok(t("a second save is exists"), again.ok === false && again.error === "exists", JSON.stringify(again));
    const old = await cli(appDir, "other-Pass", "save", tabId, "old@pb-e2e.invalid");
    ok(t("an existing login is exists and not overwritten"), old.error === "exists" && helper.saved.length === 1 && helper.vault.logins.find((l) => l.username === "old@pb-e2e.invalid")?.password === "old-Pass", JSON.stringify(old));
    // save by url: no tab named, then logins on the tab of that site lists it
    const URL_SITE = "https://urlsave.pb-e2e.example/";
    await ctx.route(URL_SITE + "**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>urlsave</title><form><input name=username><input name=password type=password></form>" }));
    const urlOnly = await cli(appDir, PASSWORD, "save", "--url", URL_SITE + "login?next=/x", "byurl@pb-e2e.invalid");
    ok(t("save by url succeeds"), urlOnly.ok === true && urlOnly.username === "byurl@pb-e2e.invalid" && urlOnly.domain === "urlsave.pb-e2e.example", JSON.stringify(urlOnly));
    ok(t("the helper got the url login"), helper.saved.length === 2 && helper.saved[1].username === "byurl@pb-e2e.invalid" && helper.saved[1].password === PASSWORD);
    const page2 = await ctx.newPage();
    await page2.goto(URL_SITE, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(500);
    const tabId2 = String(await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url?.startsWith(u))?.id, URL_SITE));
    await sw.evaluate(() => chrome.storage.sync.set({ agentAllowlist: ["save.pb-e2e.example", "urlsave.pb-e2e.example"] }));
    await page2.waitForTimeout(300);
    const list2 = await cli(appDir, "", "logins", tabId2);
    ok(t("logins on a tab of that site lists the url save"), list2.ok && (list2.usernames ?? []).includes("byurl@pb-e2e.invalid"), JSON.stringify(list2));
    const urlAgain = await cli(appDir, "other-Pass", "save", "--url", URL_SITE, "BYURL@pb-e2e.invalid");
    ok(t("a second save by url is exists"), urlAgain.ok === false && urlAgain.error === "exists", JSON.stringify(urlAgain));
    const urlHttp = await cli(appDir, "other-Pass", "save", "--url", "http://urlsave.pb-e2e.example/", "x@pb-e2e.invalid");
    ok(t("save by an http url is not_allowed"), urlHttp.error === "not_allowed", JSON.stringify(urlHttp));
    const log = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get("agentLog")));
    ok(t("no reply and no log entry carries the password"), ![status, off, saved, list, again, old, urlOnly, list2, urlAgain].some((r) => JSON.stringify(r).includes(PASSWORD)) && !log.includes(PASSWORD) && log.includes("new@pb-e2e.invalid") && log.includes('"url":"https://urlsave.pb-e2e.example"') && !log.includes("next=/x"), log);
    await page2.close();
    await page.close();
    await home.close();
  }
});
