// an update swaps the shared unpacked folder but reloads only the profile that installed it;
// other profiles on the same folder keep the old code until Chrome restarts, so each one checks the files on disk
import { isNewerVersion } from "./check.js";

/**
 * @param {{ fetchManifest?: () => Promise<unknown>, running?: string, reload?: () => void }} [deps]
 * @returns {Promise<boolean>} true when it reloaded
 */
export async function reloadIfStale({
  fetchManifest = async () => (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json(),
  running = chrome.runtime.getManifest().version,
  reload = () => chrome.runtime.reload(),
} = {}) {
  let onDisk;
  try {
    onDisk = /** @type {{ version?: unknown } | null} */ (await fetchManifest())?.version;
  } catch {
    return false;
  }
  if (!isNewerVersion(onDisk, running)) return false;
  reload();
  return true;
}
