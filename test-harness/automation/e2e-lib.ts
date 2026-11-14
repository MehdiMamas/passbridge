// plumbing for the e2e drivers: the real extension build for one platform, a simulated Apple helper that the browser
// reaches through a native-messaging host, and a throwaway folder for the agent relay

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FakeHelper, seedVault } from "../fake-apple-helper/helper.ts";
import { serveHelper } from "../fake-apple-helper/serve.ts";
import { HERE, build, clickMenu, launchExtension, onCleanup, pierced, typeInMenu, waitFor, clickMenuWhenShown } from "./lib.ts";

export const AGENT_CLI = join(HERE, "..", "..", "native", "passbridge-agent-cli.py");
export const PLATFORMS: ("mac" | "win")[] = ["mac", "win"];
const HOST = join(HERE, "..", "fake-apple-helper", "host.ts");
const AGENT = join(HERE, "..", "..", "native", "passbridge-agent.py");

// platform: "mac" or "win". Returns the browser context, the helper and the folders it uses.
export async function startE2E(platform: "mac" | "win", { agent = false, vault }: { agent?: boolean, vault?: ReturnType<typeof seedVault> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pb-e2e-"));
  const helper = new FakeHelper({ style: platform, vault: vault ?? seedVault() });
  const sock = await serveHelper(helper, join(dir, "helper.sock"));
  const appDir = join(dir, "agent");
  const hosts: Record<string, string> = { "com.apple.passwordmanager": HOST };
  if (agent) {
    // the relay is not an executable file in the repo, so the browser starts it through a small launcher
    const launcher = join(dir, "agent-host.sh");
    await writeFile(launcher, `#!/bin/sh\nexec python3 -I "${AGENT}"\n`);
    hosts["com.passbridge.agent"] = launcher;
  }
  const ctx = await launchExtension(build(`real-${platform}`, `OP_EXT_${platform.toUpperCase()}`), {
    hosts,
    env: { PB_FAKE_HELPER_SOCK: sock.sockPath, PASSBRIDGE_APPDIR: appDir },
  });
  const stop = async () => {
    await sock.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  onCleanup(stop);
  return { ctx, helper, dir, appDir, platform, stop };
}

// pair from a login page's menu: click "Unlock to autofill", then type the code the helper is showing
export async function pairFromMenu(page: import("playwright").Page, helper: FakeHelper, field: string = 'input[name="username"]') {
  await page.focus(field);
  await clickMenuWhenShown(page, "Unlock to autofill");
  await waitFor(async () => helper.code !== undefined && (await pierced(page)).menuInput() !== null, 10000);
  await typeInMenu(page, helper.code);
  await waitFor(() => helper.paired, 10000);
  return helper.paired;
}
