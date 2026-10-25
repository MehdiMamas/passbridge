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
      ok("preview renders 12 screens (6 states x light/dark)", count === 12, `got ${count}`);
      const notice = page.locator('[data-screen="update_available"][data-scheme="light"] [data-passbridge="update"]');
      const noticeText = (await notice.innerText()).replace(/\s+/g, " ").trim();
      ok("update: the notice names the new version and links its release", noticeText.includes("PassBridge 1.4.0 is available!") && noticeText.includes("View release"), noticeText);
      ok("update: the notice can be dismissed", (await notice.locator('button[aria-label="Dismiss update notice"]').count()) === 1, "no dismiss button");
      const quiet = await page.locator('[data-screen="unlocked"] [data-passbridge="update"]').count();
      ok("update: no notice without an update", quiet === 0, `notices=${quiet}`);
      const frame = page.locator('[data-screen="grouped_codes"][data-scheme="light"]');
      const rows = (await frame.locator("li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      ok("grouped: 8 rows, one li per code", rows.length === 8, `rows=${rows.length}`);
      ok("grouped: same-domain code says Verification code, no strip", rows[1]?.includes("Verification code") && !rows[1].includes("↳") && !rows[1].includes("cloudflare.com"), rows[1]);
      ok("grouped: foreign domain moves to a thin strip", rows[2]?.includes("Verification code") && rows[2].includes("↳ api.cloudflare.com") && !rows[2].includes("Code for"), rows[2]);
      ok("grouped: username match is case-insensitive", rows[3]?.includes("Bob@CF.com") && rows[4]?.includes("↳ Instagram"), `${rows[3]} | ${rows[4]}`);
      ok("grouped: bottom row with the site's domain stays bare", rows[5]?.includes("carol@elsewhere.com") && !rows[5].includes("↳"), rows[5]);
      ok("grouped: bottom row with a foreign domain gets the strip", rows[6]?.includes("dave@elsewhere.com") && rows[6].includes("↳ instagram.example") && !rows[6].includes("Code for"), rows[6]);
      ok("grouped: Messages keeps its own row", rows[7]?.includes("Verification code from Messages"), rows[7]);
      const italicCount = await frame.locator("li .italic").count();
      ok("grouped: the Messages app name is set off in italics", italicCount === 1, `italic spans=${italicCount}`);
      const stripCount = await frame.locator('[data-passbridge="code-domain"]').count();
      ok("grouped: exactly three domain footers", stripCount === 3, `footers=${stripCount}`);
      const copyCount = await frame.locator('button[aria-label="Copy verification code"]').count();
      ok("grouped: every code row keeps its copy button", copyCount === 6, `copy buttons=${copyCount}`);
      const pwIcon = await frame.locator('button[aria-label="Copy password"] svg').first().innerHTML();
      const codeIcon = await frame.locator('button[aria-label="Copy verification code"] svg').first().innerHTML();
      ok("grouped: code copy icon is a lock, not the password icon", pwIcon !== codeIcon && codeIcon.includes("<rect"), "wrong icon on the code rows");
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    if (out) await rm(out, { recursive: true, force: true });
  }
});
