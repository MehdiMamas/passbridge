// npm test: the unit and handshake suites, plus the Python host checks when a Python 3 is on PATH.
// The browser suite (test-harness/automation/run-all.ts) needs Chromium and runs separately.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTO = join(dirname(fileURLToPath(import.meta.url)), "..", "test-harness", "automation");
const PY_SUITES = ["native-hosts.test.py", "updater.test.py", "agent-relay.test.py"];
const SUITES = ["unit.test.ts", "pin-session.test.ts", "windows-host.test.ts", "windows-fixtures.test.ts", "i18n.test.ts", "otp-list.test.ts", "mru.test.ts", "fake-helper.test.ts"];

// the Windows Store "python3" stub exits non-zero, so ask each candidate for its major version
function findPython() {
  const candidates = process.env.PB_PYTHON ? [[process.env.PB_PYTHON]] : [["python3"], ["python"], ["py", "-3"]];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return [cmd, ...pre];
  }
  return null;
}

const failed: string[] = [];
function run(label: string, cmd: string, args: string[]) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) failed.push(`${label} (exit ${r.status ?? (r.error as NodeJS.ErrnoException | undefined)?.code})`);
}

// static locale check first: fails fast on a missing key or placeholder mismatch
run("check-locales.ts", process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "check-locales.ts")]);

for (const file of SUITES) run(file, process.execPath, [join(AUTO, file)]);

const python = findPython();
if (python) {
  for (const file of PY_SUITES) run(file, python[0], [...python.slice(1), "-I", join(AUTO, file)]);
} else console.log("\nSKIP the Python suites (no Python 3 on PATH; set PB_PYTHON to point at one)");

console.log(`\n${"=".repeat(50)}`);
if (failed.length) {
  console.log("FAILED: " + failed.join(", "));
  process.exit(1);
}
const n = 1 + SUITES.length + (python ? PY_SUITES.length : 0);
console.log(`${n} checks/suites passed${python ? "" : " (Python checks skipped)"}`);
