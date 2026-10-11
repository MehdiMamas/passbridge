// renders src/ui/preview.jsx (popup screens, light and dark) from a preview build it makes and serves itself
// OP_PREVIEW=<url> uses an already-served preview page instead
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildExtension } from "../../scripts/build.mjs";
import { SHOTS, chromium, main, ok, serveStatic } from "./lib.mjs";

await main(async () => {
  let pageUrl = process.env.OP_PREVIEW;
  let server = null;
  let out = null;
  try {
    if (!pageUrl) {
      out = await mkdtemp(join(tmpdir(), "pb-preview-"));
      await buildExtension({ out, preview: true, quiet: true });
      server = await serveStatic(out);
      pageUrl = `${server.url}/src/preview.html`;
    }
    const browser = await chromium.launch({ headless: true });
    try {
      await mkdir(SHOTS, { recursive: true });
      const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
      await page.goto(pageUrl, { waitUntil: "networkidle" });
      await page.screenshot({ path: join(SHOTS, "ui-preview.png"), fullPage: true });
      const count = await page.locator("[data-screen]").count();
      ok("preview renders 8 screens (4 states x light/dark)", count === 8, `got ${count}`);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    if (out) await rm(out, { recursive: true, force: true });
  }
});
