// npm test: the unit and handshake suites, plus the Python host checks when a Python 3 is on PATH.
// The browser suite (test-harness/automation/run-all.mjs) needs Chromium and runs separately.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTO = join(dirname(fileURLToPath(import.meta.url)), "..", "test-harness", "automation");
const SUITES = ["unit.test.mjs", "pin-session.test.mjs", "windows-host.test.mjs"];

// the Windows Store "python3" stub exits non-zero, so ask each candidate for its major version
function findPython() {
  const candidates = process.env.PB_PYTHON ? [[process.env.PB_PYTHON]] : [["python3"], ["python"], ["py", "-3"]];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return [cmd, ...pre];
  }
  return null;
}

const failed = [];
function run(label, cmd, args) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) failed.push(`${label} (exit ${r.status ?? r.error?.code})`);
}

for (const file of SUITES) run(file, process.execPath, [join(AUTO, file)]);

const python = findPython();
if (python) run("native-hosts.test.py", python[0], [...python.slice(1), "-I", join(AUTO, "native-hosts.test.py")]);
else console.log("\nSKIP native-hosts.test.py (no Python 3 on PATH; set PB_PYTHON to point at one)");

console.log("\n" + "=".repeat(50));
if (failed.length) {
  console.log("FAILED: " + failed.join(", "));
  process.exit(1);
}
console.log(`${SUITES.length + (python ? 1 : 0)} suites passed${python ? "" : " (Python checks skipped)"}`);
