// e2e: agent verification codes. The real extension, the real relay (native/passbridge-agent.py) and a fake code reader
// (test-harness/fake-code-reader.py) that speaks the reader's socket protocol, so no Apple prompt is touched.
// idmsa.apple.com is served by the browser's route, with a 6-box code field.

import { execFile } from "child_process";
import { existsSync, rmSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { BASE, main, ok } from "./lib.ts";
import { AGENT_CLI, startE2E } from "./e2e-lib.ts";

const CODE = "482915";
const SITE = "https://idmsa.apple.com/";
const boxes = [1, 2, 3, 4, 5, 6].map((i) => `<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" ${i === 1 ? 'autocomplete="one-time-code"' : ""} aria-label="Digit ${i}" name="code${i}">`).join("");
const CODE_PAGE = `<!doctype html><title>Verify</title><div>${boxes}</div>`;
const PLAIN_PAGE = "<!doctype html><title>Welcome</title><p>No code field here.</p>";

const cli = (appDir: string, ...args: string[]) =>
  new Promise<any>((resolve) => {
    execFile("python3", ["-I", AGENT_CLI, ...args], { env: { ...process.env, PASSBRIDGE_APPDIR: appDir, PASSBRIDGE_NO_WSL_REEXEC: "1" }, timeout: 110000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: `unreadable: ${stdout} ${err?.message ?? ""}` });
      }
    });
  });

const scenario = async (appDir: string, name: string) => {
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "fake-reader-scenario"), name);
  for (const f of ["fake-reader-argv", "fake-reader-connected", "fake-reader-exited"]) await rm(join(appDir, f), { force: true });
};

const route = async (ctx: import("playwright").BrowserContext) => {
  await ctx.route(SITE + "**", (r) => r.fulfill({ contentType: "text/html", body: r.request().url().includes("plain") ? PLAIN_PAGE : CODE_PAGE }));
  // a second Apple host with the same code page, for the tab that moves while the reader runs
  await ctx.route("https://appleid.apple.com/**", (r) => r.fulfill({ contentType: "text/html", body: CODE_PAGE }));
};

async function setup(platform: "mac" | "win", opts: { relay?: "real" | "old" } = {}) {
  const e2e = await startE2E(platform, { agent: true, codeReader: true, relay: opts.relay });
  await route(e2e.ctx);
  const sw = e2e.ctx.serviceWorkers()[0] || (await e2e.ctx.waitForEvent("serviceworker", { timeout: 10000 }));
  const home = await e2e.ctx.newPage();
  await home.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await sw.evaluate(() => chrome.storage.sync.set({ agentSignIn: true, agentAllowlist: ["apple.com"] }));
  await sw.evaluate(() => chrome.storage.local.set({ agentCodeReader: true }));
  await sw.evaluate(() => {
    (globalThis as any).__notes = [];
    (chrome.notifications as any).create = (o: any) => (globalThis as any).__notes.push(String(o.message));
  });
  const sock = join(e2e.appDir, "agent.sock");
  for (let i = 0; i < 60 && !existsSync(sock); i++) await home.waitForTimeout(250);
  const open = async (path: string) => {
    const page = await e2e.ctx.newPage();
    await page.goto(SITE + path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const tabId = String(await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u)?.id, SITE + path));
    return { page, tabId };
  };
  return { ...e2e, sw, home, open };
}

await main(async () => {
  {
    const t = (n: string) => `mac: ${n}`;
    const { sw, appDir, open, home } = await setup("mac");
    const field = await open("code");
    await home.waitForTimeout(1500); // the relay's "active" event carries code: true

    await scenario(appDir, "ok");
    const res = await cli(appDir, "verify-code", field.tabId, "apple.com");
    const filled = [];
    for (let i = 1; i <= 6; i++) filled.push(await field.page.inputValue(`input[name="code${i}"]`));
    ok(t("happy path fills the code"), filled.join("") === CODE, filled.join(","));
    ok(t("the reply has no digits"), res.ok === true && res.domain === "idmsa.apple.com" && res.filled === true && Object.keys(res).sort().join() === "domain,filled,id,ok" && !/\d{3}/.test(JSON.stringify({ ...res, id: "" })), JSON.stringify(res));
    const log = (await sw.evaluate(async () => (await chrome.storage.session.get("agentLog")).agentLog ?? [])) as any[];
    const row = log.filter((e) => e.op === "verify_code").pop();
    ok(t("Activity row ok, host named, no digits"), row?.result === "ok" && row.host === "idmsa.apple.com" && row.username === "" && !/\d{4}/.test(JSON.stringify({ ...row, t: 0 })), JSON.stringify(row));
    const notes = (await sw.evaluate(() => (globalThis as any).__notes)) as string[];
    ok(t("one notification naming the host, never the code"), notes.length === 1 && notes[0].includes("idmsa.apple.com") && !notes[0].includes(CODE), JSON.stringify(notes));

    await scenario(appDir, "ok");
    const plain = await open("plain");
    const none = await cli(appDir, "verify-code", plain.tabId, "apple.com");
    ok(t("no field page -> no_field"), none.ok === false && none.error === "no_field", JSON.stringify(none));
    ok(t("fake reader not started"), !existsSync(join(appDir, "fake-reader-argv")));
    await plain.page.close();

    // switch off while the reader waits: the reply and the reader's exit are both under a second
    await scenario(appDir, "hang");
    const pending = cli(appDir, "verify-code", field.tabId, "apple.com");
    for (let i = 0; i < 100 && !existsSync(join(appDir, "fake-reader-connected")); i++) await home.waitForTimeout(100);
    const t0 = Date.now();
    await sw.evaluate(() => chrome.storage.local.set({ agentCodeReader: false }));
    const cut = await pending;
    const replyMs = Date.now() - t0;
    ok(t("switch off mid-read -> code_reader_off under 1 s"), cut.error === "not_allowed" && cut.reason === "code_reader_off" && replyMs < 1000, `${JSON.stringify(cut)} ${replyMs} ms`);
    for (let i = 0; i < 20 && !existsSync(join(appDir, "fake-reader-exited")); i++) await home.waitForTimeout(100);
    ok(t("the fake reader exited under 1 s"), existsSync(join(appDir, "fake-reader-exited")) && Date.now() - t0 < 1500, String(Date.now() - t0));
    const off = await cli(appDir, "verify-code", field.tabId, "apple.com");
    ok(t("with the switch off a request is refused, reader not started"), off.reason === "code_reader_off", JSON.stringify(off));

    await sw.evaluate(() => chrome.storage.local.set({ agentCodeReader: true }));
    const where = (await sw.evaluate(async () => ({ local: (await chrome.storage.local.get("agentCodeReader")).agentCodeReader, sync: Object.keys(await chrome.storage.sync.get(null)) }))) as any;
    ok(t("switch value lives in local storage, sync storage has no agentCodeReader"), where.local === true && !where.sync.includes("agentCodeReader"), JSON.stringify(where));
    await field.page.close();
  }
  {
    // the page changes after the probe and before the fill (late_connect keeps the reader busy for about 2 s); 3 reads, the most the limiter allows
    const t = (n: string) => `mac: ${n}`;
    const { sw, appDir, open, home } = await setup("mac");
    const boxesOf = (page: import("playwright").Page) => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input[name^="code"]')].map((i) => i.value).join(""));
    await sw.evaluate(() => ((globalThis as any).__notes.length = 0));

    // the tab moves to another host: expectedHost no longer matches, nothing is filled, fill_failed and a "no field" notification for the first host
    const moved = await open("code");
    await home.waitForTimeout(1500);
    await scenario(appDir, "late_connect");
    const movedReply = cli(appDir, "verify-code", moved.tabId, "apple.com");
    await home.waitForTimeout(500);
    await moved.page.goto("https://appleid.apple.com/", { waitUntil: "domcontentloaded" });
    const m = await movedReply;
    ok(t("tab moved to another host mid-read -> fill_failed"), m.ok === false && m.error === "fill_failed", JSON.stringify(m));
    ok(t("tab moved: nothing filled on the new host"), (await boxesOf(moved.page)) === "", await boxesOf(moved.page));
    const movedNotes = (await sw.evaluate(() => (globalThis as any).__notes)) as string[];
    ok(t("tab moved: the notification says no field for the first host, no digits"), movedNotes.length === 1 && movedNotes[0].includes("idmsa.apple.com") && movedNotes[0].includes("no field") && !movedNotes[0].includes(CODE), JSON.stringify(movedNotes));
    await moved.page.close();

    // the probed field is removed and a different field appears: nothing is filled, the new field stays empty
    const swapped = await open("code");
    await scenario(appDir, "late_connect");
    const swappedReply = cli(appDir, "verify-code", swapped.tabId, "apple.com");
    await home.waitForTimeout(700);
    await swapped.page.evaluate(() => {
      document.querySelector("div")!.innerHTML = '<input type="text" autocomplete="one-time-code" name="other" aria-label="Code">';
    });
    const sw1 = await swappedReply;
    ok(t("probed field removed, another added -> fill_failed"), sw1.ok === false && sw1.error === "fill_failed", JSON.stringify(sw1));
    ok(t("the added field stays empty"), (await swapped.page.inputValue('input[name="other"]')) === "");
    await swapped.page.close();

    // another code field appears in front of the probed boxes: only the probed boxes or nothing are filled, the new field stays empty
    const added = await open("code");
    await scenario(appDir, "late_connect");
    const addedReply = cli(appDir, "verify-code", added.tabId, "apple.com");
    await home.waitForTimeout(700);
    await added.page.evaluate(() => {
      const extra = document.createElement("input");
      extra.type = "text";
      extra.name = "extra";
      extra.autocomplete = "one-time-code";
      extra.setAttribute("aria-label", "Verification code");
      document.body.prepend(extra);
    });
    const ad = await addedReply;
    const boxes6 = await boxesOf(added.page);
    ok(t("another field added after the probe: the new field stays empty"), (await added.page.inputValue('input[name="extra"]')) === "");
    ok(t("another field added after the probe: only the probed boxes or nothing are filled"), (ad.ok === true && boxes6 === CODE) || (ad.error === "fill_failed" && boxes6 === ""), `${JSON.stringify(ad)} boxes=${boxes6}`);
    await added.page.close();
  }
  {
    // your own sign-ins: agent sign-in off, no allowlist, the same switch and reader
    for (const platform of ["mac", "win"] as const) {
      const t = (n: string) => `${platform} own sign-in: ${n}`;
      const { sw, appDir, open, home, ctx } = await setup(platform);
      await sw.evaluate(() => chrome.storage.sync.set({ agentSignIn: false, agentAllowlist: [] }));
      await home.waitForTimeout(1500);
      const boxesOf = async (page: import("playwright").Page) => {
        const v = [];
        for (let i = 1; i <= 6; i++) v.push(await page.inputValue(`input[name="code${i}"]`));
        return v.join("");
      };
      const started = () => existsSync(join(appDir, "fake-reader-argv"));
      await scenario(appDir, "ok");
      const mine = await open("code");
      await mine.page.focus('input[name="code1"]');
      for (let i = 0; i < 60 && (await boxesOf(mine.page)) !== CODE; i++) await home.waitForTimeout(200);
      ok(t("focus fills the 6 boxes with agent sign-in off"), (await boxesOf(mine.page)) === CODE, await boxesOf(mine.page));
      const notes = (await sw.evaluate(() => (globalThis as any).__notes)) as string[];
      ok(t("one notification naming the host, never the code"), notes.length === 1 && notes[0].includes("idmsa.apple.com") && !notes[0].includes(CODE), JSON.stringify(notes));
      const log = (await sw.evaluate(async () => (await chrome.storage.session.get("agentLog")).agentLog ?? [])) as any[];
      ok(t("no Activity row for your own read"), log.length === 0, JSON.stringify(log));
      const stored = JSON.stringify(await sw.evaluate(async () => ({ l: await chrome.storage.local.get(null), s: await chrome.storage.session.get(null), y: await chrome.storage.sync.get(null) })));
      ok(t("the code is in no storage area"), !stored.includes(CODE));

      // a field that already has a digit asks for nothing
      await scenario(appDir, "ok");
      rmSync(join(appDir, "fake-reader-argv"), { force: true });
      await sw.evaluate(() => ((globalThis as any).__notes.length = 0));
      const filledAlready = await open("code");
      await filledAlready.page.evaluate(() => {
        (document.querySelector('input[name="code1"]') as HTMLInputElement).value = "7";
      });
      await filledAlready.page.focus('input[name="code1"]');
      await home.waitForTimeout(1500);
      ok(t("given the field already has digits -> the reader is not started"), !started());
      await filledAlready.page.close();

      // not an Apple sign-in host
      await scenario(appDir, "ok");
      rmSync(join(appDir, "fake-reader-argv"), { force: true });
      await ctx.route("https://sign-in.example.test/**", (r) => r.fulfill({ contentType: "text/html", body: CODE_PAGE }));
      const other = await ctx.newPage();
      await other.goto("https://sign-in.example.test/", { waitUntil: "domcontentloaded" });
      await other.focus('input[name="code1"]');
      await home.waitForTimeout(1500);
      ok(t("given a host that is not an Apple sign-in host -> the reader is not started"), !started() && (await boxesOf(other)) === "");
      await other.close();

      // no prompt: silent
      await scenario(appDir, "no_prompt");
      rmSync(join(appDir, "fake-reader-argv"), { force: true });
      await sw.evaluate(() => ((globalThis as any).__notes.length = 0));
      const quiet = await open("code");
      await quiet.page.focus('input[name="code1"]');
      for (let i = 0; i < 40 && !started(); i++) await home.waitForTimeout(100);
      await home.waitForTimeout(1000);
      const notes2 = (await sw.evaluate(() => (globalThis as any).__notes)) as string[];
      ok(t("given no Apple prompt -> nothing filled and no new notification"), (await boxesOf(quiet.page)) === "" && notes2.length === 0, `${await boxesOf(quiet.page)} ${notes2.length}`);
      await quiet.page.close();

      // switch off: nothing
      await sw.evaluate(() => chrome.storage.local.set({ agentCodeReader: false }));
      await scenario(appDir, "ok");
      rmSync(join(appDir, "fake-reader-argv"), { force: true });
      const off = await open("code");
      await off.page.focus('input[name="code1"]');
      await home.waitForTimeout(1500);
      ok(t("given the switch is off -> the reader is not started and nothing is filled"), !started() && (await boxesOf(off.page)) === "");
      await off.page.close();
      await mine.page.close();
    }
  }
  {
    const t = (n: string) => `mac: ${n}`;
    const { appDir, open, home } = await setup("mac", { relay: "old" });
    const field = await open("code");
    await home.waitForTimeout(1500);
    const t0 = Date.now();
    const res = await cli(appDir, "verify-code", field.tabId, "apple.com");
    ok(t("old relay -> reader_missing in under 1 s"), res.error === "reader_missing" && Date.now() - t0 < 1000, `${JSON.stringify(res)} ${Date.now() - t0} ms`);
  }
  {
    const t = (n: string) => `win: ${n}`;
    const { appDir, open, home } = await setup("win");
    const field = await open("code");
    await home.waitForTimeout(1500);
    await scenario(appDir, "ok");
    const res = await cli(appDir, "verify-code", field.tabId, "apple.com");
    const filled = [];
    for (let i = 1; i <= 6; i++) filled.push(await field.page.inputValue(`input[name="code${i}"]`));
    ok(t("the platform is allowed: the code fills and the reply has no digits"), filled.join("") === CODE && res.ok === true && !/\d{3}/.test(JSON.stringify({ ...res, id: "" })), `${filled.join(",")} ${JSON.stringify(res)}`);
  }
});
