// one-click update: download the latest release, verify it here, hand the zip to the updater host, reload
import { availableUpdate, isNewerVersion, markUpdatedTo } from "./check.js";
import { getSettings } from "../settings.js";
import { downloadRelease, latestHelperRelease, latestRelease } from "./release.js";
import { BUSY_MESSAGE, withUpdateLock } from "./lock.js";
import { PUBLIC_KEY_B64 } from "./verify.js";

export const UPDATER_HOST = "com.passbridge.updater";

// the popup shows the button only when the host answers and a key is pinned
export async function updaterAvailable() {
  if (!PUBLIC_KEY_B64) return false;
  try {
    const res = await chrome.runtime.sendNativeMessage(UPDATER_HOST, { op: "status" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

function toB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MESSAGES = {
  download: "Couldn't download the update.",
  unsigned: "This release isn't signed, so it can't be installed here. Download it from the release page.",
  verify: "The update failed its signature check, so it was not installed.",
  host: "The updater helper didn't answer. Run the helper install again.",
  nokey: "This build can't verify updates yet.",
};

// returns {ok:true} (the extension reloads right after) or {ok:false, error} with short text for the popup.
// shares one lock with the folder update page, so only one update runs across all PassBridge pages
export async function installUpdate(currentVersion = chrome.runtime.getManifest().version, { publicKey = PUBLIC_KEY_B64, locks, auto = false } = {}) {
  const locked = await withUpdateLock(() => runInstall(currentVersion, publicKey, auto), locks);
  return locked.ok ? locked.value : { ok: false, error: BUSY_MESSAGE };
}

// the helper is updated first, so an extension that needs a newer helper finds it. never blocks the extension update.
// an old helper (before install-helper) can't do it: the popup tells the user once to re-install it
export async function updateHelper({ publicKey = PUBLIC_KEY_B64, send = (m) => chrome.runtime.sendNativeMessage(UPDATER_HOST, m), platform } = {}) {
  if (!publicKey) return { ok: false, error: "nokey" };
  let status;
  try {
    status = await send({ op: "status" });
  } catch {
    return { ok: false, error: "host" };
  }
  if (!status?.ok) return { ok: false, error: "host" };
  if (!("helperVersion" in status)) {
    await chrome.storage.local.set({ helperOutdatedNote: true });
    return { ok: false, error: "old-helper" };
  }
  const { latestRelease: tag } = await chrome.storage.local.get("latestRelease");
  const latest = String(tag ?? "").replace(/^v/, "");
  if (status.helperVersion && !isNewerVersion(latest, status.helperVersion)) return { ok: true, skipped: true };
  const release = await latestHelperRelease(platform);
  if (!release.ok) return { ok: false, error: release.error };
  if (status.helperVersion && !isNewerVersion(release.version, status.helperVersion)) return { ok: true, skipped: true };
  const got = await downloadRelease(release, { publicKey });
  if (!got.ok) return { ok: false, error: got.error };
  let reply;
  try {
    reply = await send({ op: "install-helper", zip: toB64(got.zip), version: release.version });
  } catch {
    return { ok: false, error: "host" };
  }
  if (!reply?.ok) return { ok: false, error: reply?.error ? String(reply.error).slice(0, 120) : "host" };
  return { ok: true, version: release.version };
}

async function runInstall(currentVersion, publicKey, auto = false) {
  const fail = (key, extra) => ({ ok: false, error: extra || MESSAGES[key] });
  if (!publicKey) return fail("nokey");
  await updateHelper({ publicKey }).catch(() => {});
  const release = await latestRelease(currentVersion);
  if (!release.ok) return fail(release.error === "unsigned" ? "unsigned" : "download");
  const got = await downloadRelease(release, { publicKey });
  if (!got.ok) return fail(got.error);
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(UPDATER_HOST, { op: "install", zip: toB64(got.zip), version: release.version });
  } catch {
    return fail("host");
  }
  if (!reply?.ok) return fail("host", reply?.error ? `Update failed: ${String(reply.error).slice(0, 120)}` : MESSAGES.host);
  await markUpdatedTo(release.version);
  if (auto) await chrome.storage.local.set({ autoUpdatedTo: release.version });
  // give the reply time to reach the popup before the extension restarts
  setTimeout(() => chrome.runtime.reload(), 300);
  return { ok: true };
}

// called after each release check: installs a newer signed release with no click.
// needs the setting on and the helper there; a version that failed once is not tried again, so it can't loop
export async function autoInstallUpdate({ install = installUpdate, available = updaterAvailable, helper = updateHelper } = {}) {
  const settings = await getSettings();
  if (!settings.canCheckForUpdates || !settings.autoInstallUpdates) return { ran: false, why: "off" };
  const update = await availableUpdate();
  const { autoInstallFailed } = await chrome.storage.local.get("autoInstallFailed");
  if (!(await available())) return { ran: false, why: "no-host" };
  if (!update) {
    // nothing new for the extension, the helper may still be behind (once per release)
    const { helperFailed, latestRelease: tag } = await chrome.storage.local.get(["helperFailed", "latestRelease"]);
    if (helperFailed === tag) return { ran: false, why: "none" };
    const res = await helper().catch(() => ({ ok: false }));
    if (!res.ok && res.error !== "host" && res.error !== "old-helper") await chrome.storage.local.set({ helperFailed: tag });
    return { ran: false, why: "none", helper: res };
  }
  if (autoInstallFailed === update.version) return { ran: false, why: "failed-before" };
  const res = await install(undefined, { auto: true });
  if (!res?.ok) {
    await chrome.storage.local.set({ autoInstallFailed: update.version });
    return { ran: true, ok: false, error: res?.error };
  }
  return { ran: true, ok: true, version: update.version };
}

/** @returns {Promise<string | null>} the version an automatic update just landed on, once */
export async function takeAutoUpdatedTo() {
  const { autoUpdatedTo } = await chrome.storage.local.get("autoUpdatedTo");
  if (!autoUpdatedTo) return null;
  await chrome.storage.local.remove("autoUpdatedTo");
  return String(autoUpdatedTo);
}
