// the folder-update engine on Chrome's own File System Access code. OPFS stands in for the picked folder,
// which Playwright cannot reach because it intercepts the picker (VERIFICATION.md has that manual run).
import { applyUpdate, looksLikeSource, recoverUpdate } from "../src/update/files.js";
import { readZip } from "../src/update/zip.js";

const enc = (s) => new TextEncoder().encode(s);

async function fresh(opfs, name) {
  await opfs.removeEntry(name, { recursive: true }).catch(() => {});
  return opfs.getDirectoryHandle(name, { create: true });
}

async function put(root, path, text) {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

async function entries(d, prefix = "") {
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind === "directory") {
      const inner = await entries(h, `${prefix}${name}/`);
      out.push(...(inner.length ? inner : [`${prefix}${name}/`]));
    } else out.push(`${prefix}${name}=${await (await h.getFile()).text()}`);
  }
  return out;
}

const snapshot = async (d) => (await entries(d)).sort().join();

async function oldInstall(opfs, name) {
  const root = await fresh(opfs, name);
  await put(root, "manifest.json", "v1");
  await put(root, "src/a.js", "A1");
  await put(root, "src/old.js", "O");
  await put(root, "legacy/x.js", "X");
  return root;
}

const OLD = "legacy/x.js=X,manifest.json=v1,src/a.js=A1,src/old.js=O";
const NEXT = [
  { path: "manifest.json", data: enc("v2") },
  { path: "src/a.js", data: enc("A2") },
  { path: "src/new/n.js", data: enc("N") },
];
const NEW = "manifest.json=v2,src/a.js=A2,src/new/n.js=N";

// returns [name, passed, detail] rows; zipBytes is a zip made by `zip -r` like release.yml, or null
window.runUpdateFsChecks = async (zipBytes) => {
  const rows = [];
  const check = (name, cond, detail = "") => rows.push([name, !!cond, String(detail)]);
  const opfs = await navigator.storage.getDirectory();

  const probe = await (await fresh(opfs, "probe")).getFileHandle("f", { create: true });
  check("files can be moved in place", typeof probe.move === "function");

  const named = await fresh(opfs, "named");
  await put(named, "manifest.json", '{"name":"PassBridge","version":"1.4.1"}');
  check("a folder with the PassBridge manifest is accepted", (await looksLikeSource(named)) === true);
  const other = await fresh(opfs, "other");
  await put(other, "manifest.json", '{"name":"Something Else"}');
  check("a folder with another extension's manifest is refused", (await looksLikeSource(other)) === false);
  check("a folder with a broken manifest is refused", (await looksLikeSource(await oldInstall(opfs, "broken"))) === false);
  check("an empty folder is refused", (await looksLikeSource(await fresh(opfs, "empty"))) === false);

  const applied = await oldInstall(opfs, "apply");
  await applyUpdate(applied, NEXT, { version: "1.4.2" });
  const after = await snapshot(applied);
  check("an update leaves exactly the new release", after === NEW, after);

  // the release ships a file where the old install has a folder, so the real file system refuses the move
  const clash = await oldInstall(opfs, "clash");
  const err = await applyUpdate(clash, [...NEXT, { path: "legacy", data: enc("now a file") }], { version: "1.4.2" }).then(() => null, (e) => e);
  const clashed = await snapshot(clash);
  check("a move the file system refuses is rolled back", err?.restored === true && clashed === OLD, `${err?.cause?.name}: ${clashed}`);

  const crashed = await oldInstall(opfs, "crash");
  for (const f of NEXT) await put(crashed, `.update-staging/${f.path}`, new TextDecoder().decode(f.data));
  await put(crashed, ".update-journal.json", JSON.stringify({ version: "1.4.2", added: ["src/new/n.js"], removed: ["legacy/x.js", "src/old.js"] }));
  await put(crashed, ".update-backup/src/a.js", "A1");
  await put(crashed, "src/a.js", "A2");
  await put(crashed, "src/new/n.js", "N");
  const recovered = await recoverUpdate(crashed);
  const restored = await snapshot(crashed);
  check("an update cut off halfway is rolled back", recovered === true && restored === OLD, restored);

  if (zipBytes) {
    const files = await readZip(new Uint8Array(zipBytes));
    const list = files.map((f) => `${f.path}=${new TextDecoder().decode(f.data).length}`).sort().join();
    check("a zip made by zip -r reads back", list === "manifest.json=19,src/a.js=600", list);
  }

  for (const name of ["probe", "named", "other", "broken", "empty", "apply", "clash", "crash"]) await opfs.removeEntry(name, { recursive: true }).catch(() => {});
  document.getElementById("log").textContent = rows.map(([n, p, d]) => `${p ? "PASS" : "FAIL"} ${n}${p ? "" : ` · ${d}`}`).join("\n");
  return rows;
};
