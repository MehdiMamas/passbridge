// the extension folder handle for the folder update. chrome drops the permission whenever the extension
// reloads, and asking again with requestPermission only offers Allow / Don't allow. a folder that comes
// through the picker also gets "Allow on every visit", so a lost permission reopens the picker at the kept
// folder: update, select, allow on every visit once, then every later update is one click.

/**
 * @param {{ store: { get: () => Promise<any>, set: (h: any) => Promise<void> }, pick: (startIn?: any) => Promise<any>, isOwn: (h: any) => Promise<boolean> }} deps
 * @param {any} [startIn]
 * @returns {Promise<{ ok: true, folder: any } | { ok: false, error: "cancelled" | "notown" }>}
 */
export async function pickFolder({ store, pick, isOwn }, startIn) {
  let folder;
  try {
    folder = await pick(startIn);
  } catch {
    return { ok: false, error: "cancelled" };
  }
  if (!(await isOwn(folder))) return { ok: false, error: "notown" };
  await store.set(folder);
  return { ok: true, folder };
}

/**
 * @param {{ store: { get: () => Promise<any>, set: (h: any) => Promise<void> }, pick: (startIn?: any) => Promise<any>, isOwn: (h: any) => Promise<boolean> }} deps
 * @returns {Promise<{ ok: true, folder: any } | { ok: false, error: "cancelled" | "notown" }>}
 */
export async function folderForUpdate(deps) {
  const saved = await deps.store.get();
  if (!saved || (await saved.queryPermission({ mode: "readwrite" })) !== "granted") return pickFolder(deps, saved || undefined);
  if (!(await deps.isOwn(saved))) return { ok: false, error: "notown" };
  return { ok: true, folder: saved };
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
  get: () => kv("readonly", (s) => s.get(KEY)).catch(() => null),
  set: (handle) => kv("readwrite", (s) => s.put(handle, KEY)),
};
