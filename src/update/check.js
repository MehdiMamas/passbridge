// the unpacked build never updates itself, so every 30 minutes the latest GitHub release is compared with the manifest

import { getSettings } from "../settings.js";
import { REPORT_REPO } from "../report-scrub.js";
import { RELEASE_SOURCE } from "./source.js";
import { ZIP_NAME, signedAsset } from "./release.js";

// 48 unauthenticated requests a day, well under GitHub's 60 an hour per IP
export const UPDATE_CHECK_MS = 30 * 60 * 1000;
export const UPDATE_PAGE = "src/update.html";
export const LATEST_RELEASE_URL = RELEASE_SOURCE?.latestUrl ?? `https://api.github.com/repos/${REPORT_REPO}/releases/latest`;

export function releasePageUrl(tag) {
  return `https://github.com/${REPORT_REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

function parseVersion(tag) {
  const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(tag ?? "").trim());
  return m ? m[1].split(".").map(Number) : null;
}

export function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// a failed or refused request leaves updateCheckedAt alone so the next alarm retries
async function runCheck(now, force) {
  if (!(await getSettings()).canCheckForUpdates) return false;
  const { updateCheckedAt } = await chrome.storage.local.get("updateCheckedAt");
  const age = now - (Number(updateCheckedAt) || 0);
  if (!force && age >= 0 && age < UPDATE_CHECK_MS) return false;
  let res;
  try {
    res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  } catch {
    return false;
  }
  const body = res.ok ? await res.json().catch(() => null) : null;
  const tag = body?.tag_name;
  if (!res.ok) return false;
  // a release is offered only once its signature is on it, the update page refuses it before that
  await chrome.storage.local.set(parseVersion(tag) ? { updateCheckedAt: now, latestRelease: tag, latestUnsigned: signedAsset(body, ZIP_NAME) ? null : tag } : { updateCheckedAt: now });
  return true;
}

let running = null;
// force skips the wait (a button press); resolves true when GitHub answered.
// storage calls fail with "No SW" while the worker shuts down for a reload, the next alarm checks again
export function checkForUpdate(now = Date.now(), { force = false } = {}) {
  running ||= runCheck(now, force)
    .catch(() => false)
    .finally(() => {
      running = null;
    });
  return running;
}

/** @returns {Promise<{ version: string, url: string } | null>} */
export async function availableUpdate(currentVersion = chrome.runtime.getManifest().version) {
  if (!(await getSettings()).canCheckForUpdates) return null;
  const { latestRelease, dismissedRelease, latestUnsigned } = await chrome.storage.local.get(["latestRelease", "dismissedRelease", "latestUnsigned"]);
  if (latestRelease === dismissedRelease || latestRelease === latestUnsigned || !isNewerVersion(latestRelease, currentVersion)) return null;
  return {
    version: parseVersion(latestRelease).join("."),
    url: releasePageUrl(latestRelease),
  };
}

// both installs mark the version before the restart; the background then opens the page that checks it landed
/**
 * @param {string} version
 * @returns {Promise<void>}
 */
export function markUpdatedTo(version) {
  return chrome.storage.local.set({ updatedTo: version });
}

/** @returns {Promise<string | null>} */
export async function takeUpdatedTo() {
  const { updatedTo } = await chrome.storage.local.get("updatedTo");
  if (!updatedTo) return null;
  await chrome.storage.local.remove("updatedTo");
  return String(updatedTo);
}

export async function dismissUpdate() {
  const { latestRelease } = await chrome.storage.local.get("latestRelease");
  if (latestRelease) await chrome.storage.local.set({ dismissedRelease: latestRelease });
}
