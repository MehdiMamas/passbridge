import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { UpdateScreen } from "./update-screen.jsx";
import { markUpdatedTo } from "../update/check.js";
import { downloadRelease, latestRelease } from "../update/release.js";
import { manifestProblem, readZip } from "../update/zip.js";
import { applyUpdate, hasInterruptedUpdate, isOwnFolder, looksLikeSource, recoverUpdate, setUpdating } from "../update/files.js";
import { BUSY_MESSAGE, withUpdateLock } from "../update/lock.js";
import { HELPER_ZIP_URL, helperFirst, isWindows } from "../update/platform.js";
import { updaterAvailable } from "../update/install.js";
import { folderForUpdate, folderStore, pickFolder } from "../update/folder.js";

const ERRORS = {
  cancelled: "No folder was chosen.",
  notsource: "That folder doesn't hold the PassBridge source (no PassBridge manifest.json). Choose the folder loaded in chrome://extensions.",
  busy: BUSY_MESSAGE,
  notown: "That folder isn't the one PassBridge runs from. Choose the folder loaded in chrome://extensions.",
  download: "Couldn't download the update.",
  verify: "The update failed its signature check.",
  zip: "The update file is damaged.",
  mismatch: "The update doesn't belong to this install.",
  write: "Couldn't write the new files.",
  restore: "Couldn't restore the previous version.",
};

// the running extension serves its folder straight from disk, so this reads what is there now
const readBack = (name) => fetch(chrome.runtime.getURL(name), { cache: "no-store" }).then((r) => (r.ok ? r.text() : null), () => null);

const folderDeps = {
  store: folderStore,
  pick: (startIn) => showDirectoryPicker({ id: "passbridge-folder", mode: "readwrite", ...(startIn ? { startIn } : {}) }),
  isSource: looksLikeSource,
  isOwn: (folder) => isOwnFolder(folder, readBack),
};

// the share of the bar each step fills
const SPAN = { download: [0, 0.45], verify: [0.45, 0.5], write: [0.5, 0.95], restart: [1, 1] };

function UpdateApp() {
  const installed = chrome.runtime.getManifest().version;
  const [phase, setPhase] = useState("checking");
  const [release, setRelease] = useState(null);
  const [folderName, setFolderName] = useState("");
  const [step, setStep] = useState("download");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [expected, setExpected] = useState("");

  async function check(skipHelper = false) {
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
    if (typeof globalThis.showDirectoryPicker !== "function") return setPhase("unsupported");
    if (helperFirst({ windows: isWindows(), helper: await updaterAvailable(), skipped: skipHelper })) return setPhase("helper");
    setPhase("ready");
  }

  useEffect(() => {
    check();
  }, []);

  // closing the tab mid-swap would leave the journal behind; the restart itself must not ask
  useEffect(() => {
    if (phase !== "working" || step === "restart") return;
    const hold = (e) => e.preventDefault();
    addEventListener("beforeunload", hold);
    return () => removeEventListener("beforeunload", hold);
  }, [phase, step]);

  function fail(key, restored = false) {
    setError({ message: ERRORS[key] || ERRORS.write, restored });
    setPhase("failed");
  }

  function advance(id, share = 0) {
    const [from, to] = SPAN[id];
    setStep(id);
    setProgress(from + (to - from) * share);
  }

  async function update() {
    const locked = await withUpdateLock(install);
    if (!locked.ok) fail(locked.error);
  }

  async function install() {
    const access = await folderForUpdate(folderDeps);
    if (!access.ok) return fail(access.error);
    setFolderName(access.folder.name);
    setPhase("working");
    advance("download");
    const got = await downloadRelease(release, {
      onProgress: (n, total) => (n < total ? advance("download", n / total) : advance("verify")),
    });
    if (!got.ok) return fail(got.error);
    let files;
    try {
      files = await readZip(got.zip);
    } catch {
      return fail("zip");
    }
    if (manifestProblem(files, { key: chrome.runtime.getManifest().key, version: release.version })) return fail("mismatch");
    advance("write");
    await setUpdating(true);
    try {
      await applyUpdate(access.folder, files, { version: release.version, onProgress: (n, total) => advance("write", n / total) });
    } catch (e) {
      if (await hasInterruptedUpdate()) return setPhase("interrupted");
      return fail("write", !!e?.restored);
    }
    advance("restart");
    await setUpdating(false);
    await markUpdatedTo(release.version);
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
      onSkipHelper={() => check(true)}
      helperUrl={HELPER_ZIP_URL}
      onRestore={restore}
    />
  );
}

createRoot(document.getElementById("root")).render(<UpdateApp />);
