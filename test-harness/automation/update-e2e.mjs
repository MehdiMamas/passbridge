// end-to-end check of the folder update in a real Chrome. Playwright cannot drive the folder picker or Chrome's
// permission prompts, so a person does the clicks this script asks for. It builds the versions, signs them with a
// throwaway key, serves them as a fake GitHub release, starts Chrome on a fresh profile and checks the folder
// after every round. Needs `zip` (the way release.yml packs) and Chrome:
//   node test-harness/automation/update-e2e.mjs            CHROME=<Chrome binary> off macOS
import { execFileSync, spawn } from "child_process";
import { createHash, generateKeyPairSync, sign } from "crypto";
import { existsSync } from "fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { createServer } from "http";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline/promises";
import { buildExtension } from "../../scripts/build.mjs";
import { HERE, main, ok } from "./lib.mjs";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = join(HERE, ".builds", "update-e2e");
const manifest = JSON.parse(await readFile(join(HERE, "..", "..", "manifest.json"), "utf8"));
const v = (n) => `${manifest.version}.${n}`;

// the manifest key pins the id: the first 32 hex digits of its SHA-256, written with a-p
const EXT_ID = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");
const UPDATE_PAGE = `chrome-extension://${EXT_ID}/src/update.html`;

async function tree(dir, prefix = "") {
  const out = new Map();
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === ".DS_Store") continue;
    const rel = `${prefix}${ent.name}`;
    if (ent.isDirectory()) for (const [k, h] of await tree(join(dir, ent.name), `${rel}/`)) out.set(k, h);
    else out.set(rel, createHash("sha256").update(await readFile(join(dir, ent.name))).digest("hex"));
  }
  return out;
}

async function differences(dir, expectedDir) {
  const [a, b] = await Promise.all([tree(dir), tree(expectedDir)]);
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
}

await main(async () => {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}; set CHROME to the binary`);
  execFileSync("zip", ["-v"], { stdio: "ignore" });
  const work = await mkdtemp(join(tmpdir(), "pb-update-e2e-"));
  const profile = join(work, "profile");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let latest = null;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const headers = { "cache-control": "no-store" };
    if (path === "/releases/latest") return latest ? res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify(latest)) : res.writeHead(404).end();
    const file = /^\/dl\/(\d+)\/(passbridge\.zip(?:\.sig)?)$/.exec(path);
    const body = file && (await readFile(join(work, "dl", file[1], file[2])).catch(() => null));
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, headers).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const releaseSource = { latestUrl: `${origin}/releases/latest`, publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chromes = [];
  const startChrome = (url) => {
    const p = spawn(CHROME, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url], { detached: true, stdio: "ignore" });
    p.unref();
    chromes.push(p);
  };
  const step = async (title, lines) => {
    console.log(`\n=== ${title} ===\n${lines.map((l) => `  - ${l}`).join("\n")}`);
    await rl.question("  Press Enter when done. ");
  };
  const asked = async (name, question) => ok(name, (await rl.question(`  ${question} [y/n] `)).trim().toLowerCase().startsWith("y"));

  const build = async (n) => {
    const out = join(work, "builds", String(n));
    await buildExtension({ out, mockKind: "unlocked", quiet: true, releaseSource, version: v(n) });
    return out;
  };
  // zip -r like release.yml; signature "bad" flips a bit, "none" leaves the .sig off the release
  const publish = async (n, dir, signature = "good") => {
    const zipPath = join(work, "dl", String(n), "passbridge.zip");
    await mkdir(dirname(zipPath), { recursive: true });
    execFileSync("zip", ["-qr", zipPath, "."], { cwd: dir });
    const zip = await readFile(zipPath);
    const asset = (name, extra) => ({ name, browser_download_url: `${origin}/dl/${n}/${name}`, ...extra });
    const assets = [asset("passbridge.zip", { size: zip.length, digest: `sha256:${createHash("sha256").update(zip).digest("hex")}` })];
    if (signature !== "none") {
      const sig = sign(null, zip, privateKey);
      if (signature === "bad") sig[0] ^= 1;
      await writeFile(`${zipPath}.sig`, sig);
      assets.push(asset("passbridge.zip.sig", { size: sig.length }));
    }
    latest = { tag_name: `v${v(n)}`, html_url: `https://github.com/MehdiMamas/passbridge/releases/tag/v${v(n)}`, assets };
  };
  const folderIs = async (name, dir) => {
    const diff = await differences(EXT, dir);
    ok(name, diff.length === 0, diff.slice(0, 5).join(", "));
  };

  try {
    console.log("Building the installed version and five updates…");
    await buildExtension({ out: EXT, mockKind: "unlocked", quiet: true, releaseSource, version: v(0) });
    ok("the test build reads releases from the local server", (await readFile(join(EXT, "src", "update.js"), "utf8")).includes(releaseSource.latestUrl));
    const builds = {};
    for (const n of [1, 2, 3, 4, 5]) builds[n] = await build(n);
    // round 2 drops a file and a folder and adds one
    await rm(join(builds[2], "NOTICE"));
    await rm(join(builds[2], "licenses"), { recursive: true });
    await cp(join(builds[2], "icons", "icon16.png"), join(builds[2], "icons", "added-in-round-2.png"));

    startChrome("chrome://extensions");
    await publish(1, builds[1]);
    await step(`Round 1: first update, ${v(0)} → ${v(1)}`, [
      "In the new Chrome window turn on Developer mode, choose Load unpacked and pick:",
      `  ${EXT}`,
      `Open ${UPDATE_PAGE}`,
      "Press Update now, pick the same folder (Cmd+Shift+G pastes a path) and press Allow",
      `Wait for "PassBridge is now ${v(1)}"`,
    ]);
    await folderIs("round 1: the folder holds the new release", builds[1]);
    await asked("round 1: the page said the new version is running", `Did the page say "PassBridge is now ${v(1)}"?`);

    await publish(2, builds[2]);
    await step(`Round 2: permission again, files dropped and added, ${v(1)} → ${v(2)}`, [
      "Reload the update page (Cmd+R) and press Update now",
      "The folder picker opens at the PassBridge folder: press Select",
      "Chrome offers Allow on every visit: choose it",
    ]);
    await folderIs("round 2: the dropped file and folder are gone and the new file is there", builds[2]);
    await asked("round 2: the picker opened at the kept folder", "Did the picker open at the PassBridge folder?");
    await asked("round 2: Chrome offered Allow on every visit", "Did Chrome offer Allow on every visit?");

    await publish(3, builds[3], "bad");
    await step(`Round 3: a broken signature, ${v(2)} → ${v(3)}`, ["Reload the update page and press Update now"]);
    await folderIs("round 3: nothing changed", builds[2]);
    await asked("round 3: the page reported the failed signature check", 'Did the page say the signature check failed and "Nothing was changed"?');

    await publish(4, builds[4], "none");
    await step(`Round 4: an unsigned release, ${v(4)}`, ["Reload the update page"]);
    await folderIs("round 4: nothing changed", builds[2]);
    await asked("round 4: the page only offered the release page", "Did the page say the release isn't signed, with no Update now?");

    await publish(5, builds[5]);
    await step(`Round 5: one click after a restart, ${v(2)} → ${v(5)}`, ["Quit this Chrome completely (Cmd+Q)"]);
    startChrome(UPDATE_PAGE);
    await step("Round 5, continued", ["Chrome opened the update page again: press Update now and nothing else"]);
    await folderIs("round 5: the folder holds the new release", builds[5]);
    await asked("round 5: no picker and no prompt", "Did it update without any window or prompt?");

    await step("Round 6: a restart that did not land", [`Open ${UPDATE_PAGE}?updated=0.0.0.1`]);
    await asked("round 6: the page said something went wrong", `Did it say "Something went wrong: PassBridge is still ${v(5)}, not 0.0.0.1"?`);
  } finally {
    rl.close();
    for (const p of chromes) if (p.exitCode === null) p.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(EXT, { recursive: true, force: true }).catch(() => {});
  }
});
