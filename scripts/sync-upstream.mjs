// Download one pinned upstream and show the diff against vendor/<name>/.
// Usage: node scripts/sync-upstream.mjs <bitwarden|au2001|open-passwords> [commit] [--accept]
// --accept copies the download over the vendor mirror and writes PINNED.
// The download and diff helpers are exported for scripts/upstream-check.mjs.

import { cp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const root = process.cwd();

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

export async function loadCatalog(dir = root) {
  return JSON.parse(await readFile(join(dir, "upstreams.json"), "utf8"));
}

export async function trackedPaths(spec, dir = root) {
  return spec.pathsFile
    ? (await readFile(join(dir, spec.pathsFile), "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : spec.paths;
}

// Download the tracked files at a commit into a fresh stamp folder.
// Returns the upstream paths that did not download as [{ path, status }].
export async function downloadTracked(spec, paths, commit, stamp) {
  await rm(stamp, { recursive: true, force: true });
  await mkdir(stamp, { recursive: true });
  const missing = [];
  for (const rel of paths) {
    const url = `https://raw.githubusercontent.com/${spec.repo}/${commit}/${rel}`;
    const res = await fetch(url);
    if (!res.ok) {
      missing.push({ path: rel, status: res.status });
      continue;
    }
    const destRel = spec.strip && rel.startsWith(spec.strip) ? rel.slice(spec.strip.length) : rel;
    const dest = join(stamp, destRel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await res.text());
  }
  return missing;
}

// Compare a stamp folder with the vendor mirror: [{ rel, kind: "new" | "changed" }].
export async function diffAgainstMirror(stamp, mirror) {
  const out = [];
  for (const file of await collectedFiles(stamp)) {
    const rel = relative(stamp, file);
    const next = normalize(await readFile(file, "utf8"));
    let current = null;
    try {
      current = normalize(await readFile(join(mirror, rel), "utf8"));
    } catch {
      current = null;
    }
    if (current === next) continue;
    out.push({ rel, kind: current == null ? "new" : "changed" });
  }
  return out;
}

async function collectedFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectedFiles(path)));
    else out.push(path);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--accept");
  const accept = process.argv.includes("--accept");
  const name = args[0];
  const catalog = await loadCatalog();
  const spec = catalog[name];
  if (!spec) {
    console.error(`Unknown upstream "${name}". Known: ${Object.keys(catalog).join(", ")}`);
    process.exit(1);
  }

  const pinPath = join(root, spec.pin);
  const pinned = (await readFile(pinPath, "utf8")).trim();
  const commit = args[1] || pinned;
  const paths = await trackedPaths(spec);

  const stamp = join(root, "vendor", name, ".sync-tmp");
  const missing = await downloadTracked(spec, paths, commit, stamp);
  for (const m of missing) console.error(`missing ${m.status} ${m.path}`);
  if (missing.length) process.exit(1);

  console.log(`downloaded ${paths.length} files from ${spec.repo}@${commit}`);
  const mirror = join(root, "vendor", name);
  const diffs = await diffAgainstMirror(stamp, mirror);
  for (const d of diffs) console.log(`${d.kind} ${d.rel}`);
  console.log(diffs.length ? `${diffs.length} file(s) differ from vendor/${name}/` : "no diff");

  if (accept) {
    await cp(stamp, mirror, { recursive: true });
    await rm(stamp, { recursive: true, force: true });
    await writeFile(pinPath, `${commit}\n`);
    console.log(`accepted ${name} @ ${commit}`);
  } else {
    console.log(commit === pinned ? "Pin matches. Pass --accept to refresh the mirror." : `Review the diff, then re-run with --accept to pin ${commit}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
