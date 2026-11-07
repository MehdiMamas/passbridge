// records docs/demo.gif: a login filled from the simulated helper on a test page (no real account or data).
// Run under a virtual display like the other e2e drivers: xvfb-run -a node test-harness/automation/record-demo.ts
// Needs ffmpeg on PATH.

import { execFileSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HERE, clickMenu, main, ok, serveStatic } from "./lib.ts";
import { pairFromMenu, startE2E } from "./e2e-lib.ts";

const OUT = join(HERE, "..", "..", "docs", "demo.gif");

await main(async () => {
  const server = await serveStatic(join(HERE, ".."));
  const tmp = await mkdtemp(join(tmpdir(), "pb-demo-"));
  try {
    const { ctx, helper } = await startE2E("mac");
    const url = `${server.url}/login-standard.html`;

    // pair first, off camera
    const setup = await ctx.newPage();
    await setup.goto(url, { waitUntil: "domcontentloaded" });
    await setup.waitForTimeout(300);
    ok("paired", await pairFromMenu(setup, helper));
    await setup.close();

    // the take: open the form, open the menu, pick the login
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 900, height: 520 });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: ".scenario-banner{display:none!important}.wrap{margin-top:24px!important}" });
    const video = join(tmp, "take.webm");
    await page.screencast.start({ path: video, size: { width: 900, height: 520 } });
    await page.waitForTimeout(900);
    await page.focus('input[name="username"]');
    await page.waitForTimeout(1600);
    ok("picked the saved login", await clickMenu(page, "mia@pb-e2e.invalid"));
    await page.waitForTimeout(1800);
    ok("password filled", (await page.inputValue('input[name="password"]')) !== "");
    await page.screencast.stop();

    const palette = join(tmp, "palette.png");
    const scale = "fps=10,scale=720:-1:flags=lanczos";
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", `${scale},palettegen=max_colors=96`, palette]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, OUT]);
  } finally {
    await server.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
