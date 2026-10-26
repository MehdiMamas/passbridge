// reads a release zip in memory: stored and deflated entries only, no links, no encryption, no zip64,
// and no path that could leave the extension folder or touch the update's own work files

export const WORK_PREFIX = ".update-";
const MAX_UNZIPPED = 256 * 1024 * 1024;

function unsafePath(path) {
  if (/^[a-z]:/i.test(path) || path.includes("\\")) return true;
  const parts = path.split("/");
  return parts.some((p) => p === "" || p === "." || p === "..") || parts[0].startsWith(WORK_PREFIX);
}

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// the release has to carry this install's key, or chrome would load it under another id, and the version it was offered as
/**
 * @param {Array<{ path: string, data: Uint8Array }>} files
 * @param {{ key: string, version: string }} expected
 * @returns {"manifest" | "key" | "version" | null}
 */
export function manifestProblem(files, { key, version }) {
  const entry = files.find((f) => f.path === "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(entry?.data));
  } catch {
    return "manifest";
  }
  if (!manifest || typeof manifest !== "object") return "manifest";
  if (!key || manifest.key !== key) return "key";
  if (manifest.version !== version) return "version";
  return null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{ path: string, data: Uint8Array }>>}
 */
export async function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const names = new TextDecoder("utf-8", { fatal: true });
  const files = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const packed = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const mode = v.getUint32(p + 38, true) >>> 16;
    const local = v.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (flags & 1) throw new Error(`encrypted entry ${name}`);
    if (packed === 0xffffffff || size === 0xffffffff) throw new Error(`zip64 entry ${name}`);
    if ((mode & 0o170000) === 0o120000) throw new Error(`link ${name}`);
    const path = name.endsWith("/") ? name.slice(0, -1) : name;
    if (unsafePath(path)) throw new Error(`unsafe path ${name}`);
    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method} in ${name}`);
    total += size;
    if (total > MAX_UNZIPPED) throw new Error("too large");
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header ${name}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + packed);
    const data = method === 0 ? raw.slice() : await inflate(raw);
    if (data.length !== size) throw new Error(`size mismatch in ${name}`);
    files.push({ path, data });
  }
  return files;
}
