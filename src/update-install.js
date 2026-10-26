// one-click update: download the latest release, verify it here, hand the zip to the updater host, reload
import { downloadRelease, latestRelease } from "./update-release.js";
import { PUBLIC_KEY_B64 } from "./update-verify.js";

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

// returns {ok:true} (the extension reloads right after) or {ok:false, error} with short text for the popup
export async function installUpdate(currentVersion = chrome.runtime.getManifest().version) {
  const fail = (key, extra) => ({ ok: false, error: extra || MESSAGES[key] });
  if (!PUBLIC_KEY_B64) return fail("nokey");
  const release = await latestRelease(currentVersion);
  if (!release.ok) return fail(release.error === "unsigned" ? "unsigned" : "download");
  const got = await downloadRelease(release);
  if (!got.ok) return fail(got.error);
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(UPDATER_HOST, { op: "install", zip: toB64(got.zip), version: release.version });
  } catch {
    return fail("host");
  }
  if (!reply?.ok) return fail("host", reply?.error ? `Update failed: ${String(reply.error).slice(0, 120)}` : MESSAGES.host);
  // give the reply time to reach the popup before the extension restarts
  setTimeout(() => chrome.runtime.reload(), 300);
  return { ok: true };
}
