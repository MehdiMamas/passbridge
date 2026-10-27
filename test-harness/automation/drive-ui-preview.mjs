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
      ok("update: the notice names the new version and links its release", noticeText.startsWith("v1.4.0 is available!") && noticeText.includes("View release"), noticeText);
      ok("update: the notice offers Update now even without the helper", noticeText.includes("Update now"), noticeText);
      ok("update: the notice can be dismissed", (await notice.locator('button[aria-label="Dismiss update notice"]').count()) === 1, "no dismiss button");
      const updatePage = (title) => page.locator(`[data-update-screen="${title}"][data-scheme="light"]`);
      const first = (await updatePage("ready_first").innerText()).replace(/\s+/g, " ");
      ok("update page: shows the installed and the new version with the release link", first.includes("1.4.1") && first.includes("1.4.2") && (await updatePage("ready_first").locator('a[href$="/releases/tag/v1.4.2"]').count()) === 1, first);
      ok("update page: the first update explains the folder choice", first.includes("Not chosen yet") && first.includes("chrome://extensions") && !first.includes("Change folder"), first);
      ok("update page: a known folder can be changed", (await updatePage("ready").locator("button", { hasText: "Change folder" }).count()) === 1);
      const bar = updatePage("working").locator('[role="progressbar"]');
      ok("update page: the progress bar reports its value", (await bar.getAttribute("aria-valuenow")) === "72");
      const states = await updatePage("working").locator("[data-step]").evaluateAll((els) => els.map((e) => `${e.dataset.step}:${e.dataset.state}`).join());
      ok("update page: the steps before the current one are done", states === "download:done,verify:done,write:active,restart:todo", states);
      ok("update page: no folder change while files are being replaced", (await updatePage("working").locator("button", { hasText: "Change folder" }).count()) === 0);
      const failedText = await updatePage("failed").innerText();
      ok("update page: a failed write says the old version is back", failedText.includes("Couldn't write the new files.") && failedText.includes("previous version was restored"), failedText);
      const unsignedText = await updatePage("unsigned").innerText();
      ok("update page: an unsigned release only offers the release page", unsignedText.includes("isn't signed") && !unsignedText.includes("Update now") && (await updatePage("unsigned").locator('a[href$="/v1.4.2"]').count()) === 2, unsignedText);
      const staleText = (await updatePage("stale").innerText()).replace(/\s+/g, " ");
      ok("update page: a restart that did not land on the new version says so", staleText.includes("Something went wrong") && staleText.includes("still 1.4.1, not 1.4.2") && staleText.includes("Try again"), staleText);
      ok("update page: an unfinished update offers the restore", (await updatePage("interrupted").locator("button", { hasText: "Restore previous version" }).count()) === 1);
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
