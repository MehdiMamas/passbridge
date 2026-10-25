// one-click update: download the latest release, verify it here, hand the zip to the updater host, reload
import { REPORT_REPO } from "./report-scrub.js";
import { isNewerVersion } from "./update-check.js";
import { PUBLIC_KEY_B64, digestHex, verifyRelease } from "./update-verify.js";

export const UPDATER_HOST = "com.passbridge.updater";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPORT_REPO}/releases/latest`;
const ZIP_NAME = "passbridge.zip";

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

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("download");
  return new Uint8Array(await res.arrayBuffer());
}

const MESSAGES = {
  download: "Couldn't download the update.",
  verify: "The update failed its signature check, so it was not installed.",
  host: "The updater helper didn't answer. Run the helper install again.",
  nokey: "This build can't verify updates yet.",
};

// returns {ok:true} (the extension reloads right after) or {ok:false, error} with short text for the popup
export async function installUpdate(currentVersion = chrome.runtime.getManifest().version) {
  const fail = (key, extra) => ({ ok: false, error: extra || MESSAGES[key] });
  if (!PUBLIC_KEY_B64) return fail("nokey");
  let release;
  try {
    const res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: "application/vnd.github+json" } });
    release = res.ok ? await res.json() : null;
  } catch {}
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zipAsset = assets.find((a) => a?.name === ZIP_NAME);
  const sigAsset = assets.find((a) => a?.name === `${ZIP_NAME}.sig`);
  const version = String(release?.tag_name ?? "").replace(/^v/, "");
  if (!zipAsset || !sigAsset || !isNewerVersion(version, currentVersion)) return fail("download");
  const digest = digestHex(zipAsset.digest);
  if (!digest) return fail("verify");
  let zip, sig;
  try {
    [zip, sig] = await Promise.all([download(zipAsset.browser_download_url), download(sigAsset.browser_download_url)]);
  } catch {
    return fail("download");
  }
  if (!(await verifyRelease(zip, sig, digest))) return fail("verify");
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(UPDATER_HOST, { op: "install", zip: toB64(zip), version });
  } catch {
    return fail("host");
  }
  if (!reply?.ok) return fail("host", reply?.error ? `Update failed: ${String(reply.error).slice(0, 120)}` : MESSAGES.host);
  // give the reply time to reach the popup before the extension restarts
  setTimeout(() => chrome.runtime.reload(), 300);
  return { ok: true };
}
