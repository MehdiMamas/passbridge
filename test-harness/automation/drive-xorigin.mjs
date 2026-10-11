// a foreign sub-frame must never get an offer (confused deputy via all_frames)
// openpw.test resolves to 127.0.0.1 through the launch flags in lib.mjs
import { BASE, build, launchExtension, main, ok } from "./lib.mjs";

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
});
