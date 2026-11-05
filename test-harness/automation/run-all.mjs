// needs the mock builds (node build-test-extensions.mjs). Serves test-harness/ itself unless OP_BASE is set.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { HERE, serveStatic } from "./lib.mjs";

const DRIVERS = [
  ["PIN handshake (SRP math + challenge lifecycle)", "pin-session.test.mjs"],
  ["Windows helper quirks (string MSG, string SMSG, wrong PIN)", "windows-host.test.mjs"],
  ["UI suite (login/OTP/forum, offer flow, click-through, shortcut)", "drive.mjs"],
  ["Adversarial (false positives: search/tag/checkout)", "drive-adversarial.mjs"],
  ["Test bench (positive + negative on one page)", "drive-bench.mjs"],
  ["Anchor (fill the field you acted on)", "drive-anchor.mjs"],
  ["Click-back (dropdown reappears)", "drive-clickback.mjs"],
  ["Input events fire on fill (#9)", "drive-events.mjs"],
  ["Clickjacking: hidden field not filled (#18)", "drive-clickjack.mjs"],
  ["HTTP fill gate (refused by default, canFillOnHttp opens it)", "drive-http-fill.mjs"],
  ["Save prompt (edit username/password before saving)", "drive-save-edit.mjs"],
  ["Save prompt (a password corrected after autofill is an update) (#224)", "drive-save-update.mjs"],
  ["Save prompt: allow agent sign-in for the site", "drive-save-agent-allow.mjs"],
  ["Multi-account chooser", "drive-multi.mjs"],
  ["Generated password reaches the confirm box (#169)", "drive-gen-confirm.mjs"],
  ["PIN flow (Enter on a short code, 6 digits submit alone)", "drive-pin.mjs"],
  ["Iframe login (same-origin frame shows dropdown)", "drive-iframe.mjs"],
  ["Cross-origin iframe shows NO offer (leak closed)", "drive-xorigin.mjs"],
  ["Verification codes (TOTP rows, split-box fill)", "drive-otp.mjs"],
  ["Inline menu host (closed shadow, field icon)", "drive-menu.mjs"],
  ["Icon click (unfocused, empty vault, re-rendered field)", "drive-icon-click.mjs"],
  ["Icon click with nothing to fill says why", "drive-icon-click-empty.mjs"],
  ["Login list (search, scroll cap, keyboard)", "drive-login-list.mjs"],
  ["UI preview (popup screens and the update page)", "drive-ui-preview.mjs"],
  ["Options page (tabs, help lines, helper notices, saving)", "drive-options.mjs"],
  ["Passkeys (create, two signed gets, wrong origin, detached elsewhere)", "drive-passkeys.mjs"],
  ["Folder update on Chrome's file system (OPFS)", "drive-update-fs.mjs"],
  ["E2E pairing with the simulated Apple helper (mac and win)", "drive-e2e-pair.mjs"],
  ["E2E fill and save against the simulated helper", "drive-e2e-fill-save.mjs"],
  ["E2E verification codes against the simulated helper", "drive-e2e-otp.mjs"],
  ["E2E passkey store against the simulated helper (win)", "drive-e2e-passkeys.mjs"],
  ["E2E Touch ID denied or unanswered, relogin and re-pair", "drive-e2e-auth.mjs"],
  ["E2E agent relay sign-in through the browser's native host", "drive-e2e-agent.mjs"],
  ["Unit (matching, otpauth, protocol, SRP, update)", "unit.test.mjs"],
];

if (!["unlocked", "real-mac", "real-win"].every((kind) => existsSync(join(HERE, ".builds", kind)))) {
  console.error("Mock builds missing. Run:  node build-test-extensions.mjs");
  process.exit(2);
}

let server = null;
if (!process.env.OP_BASE) {
  server = await serveStatic(join(HERE, ".."));
  process.env.OP_BASE = server.url;
}

const DRIVER_LIMIT_MS = 300000;

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // a driver that hangs is stopped and reported with what it printed, not left to the job timeout
    const timer = setTimeout(() => {
      out += `\nFAIL driver stopped after ${DRIVER_LIMIT_MS / 1000} s\n`;
      p.kill("SIGKILL");
    }, DRIVER_LIMIT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

let passed = 0;
const failures = [];
console.log(`Running PassBridge headless suite against ${process.env.OP_BASE}\n` + "=".repeat(50));
for (const [name, file] of DRIVERS) {
  process.stdout.write(`\n▶ ${name}\n`);
  const { code, out } = await run(file);
  const summary = (out.match(/====.*====|PASS .*|FAIL .*/g) || []).slice(-1)[0] || "(no summary)";
  if (code === 0) {
    passed++;
    console.log(`  ✅ ${summary.trim()}`);
  } else {
    failures.push(name);
    console.log(`  ❌ FAILED (exit ${code})`);
    console.log(out.split("\n").filter((l) => /FAIL|Error|throw/.test(l)).slice(0, 5).map((l) => "     " + l).join("\n"));
  }
}
await server?.close();

console.log("\n" + "=".repeat(50));
console.log(`${passed}/${DRIVERS.length} suites passed`);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
console.log("All green.");
