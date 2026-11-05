// Check whether a pinned upstream moved and changed any tracked file.
// Usage: node scripts/upstream-check.ts [name] [--issues]
// Prints a JSON summary. With --issues, opens or updates one issue per changed upstream (needs gh and a token).

import { readFile, rm } from "fs/promises";
import { join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { diffAgainstMirror, downloadTracked, loadCatalog, trackedPaths } from "./sync-upstream.ts";

type Summary = { name: string, repo: string, pinned: string, latest: string, changed: string[], new: string[], removed: string[], failed: string[], compare: string };
type CheckResult = Partial<Summary> & { upToDate?: boolean, error?: string };

// Pins may be short (fc5de86): same commit when one is a prefix of the other.
export function samePin(pinned: unknown, latest: unknown) {
  const a = String(pinned || "").trim().toLowerCase();
  const b = String(latest || "").trim().toLowerCase();
  return a.length > 0 && b.length > 0 && (b.startsWith(a) || a.startsWith(b));
}

export function compareUrl(repo: string, pinned: string, latest: string) {
  return `https://github.com/${repo}/compare/${pinned}...${latest}`;
}

// diffs: [{ rel, kind }] from the mirror diff; missing: [{ path, status }] files upstream no longer has.
export function summarize({ name, repo, pinned, latest, diffs = [], missing = [] }: { name: string, repo: string, pinned: string, latest: string, diffs?: { rel: string, kind: string }[], missing?: { path: string, status: number }[] }): Summary {
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

export function changeCount(s: Summary) {
  return s.changed.length + s.removed.length;
}

export function issueTitle(s: Summary) {
  return `Upstream: ${s.name} changed ${changeCount(s)} tracked file(s)`;
}

export function titlePrefix(name: string) {
  return `Upstream: ${name}`;
}

export function issueBody(s: Summary) {
  const list = (items: string[], suffix: string = "") => items.map((f) => `- \`${f}\`${suffix}`).join("\n");
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

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "passbridge-upstream-check" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function api(path: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

async function latestCommit(repo: string) {
  const info = await api(`/repos/${repo}`);
  const commit = await api(`/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`);
  return commit.sha;
}

async function checkOne(root: string, name: string, spec: { repo: string, pin: string, pathsFile?: string, paths: string[], strip?: string }): Promise<CheckResult> {
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

function gh(args: string[]) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function upsertIssue(s: Summary) {
  const found: { number: number, title: string }[] = JSON.parse(gh(["issue", "list", "--label", "upstream", "--state", "open", "--search", `"${titlePrefix(s.name)}" in:title`, "--json", "number,title", "--limit", "50"]));
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
  const results: CheckResult[] = [];
  let errors = 0;
  for (const n of names) {
    try {
      results.push(await checkOne(root, n, catalog[n]));
    } catch (err) {
      errors += 1;
      results.push({ name: n, repo: catalog[n].repo, error: String((err as Error).message || err) });
    }
  }
  const issues: object[] = [];
  if (withIssues) {
    for (const r of results) {
      if (r.error || r.upToDate || changeCount((r as Summary)) === 0) continue;
      const s = (r as Summary);
      try {
        issues.push(upsertIssue(s));
      } catch (err) {
        errors += 1;
        issues.push({ name: s.name, error: String((err as Error).message || err) });
      }
    }
  }
  console.log(JSON.stringify(withIssues ? { results, issues } : results, null, 2));
  if (errors) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
