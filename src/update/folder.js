// the extension folder handle for the folder update. chrome drops the permission whenever the extension
// reloads, so a lost permission reopens the picker at the kept folder. "Allow on every visit" is offered only
// while chrome still holds the last grant, and closing the last extension tab clears it. the page that opens
// after an update still has it, so keepFolder asks there, and every later update is one click.

/** @param {any} folder */
const hasWriteAccess = async (folder) => (await folder.queryPermission({ mode: "readwrite" })) === "granted";

/**
 * @param {{ store: { get: () => Promise<any>, set: (h: any) => Promise<void> }, pick: (startIn?: any) => Promise<any>, isOwn: (h: any) => Promise<boolean>, isSource: (h: any) => Promise<boolean> }} deps
 * @param {any} [startIn]
 * @returns {Promise<{ ok: true, folder: any } | { ok: false, error: "cancelled" | "notsource" | "notown" }>}
 */
export async function pickFolder({ store, pick, isOwn, isSource }, startIn) {
  let folder;
  try {
    folder = await pick(startIn);
  } catch {
    return { ok: false, error: "cancelled" };
  }
  // checked first: the ownership probe writes a file, which a wrong folder must never get
  if (!(await isSource(folder))) return { ok: false, error: "notsource" };
  if (!(await isOwn(folder))) return { ok: false, error: "notown" };
  await store.set(folder);
  return { ok: true, folder };
}

/**
 * @param {{ store: { get: () => Promise<any>, set: (h: any) => Promise<void> }, pick: (startIn?: any) => Promise<any>, isOwn: (h: any) => Promise<boolean>, isSource: (h: any) => Promise<boolean> }} deps
 * @returns {Promise<{ ok: true, folder: any } | { ok: false, error: "cancelled" | "notsource" | "notown" }>}
 */
export async function folderForUpdate(deps) {
  const saved = await deps.store.get();
  if (!saved || !(await hasWriteAccess(saved))) return pickFolder(deps, saved || undefined);
  if (!(await deps.isSource(saved))) return { ok: false, error: "notsource" };
  if (!(await deps.isOwn(saved))) return { ok: false, error: "notown" };
  return { ok: true, folder: saved };
}

export async function canKeepFolder(store = folderStore) {
  const saved = await store.get();
  return !!saved && !(await hasWriteAccess(saved));
}

export async function keepFolder(store = folderStore) {
  const saved = await store.get();
  if (saved) await saved.requestPermission({ mode: "readwrite" });
}

const DB = "passbridge-update";
const KEY = "folder";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBTransactionMode} mode
 * @param {(s: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<any>}
 */
async function kv(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// the handle survives restarts in IndexedDB, its permission does not
export const folderStore = {
  get: () => kv("readonly", (/** @type {IDBObjectStore} */ s) => s.get(KEY)).catch(() => null),
  /** @param {any} handle */
  set: (handle) => kv("readwrite", (/** @type {IDBObjectStore} */ s) => s.put(handle, KEY)),
};
