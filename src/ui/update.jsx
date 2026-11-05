import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { UpdateScreen } from "./update-screen.jsx";
import { markUpdatedTo } from "../update/check.js";
import { downloadRelease, latestRelease } from "../update/release.js";
import { manifestProblem, readZip } from "../update/zip.js";
import { applyUpdate, hasInterruptedUpdate, isOwnFolder, looksLikeSource, recoverUpdate, setUpdating } from "../update/files.js";
import { withUpdateLock } from "../update/lock.js";
import { HELPER_ZIP_URL, isWindows, updateRoute } from "../update/platform.js";
import { updaterAvailable } from "../update/install.js";
import { folderForUpdate, folderStore, pickFolder } from "../update/folder.js";
import { followTheme } from "./page-theme.js";
import { applyDocumentLanguage, t } from "../i18n/runtime.js";
import { useLocale } from "../i18n/use.jsx";

// update error codes; the message shown on the page is t(ERROR_KEYS[code])
/** @type {Record<string, string>} */
const ERROR_KEYS = {
  cancelled: "errCancelled",
  notsource: "errNotSource",
  busy: "errBusy",
  notown: "errNotOwn",
  download: "errDownload",
  verify: "errVerify",
  zip: "errZip",
  mismatch: "errMismatch",
  write: "errWrite",
  restore: "errRestore",
};

// the running extension serves its folder straight from disk, so this reads what is there now
/** @param {string} name */
const readBack = (name) => fetch(chrome.runtime.getURL(name), { cache: "no-store" }).then((r) => (r.ok ? r.text() : null), () => null);

const folderDeps = {
  store: folderStore,
  /** @param {any} [startIn] a directory handle from IndexedDB */
  pick: (startIn) => /** @type {typeof globalThis & { showDirectoryPicker: (opts: object) => Promise<FileSystemDirectoryHandle> }} */ (globalThis).showDirectoryPicker({ id: "passbridge-folder", mode: "readwrite", ...(startIn ? { startIn } : {}) }),
  isSource: looksLikeSource,
  /** @param {any} folder */
  isOwn: (folder) => isOwnFolder(folder, readBack),
};

// the share of the bar each step fills
/** @type {Record<string, number[]>} */
const SPAN = { download: [0, 0.45], verify: [0.45, 0.5], write: [0.5, 0.95], restart: [1, 1] };

function UpdateApp() {
  const locale = useLocale();
  const installed = chrome.runtime.getManifest().version;
  const [phase, setPhase] = useState("checking");
  const [release, setRelease] = useState(/** @type {{ version?: string, pageUrl?: string, zipUrl?: string, sigUrl?: string, digest?: string, size?: number } | null} */ (null));
  const [folderName, setFolderName] = useState("");
  const [step, setStep] = useState("download");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(/** @type {{ message: string, restored: boolean } | null} */ (null));
  const [expected, setExpected] = useState("");
  const [native, setNative] = useState(false);

  // once the user picks the update without the helper, Retry keeps that choice for this visit
  const noHelper = useRef(false);

  async function check(skipHelper = false) {
    if (skipHelper) noHelper.current = true;
    setPhase("checking");
    setError(null);
    if (await hasInterruptedUpdate()) return setPhase("interrupted");
    // the background opens ?updated=<version> after the restart; only the running version proves it landed
    const target = new URLSearchParams(location.search).get("updated");
    if (target !== null) {
      history.replaceState(null, "", location.pathname);
      setExpected(target);
      return setPhase(target === installed ? "done" : "stale");
    }
    const found = await latestRelease(installed);
    setFolderName((await folderStore.get())?.name || "");
    setRelease(found.version ? found : null);
    if (!found.ok) return setPhase(found.error);
    const route = updateRoute({ windows: isWindows(), helper: await updaterAvailable(), noHelper: noHelper.current });
    if (route === "helper") return setPhase("helper");
    if (route === "folder" && typeof /** @type {any} */ (globalThis).showDirectoryPicker !== "function") return setPhase("unsupported");
    setNative(route === "native");
    setPhase("ready");
  }

  useEffect(() => {
    check();
  }, []);

  // closing the tab mid-swap would leave the journal behind; the restart itself must not ask
  useEffect(() => {
    if (phase !== "working" || step === "restart") return;
    /** @param {Event} e */
    const hold = (e) => e.preventDefault();
    addEventListener("beforeunload", hold);
    return () => removeEventListener("beforeunload", hold);
  }, [phase, step]);

  /** @param {string} key @param {boolean} [restored] */
  function fail(key, restored = false) {
    setError({ message: t(ERROR_KEYS[key] || ERROR_KEYS.write), restored });
    setPhase("failed");
  }

  /** @param {string} id @param {number} [share] */
  function advance(id, share = 0) {
    const [from, to] = SPAN[id];
    setStep(id);
    setProgress(from + (to - from) * share);
  }

  async function update() {
    if (native) return installNative();
    const locked = await withUpdateLock(install);
    if (!locked.ok) fail(locked.error);
  }

  // the background takes the update lock, downloads, verifies and hands the zip to the helper, then restarts
  async function installNative() {
    setPhase("working");
    advance("download");
    const res = await chrome.runtime.sendMessage({ type: "installUpdate" }).catch(() => null);
    if (!res?.ok) {
      setError({ message: res?.error || t(ERROR_KEYS.write), restored: false });
      return setPhase("failed");
    }
    advance("restart");
  }

  async function install() {
    // install only runs once a release was found (the Update button shows in the ready phase)
    const rel = /** @type {{ version: string, zipUrl: string, sigUrl: string, digest: string, size: number }} */ (release);
    const access = await folderForUpdate(folderDeps);
    if (!access.ok) return fail(access.error);
    setFolderName(access.folder.name);
    setPhase("working");
    advance("download");
    const got = await downloadRelease(rel, {
      onProgress: (n, total) => (n < total ? advance("download", n / total) : advance("verify")),
    });
    if (!got.ok) return fail(got.error);
    let files;
    try {
      files = await readZip(got.zip);
    } catch {
      return fail("zip");
    }
    if (manifestProblem(files, { key: /** @type {string} */ (chrome.runtime.getManifest().key), version: rel.version })) return fail("mismatch");
    advance("write");
    await setUpdating(true);
    try {
      await applyUpdate(access.folder, files, { version: rel.version, onProgress: (n, total) => advance("write", n / total) });
    } catch (e) {
      if (await hasInterruptedUpdate()) return setPhase("interrupted");
      return fail("write", !!e?.restored);
    }
    advance("restart");
    await setUpdating(false);
    await markUpdatedTo(rel.version);
    setTimeout(() => chrome.runtime.reload(), 600);
  }

  async function restore() {
    const locked = await withUpdateLock(rollBack);
    if (!locked.ok) fail(locked.error);
  }

  async function rollBack() {
    const access = await folderForUpdate(folderDeps);
    if (!access.ok) return fail(access.error);
    try {
      await recoverUpdate(access.folder);
    } catch {
      return fail("restore");
    }
    await setUpdating(false);
    chrome.runtime.reload();
  }

  async function changeFolder() {
    const picked = await pickFolder(folderDeps);
    if (picked.ok) setFolderName(picked.folder.name);
    else if (picked.error !== "cancelled") fail(picked.error);
  }

  return (
    <UpdateScreen
      phase={phase}
      installed={installed}
      expected={expected}
      release={release}
      folderName={folderName}
      step={step}
      progress={progress}
      error={error}
      onUpdate={update}
      onChangeFolder={changeFolder}
      onRetry={() => check()}
      native={native}
      onNoHelper={() => check(true)}
      helperUrl={HELPER_ZIP_URL}
      onRestore={restore}
    />
  );
}

followTheme();
void applyDocumentLanguage(document, "updTitle");
createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(<UpdateApp />);
