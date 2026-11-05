// Check whether a pinned upstream moved and changed any tracked file.
// Usage: node scripts/upstream-check.ts [name] [--issues]
// Prints a JSON summary. With --issues, opens or updates one issue per changed upstream (needs gh and a token).

import { readFile, rm } from "fs/promises";
import { join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { diffAgainstMirror, downloadTracked, loadCatalog, trackedPaths } from "./sync-upstream.ts";

/**
 * @typedef {{ name: string, repo: string, pinned: string, latest: string, changed: string[], new: string[], removed: string[], failed: string[], compare: string }} Summary
 * @typedef {Partial<Summary> & { upToDate?: boolean, error?: string }} CheckResult
 */

// Pins may be short (fc5de86): same commit when one is a prefix of the other.
/**
 * @param {unknown} pinned
 * @param {unknown} latest
 */
export function samePin(pinned, latest) {
  const a = String(pinned || "").trim().toLowerCase();
  const b = String(latest || "").trim().toLowerCase();
  return a.length > 0 && b.length > 0 && (b.startsWith(a) || a.startsWith(b));
}

/**
 * @param {string} repo
 * @param {string} pinned
 * @param {string} latest
 */
export function compareUrl(repo, pinned, latest) {
  return `https://github.com/${repo}/compare/${pinned}...${latest}`;
}

// diffs: [{ rel, kind }] from the mirror diff; missing: [{ path, status }] files upstream no longer has.
/**
 * @param {{ name: string, repo: string, pinned: string, latest: string, diffs?: { rel: string, kind: string }[], missing?: { path: string, status: number }[] }} input
 * @returns {Summary}
 */
export function summarize({ name, repo, pinned, latest, diffs = [], missing = [] }) {
  const removed = missing.filter((m) => m.status === 404).map((m) => m.path);
  const failed = missing.filter((m) => m.status !== 404).map((m) => `${m.status} ${m.path}`);
  const changed = diffs.map((d) => d.rel);
  return {
    name,
    repo,
    pinned,
    latest,
    changed,
    new: diffs.filter((d) => d.kind === "new").map((d) => d.rel),
    removed,
    failed,
    compare: compareUrl(repo, pinned, latest),
  };
}

/** @param {Summary} s */
export function changeCount(s) {
  return s.changed.length + s.removed.length;
}

/** @param {Summary} s */
export function issueTitle(s) {
  return `Upstream: ${s.name} changed ${changeCount(s)} tracked file(s)`;
}

/** @param {string} name */
export function titlePrefix(name) {
  return `Upstream: ${name}`;
}

/** @param {Summary} s */
export function issueBody(s) {
  /**
   * @param {string[]} items
   * @param {string} [suffix]
   */
  const list = (items, suffix = "") => items.map((f) => `- \`${f}\`${suffix}`).join("\n");
  const lines = [
    `${s.repo} moved past the pinned commit and changed files PassBridge tracks.`,
    "",
    `- Pinned commit: \`${s.pinned}\``,
    `- Latest commit: \`${s.latest}\``,
    `- Compare: ${s.compare}`,
    "",
  ];
  if (s.changed.length) lines.push("Changed files (vendor/" + s.name + "/ differs from upstream):", list(s.changed), "");
  if (s.removed.length) lines.push("Removed upstream (404 at the latest commit):", list(s.removed), "");
  lines.push(
    "Steps (see UPSTREAMS.md):",
    "",
    `1. \`npm run sync -- ${s.name} ${s.latest}\` and read the diff.`,
    "2. Review it against the running code, then rebuild.",
    "3. Run the harness.",
    `4. \`npm run sync -- ${s.name} ${s.latest} --accept\` to pin it.`,
    "",
    "This issue is updated by the weekly upstream check.",
  );
  return lines.join("\n");
}

/** @returns {Record<string, string>} */
function headers() {
  /** @type {Record<string, string>} */
  const h = { accept: "application/vnd.github+json", "user-agent": "passbridge-upstream-check" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** @param {string} path */
async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

/** @param {string} repo */
async function latestCommit(repo) {
  const info = await api(`/repos/${repo}`);
  const commit = await api(`/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`);
  return commit.sha;
}

/**
 * @param {string} root
 * @param {string} name
 * @param {{ repo: string, pin: string, pathsFile?: string, paths: string[], strip?: string }} spec
 * @returns {Promise<CheckResult>}
 */
async function checkOne(root, name, spec) {
  const pinned = (await readFile(join(root, spec.pin), "utf8")).trim();
  const latest = await latestCommit(spec.repo);
  if (samePin(pinned, latest)) return { name, repo: spec.repo, pinned, latest, changed: [], new: [], removed: [], failed: [], compare: compareUrl(spec.repo, pinned, latest), upToDate: true };
  const stamp = join(root, "vendor", name, ".sync-tmp");
  try {
    const missing = await downloadTracked(spec, await trackedPaths(spec, root), latest, stamp);
    const diffs = await diffAgainstMirror(stamp, join(root, "vendor", name));
    return { ...summarize({ name, repo: spec.repo, pinned, latest, diffs, missing }), upToDate: false };
  } finally {
    await rm(stamp, { recursive: true, force: true });
  }
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** @param {Summary} s */
function upsertIssue(s) {
  /** @type {{ number: number, title: string }[]} */
  const found = JSON.parse(gh(["issue", "list", "--label", "upstream", "--state", "open", "--search", `"${titlePrefix(s.name)}" in:title`, "--json", "number,title", "--limit", "50"]));
  const match = found.find((i) => i.title.startsWith(titlePrefix(s.name)));
  if (match) {
    gh(["issue", "edit", String(match.number), "--title", issueTitle(s), "--body", issueBody(s)]);
    return { name: s.name, issue: match.number, action: "updated" };
  }
  const url = gh(["issue", "create", "--title", issueTitle(s), "--body", issueBody(s), "--label", "upstream"]).trim();
  return { name: s.name, issue: url, action: "created" };
}

async function main() {
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const withIssues = argv.includes("--issues");
  const only = argv.find((a) => !a.startsWith("--"));
  const catalog = await loadCatalog(root);
  const names = only ? [only] : Object.keys(catalog);
  for (const n of names) {
    if (!catalog[n]) {
      console.error(`Unknown upstream "${n}". Known: ${Object.keys(catalog).join(", ")}`);
      process.exit(1);
    }
  }
  /** @type {CheckResult[]} */
  const results = [];
  let errors = 0;
  for (const n of names) {
    try {
      results.push(await checkOne(root, n, catalog[n]));
    } catch (err) {
      errors += 1;
      results.push({ name: n, repo: catalog[n].repo, error: String(/** @type {Error} */ (err).message || err) });
    }
  }
  /** @type {object[]} */
  const issues = [];
  if (withIssues) {
    for (const r of results) {
      if (r.error || r.upToDate || changeCount(/** @type {Summary} */ (r)) === 0) continue;
      const s = /** @type {Summary} */ (r);
      try {
        issues.push(upsertIssue(s));
      } catch (err) {
        errors += 1;
        issues.push({ name: s.name, error: String(/** @type {Error} */ (err).message || err) });
      }
    }
  }
  console.log(JSON.stringify(withIssues ? { results, issues } : results, null, 2));
  if (errors) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
