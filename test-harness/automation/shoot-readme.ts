// retakes the README screenshots in docs/images from the real extension and the simulated helper (no real account or data):
// popup-light, popup-dark, inline-menu, save-bar. Run under a virtual display like the e2e drivers:
//   xvfb-run -a node test-harness/automation/shoot-readme.ts      (OUT=<folder> writes somewhere else)
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildExtension } from "../../scripts/build.ts";
import { HERE, chromium, main, ok, serveStatic } from "./lib.ts";
import { pairFromMenu, startE2E } from "./e2e-lib.ts";
import { seedVault } from "../fake-apple-helper/helper.ts";

const OUT = process.env.OUT || join(HERE, "..", "..", "docs", "images");
const SITE = "https://northwind.dev/";
const PAGE = `<!doctype html><html lang="en"><title>Northwind</title><style>
body{margin:0;padding:150px 48px 48px;background:#e6e4e1;font:16px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917}
.card{width:420px;margin:0 auto;background:#fff;border-radius:22px;padding:28px 28px 30px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
.brand{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:700}
.logo{width:44px;height:44px;border-radius:12px;background:#0a84ff;color:#fff;display:grid;place-items:center;font-size:22px}
.sub{color:#57534e;margin:18px 0 130px}label{display:block;font-weight:600;margin:18px 0 8px}
input{box-sizing:border-box;width:100%;padding:13px 14px;font-size:17px;border:1px solid #d6d3d1;border-radius:10px;background:#fff}
input:focus{outline:none;border-color:#0a84ff;box-shadow:0 0 0 4px rgba(10,132,255,.18)}
button{width:100%;margin-top:26px;padding:14px;font-size:18px;font-weight:700;color:#fff;background:#1c1917;border:0;border-radius:12px}
</style><div class="card"><div class="brand"><div class="logo">N</div>Northwind</div>
<p class="sub">Sign in with a saved account.</p>
<form action="javascript:void(0)" method="post"><label for="u">Email</label><input id="u" name="username" type="text" autocomplete="username" placeholder="Email">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" placeholder="Password"><button type="submit">Continue</button></form></div>`;

await main(async () => {
  await mkdir(OUT, { recursive: true });
  const vault = seedVault();
  vault.logins = ["ada", "grace", "radia"].map((n) => ({ username: `${n}@northwind.dev`, password: `${n}-Pass-1`, sites: ["northwind.dev"] }));
  vault.otps = [{ source: "totp", username: "ada@northwind.dev", domain: "northwind.dev", code: "246810" }];
  const { ctx, helper } = await startE2E("mac", { vault });
  await ctx.route(SITE + "**", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await ctx.route("https://icons.duckduckgo.com/**", (route) => route.abort());

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 560, height: 740 });
  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  ok("paired", await pairFromMenu(page, helper, "#u"));

  // inline menu: the field focused with its list open
  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.focus("#u");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, "inline-menu.png"), clip: { x: 0, y: 0, width: 560, height: 740 } });

  // save bar: a login the vault does not hold yet
  const savePage = await ctx.newPage();
  await savePage.setViewportSize({ width: 900, height: 600 });
  await savePage.goto(SITE, { waitUntil: "domcontentloaded" });
  await savePage.waitForTimeout(400);
  await savePage.fill("#u", "kai@northwind.dev");
  await savePage.fill("#p", "a-new-Pass-77");
  await savePage.click("button[type=submit]");
  let bar = null;
  for (let i = 0; i < 40 && !bar; i++) {
    bar = savePage.frames().find((f) => f.url().includes("overlay/save-bar.html") && f.url()) ?? null;
    if (bar && !(await bar.locator("[data-action=save]:not([disabled])").count())) bar = null;
    if (!bar) await savePage.waitForTimeout(150);
  }
  ok("save bar appears", !!bar);
  if (bar) {
    await savePage.waitForTimeout(500);
    const box = (await bar.locator("#root > *").first().boundingBox())!;
    await savePage.screenshot({ path: join(OUT, "save-bar.png"), clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  }

  // popup: the "readme" frame of the preview build (the real popup screen with demo data; the popup itself only runs in the toolbar)
  const outDir = await mkdtemp(join(tmpdir(), "pb-preview-"));
  const server = await (async () => {
    await buildExtension({ out: outDir, preview: true, quiet: true });
    return serveStatic(outDir);
  })();
  try {
    const browser = await chromium.launch({ headless: true, locale: "en-US" });
    for (const scheme of ["light", "dark"] as const) {
      const pg = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 2 });
      await pg.goto(`${server.url}/src/preview.html`, { waitUntil: "networkidle" });
      await pg.locator(`[data-screen="readme"][data-scheme="${scheme}"] [data-passbridge="popup"]`).screenshot({ path: join(OUT, `popup-${scheme}.png`) });
      await pg.close();
    }
    await browser.close();
  } finally {
    await server.close();
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
});
