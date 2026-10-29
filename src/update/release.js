// the latest release and its verified download, shared by the helper update and the folder update

import { LATEST_RELEASE_URL, isNewerVersion, releasePageUrl } from "./check.js";
import { PUBLIC_KEY_B64, digestHex, verifyRelease } from "./verify.js";

export const ZIP_NAME = "passbridge.zip";
export const MAX_ZIP = 64 * 1024 * 1024;

/**
 * @param {string} [currentVersion]
 * @returns {Promise<{ ok: true, version: string, pageUrl: string, zipUrl: string, sigUrl: string, digest: string, size: number }
 *   | { ok: false, error: "network" | "current" | "unsigned", version?: string, pageUrl?: string }>}
 */
export async function latestRelease(currentVersion = chrome.runtime.getManifest().version) {
  const found = await fetchLatest();
  if (!found) return { ok: false, error: "network" };
  const { release, tag, version } = found;
  if (!isNewerVersion(version, currentVersion)) return { ok: false, error: "current" };
  const pageUrl = releasePageUrl(tag);
  const asset = signedAsset(release, ZIP_NAME);
  if (!asset) return { ok: false, error: "unsigned", version, pageUrl };
  return { ok: true, version, pageUrl, ...asset };
}

// the helper zip for this machine, signed like the extension zip; no version comparison, the caller has its own
export function helperZipName(platform = navigator.userAgentData?.platform || navigator.platform || "") {
  return /win/i.test(platform) ? "passbridge-windows-helper.zip" : "passbridge-macos-helper.zip";
}

/** @returns {Promise<{ ok: true, version: string, zipUrl: string, sigUrl: string, digest: string, size: number } | { ok: false, error: "network" | "unsigned" }>} */
export async function latestHelperRelease(platform) {
  const found = await fetchLatest();
  if (!found) return { ok: false, error: "network" };
  const asset = signedAsset(found.release, helperZipName(platform));
  return asset ? { ok: true, version: found.version, ...asset } : { ok: false, error: "unsigned" };
}

async function fetchLatest() {
  let release = null;
  try {
    // a cached answer would hide a release that just came out, or hand over a zip the digest no longer matches
    const res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    release = res.ok ? await res.json() : null;
  } catch {}
  if (!release) return null;
  const tag = String(release.tag_name ?? "");
  return { release, tag, version: tag.replace(/^v/, "") };
}

export function signedAsset(release, name) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zip = assets.find((a) => a?.name === name);
  const sig = assets.find((a) => a?.name === `${name}.sig`);
  const digest = digestHex(zip?.digest);
  if (!zip || !sig || !digest) return null;
  return { zipUrl: zip.browser_download_url, sigUrl: sig.browser_download_url, digest, size: Number(zip.size) || 0 };
}

async function download(url, onProgress, total) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error("download");
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > MAX_ZIP) throw new Error("download");
    parts.push(value);
    onProgress?.(got, total || got);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * @param {{ zipUrl: string, sigUrl: string, digest: string, size: number }} release
 * @param {{ publicKey?: string, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<{ ok: true, zip: Uint8Array } | { ok: false, error: "download" | "verify" }>}
 */
export async function downloadRelease(release, { publicKey = PUBLIC_KEY_B64, onProgress } = {}) {
  let zip, sig;
  try {
    [zip, sig] = await Promise.all([download(release.zipUrl, onProgress, release.size), download(release.sigUrl)]);
  } catch {
    return { ok: false, error: "download" };
  }
  if (!(await verifyRelease(zip, sig, release.digest, publicKey))) return { ok: false, error: "verify" };
  return { ok: true, zip };
}
