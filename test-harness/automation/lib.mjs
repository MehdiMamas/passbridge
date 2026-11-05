// shared driver plumbing: playwright, extension launch with throwaway profiles, the pierced menu, results

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createServer } from "http";
import { tmpdir } from "os";
import { dirname, extname, join, normalize } from "path";
import { fileURLToPath, pathToFileURL } from "url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(HERE, "shots");
export const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";

const pw = await import(process.env.OP_PW || pathToFileURL(join(HERE, "..", "..", "node_modules", "playwright", "index.js")).href);
export const chromium = (pw.default || pw).chromium;

// OP_EXT overrides the first build a driver loads
/**
 * @param {string} kind
 * @param {string} [envName]
 */
export function build(kind, envName = "OP_EXT") {
  return process.env[envName] || join(HERE, ".builds", kind);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };

// static file server on 127.0.0.1; port 0 picks a free one
/**
 * @param {string} dir
 * @param {number} [port]
 */
export async function serveStatic(dir, port = 0) {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(/** @type {string} */ (req.url), "http://x").pathname)).replace(/^[\\/]+/, "");
    if (path.startsWith("..")) return res.writeHead(403).end();
    if (!path || /[\\/]$/.test(path)) path = join(path, "index.html");
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { "content-type": /** @type {Record<string, string>} */ (TYPES)[extname(path)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(undefined)));
  return { url: `http://127.0.0.1:${/** @type {import("net").AddressInfo} */ (server.address()).port}`, close: () => new Promise((r) => server.close(r)) };
}

/** @type {{ profile: string, ctx: import("playwright").BrowserContext | null }[]} */
const open = [];

// openpw.test is the cross-origin host; map it so no hosts-file entry is needed
// opts.hosts maps a native-messaging host name to the executable that serves it; they are registered in the
// profile's NativeMessagingHosts folder for this extension only. opts.env is added to the browser's environment.
/**
 * @param {string} ext
 * @param {{ hosts?: Record<string, string>, env?: Record<string, string> }} [opts]
 * @returns {Promise<import("playwright").BrowserContext>}
 */
export async function launchExtension(ext, opts = {}) {
  // under WSLg Chrome would draw to the Wayland display instead of the virtual X one, get no frames, and every Playwright click would wait for "stable" until it timed out
  const { WAYLAND_DISPLAY: _wayland, ...env } = process.env;
  const profile = await mkdtemp(join(tmpdir(), "pb-"));
  const entry = { profile, ctx: null };
  open.push(entry);
  if (opts.hosts) {
    const dir = join(profile, "NativeMessagingHosts");
    await mkdir(dir, { recursive: true });
    const origin = `chrome-extension://${await extensionId(ext)}/`;
    for (const [name, path] of Object.entries(opts.hosts)) {
      await chmod(path, 0o755).catch(() => {});
      const manifest = { name, description: `${name} for tests`, path, type: "stdio", allowed_origins: [origin] };
      await writeFile(join(dir, `${name}.json`), JSON.stringify(manifest));
    }
  }
  const ctx = (entry.ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    env: { ...env, ...opts.env },
    locale: "en-US",
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--headless=new",
      "--no-first-run",
      "--host-resolver-rules=MAP openpw.test 127.0.0.1, MAP nopk.test 127.0.0.1",
    ],
  }));
  ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  return ctx;
}

// the id Chrome derives from the manifest key: first 16 bytes of the SHA-256 of the key, each nibble as a-p
/** @param {string} ext */
export async function extensionId(ext) {
  const { createHash } = await import("crypto");
  const { key } = JSON.parse(await readFile(join(ext, "manifest.json"), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

/** @type {(() => Promise<unknown>)[]} */
const cleanupHooks = [];
/** @param {() => Promise<unknown>} fn */
export const onCleanup = (fn) => cleanupHooks.push(fn);

async function cleanup() {
  for (const { ctx, profile } of open.splice(0)) {
    await Promise.race([ctx?.close().catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e) => {
      console.error(`could not remove profile ${profile}: ${e.message}`);
    });
  }
  for (const fn of cleanupHooks.splice(0)) await fn().catch(() => {});
}

/** @type {boolean[]} */
const results = [];
/**
 * @param {string} name
 * @param {unknown} cond
 * @param {string} [detail]
 */
export function ok(name, cond, detail = "") {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
  return !!cond;
}

// runs a driver body, then always closes browsers and deletes their profiles
/** @param {() => Promise<unknown>} fn */
export async function main(fn) {
  let crashed = false;
  try {
    await fn();
  } catch (e) {
    crashed = true;
    console.log(`FAIL driver threw -> ${e?.stack || e}`);
  } finally {
    await cleanup();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
  process.exit(crashed || failed || !results.length ? 1 : 0);
}

/** @typedef {{ nodeId: number, nodeName: string, nodeType: number, nodeValue?: string, attributes?: string[], children?: CdpNode[], shadowRoots?: CdpNode[], contentDocument?: CdpNode }} CdpNode */

/** @param {CdpNode} node */
function attrs(node) {
  /** @type {Record<string, string>} */
  const a = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 2) a[list[i]] = list[i + 1];
  return a;
}

/** @param {CdpNode | null | undefined} node */
function textUnder(node) {
  /** @type {string[]} */
  const bits = [];
  /** @param {CdpNode} n */
  const walk = (n) => {
    if (n.nodeName === "#text" && n.nodeValue?.trim()) bits.push(n.nodeValue.trim());
    for (const s of n.shadowRoots || []) walk(s);
    for (const c of n.children || []) walk(c);
  };
  for (const s of node?.shadowRoots || []) walk(s);
  for (const c of node?.children || []) walk(c);
  return bits.join(" ");
}

/** @type {WeakMap<import("playwright").Page, import("playwright").CDPSession>} */
const sessions = new WeakMap();
/** @param {import("playwright").Page} page */
async function cdp(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return /** @type {import("playwright").CDPSession} */ (sessions.get(page));
}

// The menu is a closed shadow root inside a popover host, which locators can't enter.
// CDP DOM.getDocument with pierce:true can, so read text and click by box coordinates.
// Node ids go stale once the menu re-renders, so take a fresh view after every action.
/** @param {import("playwright").Page} page */
export async function pierced(page) {
  const client = await cdp(page);
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  /** @type {CdpNode[]} */
  const nodes = [];
  (function walk(/** @type {CdpNode} */ node) {
    nodes.push(node);
    for (const s of node.shadowRoots || []) walk(s);
    if (node.contentDocument) walk(node.contentDocument);
    for (const c of node.children || []) walk(c);
  })(root);
  const host = nodes.find((n) => attrs(n)["data-passbridge"] === "suggestions") || null;
  /** @type {CdpNode[]} */
  const under = [];
  if (host) {
    (function walk(/** @type {CdpNode} */ n) {
      under.push(n);
      for (const s of n.shadowRoots || []) walk(s);
      for (const c of n.children || []) walk(c);
    })(host);
  }
  const view = {
    client,
    nodes,
    host,
    attrs,
    text: host ? textUnder(host).replace(/\s+/g, " ").trim() : "",
    textOf: (/** @type {CdpNode} */ node) => textUnder(node),
    find: (/** @type {(n: CdpNode) => boolean} */ pred) => nodes.find(pred),
    // element in the menu whose own text contains the string (a row label, not the whole list)
    /** @param {string} str */
    menuElement(str) {
      return under.find((n) => n.nodeType === 1 && (n.children || []).some((c) => c.nodeName === "#text" && c.nodeValue?.includes(str))) || null;
    },
    menuInput() {
      return under.find((n) => n.nodeName === "INPUT") || null;
    },
    /** @param {CdpNode} node @param {string} fn */
    async call(node, fn) {
      const { object } = await client.send("DOM.resolveNode", { nodeId: node.nodeId });
      const { result } = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: fn,
        returnByValue: true,
      });
      return result.value;
    },
    /** @param {CdpNode} node */
    async box(node) {
      const { model } = await client.send("DOM.getBoxModel", { nodeId: node.nodeId });
      const [x1, y1, , , x2, y2] = model.border;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    },
    /** @param {CdpNode} node */
    async click(node) {
      const b = await view.box(node);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    },
    /** @param {CdpNode} node */
    async focus(node) {
      await client.send("DOM.focus", { nodeId: node.nodeId });
    },
  };
  return view;
}

/** @param {import("playwright").Page} page */
export async function menuText(page) {
  return (await pierced(page)).text;
}

/** @param {import("playwright").Page} page */
export async function menuShown(page) {
  return (await page.locator('[data-passbridge="suggestions"]').count()) > 0;
}

// click the menu row labelled str; false if the menu or the row is missing
/**
 * @param {import("playwright").Page} page
 * @param {string} str
 */
export async function clickMenu(page, str) {
  const view = await pierced(page);
  const el = view.menuElement(str);
  if (!el) return false;
  await view.click(el);
  return true;
}

// type into the input inside the menu (the PIN box)
/**
 * @param {import("playwright").Page} page
 * @param {string} str
 */
export async function typeInMenu(page, str) {
  const view = await pierced(page);
  const input = view.menuInput();
  if (!input) return false;
  await view.focus(input);
  await page.keyboard.type(str);
  return true;
}
