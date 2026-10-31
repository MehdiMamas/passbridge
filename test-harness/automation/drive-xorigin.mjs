// a foreign sub-frame must never get an offer (confused deputy via all_frames)
// openpw.test resolves to 127.0.0.1 through the launch flags in lib.mjs
import { join } from "path";
import { BASE, HERE, build, launchExtension, main, ok, serveStatic } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  const foreign = new URL("/iframe-pages/iframe-login.html", BASE);
  foreign.hostname = "openpw.test";
  await page.evaluate((src) => {
    const f = document.createElement("iframe");
    f.id = "xf";
    f.style = "width:600px;height:300px";
    f.src = src;
    document.body.appendChild(f);
  }, foreign.href);
  await page.waitForTimeout(1200);
  const xframe = page.frames().find((f) => f.url().includes("openpw.test") && f.url().includes("iframe-login"));
  const field = xframe?.locator('input[name="username"], input[autocomplete="username"], input[type="text"]').first();
  if (!ok("cross-origin frame loaded", xframe && (await field.count()) > 0, "frame did not load, so nothing was tested")) return;
  await field.focus().catch(() => {});
  await page.waitForTimeout(700);
  const dd = await xframe.locator('[data-passbridge="suggestions"]').count();
  ok("cross-origin iframe shows NO offer (leak closed)", dd === 0, `got an offer (${dd})`);

  // every-site agent fill: a frame on the same host but another port is another origin, so it stays empty
  const other = await serveStatic(join(HERE, ".."));
  const top = await ctx.newPage();
  await top.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await top.evaluate((src) => {
    const f = document.createElement("iframe");
    f.style = "width:600px;height:300px";
    f.src = src;
    document.body.appendChild(f);
  }, `${other.url}/iframe-pages/iframe-login.html`);
  await top.waitForTimeout(1200);
  const sameHost = top.frames().find((f) => f.url().startsWith(other.url));
  const user = sameHost?.locator('input[name="username"]');
  if (!ok("same-host other-port frame loaded", sameHost && (await user.count()) > 0, "frame did not load, so nothing was tested")) return;
  await user.focus();
  await top.waitForTimeout(500);
  const sw = ctx.serviceWorkers()[0];
  const send = (extra) =>
    sw.evaluate(
      async ({ url, extra }) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url));
        const host = new URL(tab.url).hostname;
        return chrome.tabs.sendMessage(tab.id, { type: "fill", username: "agent@example.com", password: "pw-xorigin", expectedHost: host, ...extra }).catch(() => null);
      },
      { url: `${BASE}/index.html`, extra },
    );
  await send({ expectedOrigin: new URL(BASE).origin });
  await top.waitForTimeout(500);
  ok("expectedOrigin: a same-host other-port frame stays empty", (await user.inputValue()) === "", await user.inputValue());
  await send({});
  await top.waitForTimeout(500);
  ok("no expectedOrigin: the same frame fills (the test can see a fill)", (await user.inputValue()) === "agent@example.com", await user.inputValue());
  await other.close();
});
