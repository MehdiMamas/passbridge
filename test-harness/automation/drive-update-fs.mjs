// runs test-harness/update-fs.html: the folder-update engine on Chrome's own File System Access code (OPFS).
// serves the repo root so the page imports src/ as is; a zip made with `zip -r`, like release.yml, is passed in when zip exists
import { execFileSync } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HERE, chromium, main, ok, serveStatic } from "./lib.mjs";

async function releaseStyleZip(dir) {
  const pkg = join(dir, "pkg");
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(join(pkg, "manifest.json"), '{"version":"1.4.2"}');
  await writeFile(join(pkg, "src", "a.js"), "A2".repeat(300));
  try {
    execFileSync("zip", ["-qr", join(dir, "pkg.zip"), "."], { cwd: pkg });
  } catch {
    return null;
  }
  return [...(await readFile(join(dir, "pkg.zip")))];
}

await main(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pb-update-fs-"));
  const server = await serveStatic(join(HERE, "..", ".."));
  const browser = await chromium.launch({ headless: true });
  try {
    const zip = await releaseStyleZip(tmp);
    if (!zip) console.log("SKIP zip check (no zip command)");
    const page = await browser.newPage();
    await page.goto(`${server.url}/test-harness/update-fs.html`);
    await page.waitForFunction(() => typeof window.runUpdateFsChecks === "function");
    for (const [name, passed, detail] of await page.evaluate((bytes) => window.runUpdateFsChecks(bytes), zip)) {
      ok(`update fs: ${name}`, passed, detail);
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
