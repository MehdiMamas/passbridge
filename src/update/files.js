// swaps a verified release into the unpacked extension folder through a File System Access handle.
// every new file is staged first; the journal marks the point after which a failure needs a rollback;
// replaced and dropped files wait in the backup until the swap is through. dot names only, chrome
// reserves names starting with "_" and still loads the extension with these left behind.

import { WORK_PREFIX } from "./zip.js";

const STAGING = `${WORK_PREFIX}staging`;
const BACKUP = `${WORK_PREFIX}backup`;
export const JOURNAL = `${WORK_PREFIX}journal.json`;
const PROBE = `${WORK_PREFIX}probe`;

function split(path) {
  const parts = path.split("/");
  return { dirs: parts.slice(0, -1), name: parts.at(-1) };
}

async function dirAt(root, dirs, create) {
  let d = root;
  for (const part of dirs) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function fileAt(root, path) {
  const { dirs, name } = split(path);
  return (await dirAt(root, dirs, false)).getFileHandle(name);
}

async function writeFile(root, path, data) {
  const { dirs, name } = split(path);
  const w = await (await (await dirAt(root, dirs, true)).getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function removeFile(root, path) {
  const { dirs, name } = split(path);
  await (await dirAt(root, dirs, false)).removeEntry(name);
}

async function readText(root, path) {
  try {
    return await (await (await fileAt(root, path)).getFile()).text();
  } catch {
    return null;
  }
}

// move() renames in place where chrome has it, older versions copy and delete
async function moveFile(fromRoot, path, toRoot) {
  const handle = await fileAt(fromRoot, path);
  const { dirs, name } = split(path);
  if (typeof handle.move === "function") return handle.move(await dirAt(toRoot, dirs, true), name);
  await writeFile(toRoot, path, new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  await removeFile(fromRoot, path);
}

async function listFiles(d, prefix = "") {
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (!prefix && name.startsWith(WORK_PREFIX)) continue;
    if (h.kind === "directory") out.push(...(await listFiles(h, `${prefix}${name}/`)));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

async function pruneEmptyDirs(d, top = true) {
  let empty = true;
  for (const [name, h] of await Array.fromAsync(d.entries())) {
    if (top && name.startsWith(WORK_PREFIX)) {
      empty = false;
      continue;
    }
    if (h.kind === "directory" && (await pruneEmptyDirs(h, false))) await d.removeEntry(name);
    else empty = false;
  }
  return empty;
}

async function dropWork(root) {
  for (const name of [STAGING, BACKUP]) await root.removeEntry(name, { recursive: true }).catch(() => {});
  await root.removeEntry(JOURNAL).catch(() => {});
}

// puts every backed-up file back and drops the files the update added. safe to run again after a crash
async function rollback(root) {
  const journal = JSON.parse((await readText(root, JOURNAL)) || "{}");
  const backup = await root.getDirectoryHandle(BACKUP).catch(() => null);
  if (backup) for (const path of await listFiles(backup)) await moveFile(backup, path, root);
  for (const path of Array.isArray(journal.added) ? journal.added : []) await removeFile(root, path).catch(() => {});
  await dropWork(root);
  await pruneEmptyDirs(root);
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<boolean>}
 */
export async function recoverUpdate(root) {
  if ((await readText(root, JOURNAL)) !== null) {
    await rollback(root);
    return true;
  }
  await dropWork(root);
  return false;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {Array<{ path: string, data: Uint8Array }>} files
 * @param {{ version: string, onProgress?: (done: number, total: number) => void }} opts
 * @returns {Promise<void>}
 */
export async function applyUpdate(root, files, { version, onProgress }) {
  await recoverUpdate(root);
  const oldPaths = await listFiles(root);
  const oldSet = new Set(oldPaths);
  const newSet = new Set(files.map((f) => f.path));
  const added = files.map((f) => f.path).filter((p) => !oldSet.has(p));
  const removed = oldPaths.filter((p) => !newSet.has(p));
  const total = files.length * 2 + removed.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  let staging;
  try {
    staging = await root.getDirectoryHandle(STAGING, { create: true });
    for (const f of files) {
      await writeFile(staging, f.path, f.data);
      tick();
    }
  } catch (e) {
    await dropWork(root);
    throw Object.assign(new Error("staging failed", { cause: e }), { restored: false });
  }

  await writeFile(root, JOURNAL, JSON.stringify({ version, added, removed }));
  try {
    const backup = await root.getDirectoryHandle(BACKUP, { create: true });
    for (const f of files) {
      if (oldSet.has(f.path)) await moveFile(root, f.path, backup);
      await moveFile(staging, f.path, root);
      tick();
    }
    for (const path of removed) {
      await moveFile(root, path, backup);
      tick();
    }
  } catch (e) {
    // a rollback that fails too leaves the journal, so the next visit restores
    await rollback(root);
    throw Object.assign(new Error("swap failed", { cause: e }), { restored: true });
  }
  await dropWork(root);
  await pruneEmptyDirs(root);
}

// a running swap is marked in storage, so the journal is only looked for after a run that did not finish
// (a missing file still logs a load error in the console)
/**
 * @param {boolean} on
 * @returns {Promise<void>}
 */
export function setUpdating(on) {
  return on ? chrome.storage.local.set({ isUpdating: true }) : chrome.storage.local.remove("isUpdating");
}

/** @returns {Promise<boolean>} */
export async function hasInterruptedUpdate() {
  const { isUpdating } = await chrome.storage.local.get("isUpdating");
  if (!isUpdating) return false;
  const found = await fetch(chrome.runtime.getURL(JOURNAL), { cache: "no-store" }).then((r) => r.ok, () => false);
  if (!found) await setUpdating(false);
  return found;
}

// only a PassBridge source folder is ever written to: its manifest.json names the extension
/**
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<boolean>}
 */
export async function looksLikeSource(root) {
  try {
    return JSON.parse((await readText(root, "manifest.json")) || "null")?.name === "PassBridge";
  } catch {
    return false;
  }
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {(name: string) => Promise<string | null>} readBack
 * @returns {Promise<boolean>}
 */
export async function isOwnFolder(root, readBack) {
  const token = crypto.randomUUID();
  await writeFile(root, PROBE, token);
  try {
    return (await readBack(PROBE)) === token;
  } finally {
    await root.removeEntry(PROBE).catch(() => {});
  }
}
