// shared driver plumbing: playwright, extension launch with throwaway profiles, the pierced menu, results

import { mkdtemp, readFile, rm } from "fs/promises";
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
export function build(kind, envName = "OP_EXT") {
  return process.env[envName] || join(HERE, ".builds", kind);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };

// static file server on 127.0.0.1; port 0 picks a free one
export async function serveStatic(dir, port = 0) {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\\/]+/, "");
    if (path.startsWith("..")) return res.writeHead(403).end();
    if (!path || /[\\/]$/.test(path)) path = join(path, "index.html");
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const open = [];

// openpw.test is the cross-origin host; map it so no hosts-file entry is needed
export async function launchExtension(ext) {
  const profile = await mkdtemp(join(tmpdir(), "pb-"));
  const entry = { profile, ctx: null };
  open.push(entry);
  entry.ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--headless=new",
      "--no-first-run",
      "--host-resolver-rules=MAP openpw.test 127.0.0.1",
    ],
  });
  entry.ctx.serviceWorkers()[0] || (await entry.ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  return entry.ctx;
}

async function cleanup() {
  for (const { ctx, profile } of open.splice(0)) {
    await ctx?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e) => {
      console.error(`could not remove profile ${profile}: ${e.message}`);
    });
  }
}

const results = [];
export function ok(name, cond, detail = "") {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
  return !!cond;
}

// runs a driver body, then always closes browsers and deletes their profiles
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

function attrs(node) {
  const a = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 2) a[list[i]] = list[i + 1];
  return a;
}

function textUnder(node) {
  const bits = [];
  const walk = (n) => {
    if (n.nodeName === "#text" && n.nodeValue?.trim()) bits.push(n.nodeValue.trim());
    for (const s of n.shadowRoots || []) walk(s);
    for (const c of n.children || []) walk(c);
  };
  for (const s of node?.shadowRoots || []) walk(s);
  for (const c of node?.children || []) walk(c);
  return bits.join(" ");
}

const sessions = new WeakMap();
async function cdp(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

// The menu is a closed shadow root inside a popover host, which locators can't enter.
// CDP DOM.getDocument with pierce:true can, so read text and click by box coordinates.
// Node ids go stale once the menu re-renders, so take a fresh view after every action.
export async function pierced(page) {
  const client = await cdp(page);
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = [];
  (function walk(node) {
    nodes.push(node);
    for (const s of node.shadowRoots || []) walk(s);
    if (node.contentDocument) walk(node.contentDocument);
    for (const c of node.children || []) walk(c);
  })(root);
  const host = nodes.find((n) => attrs(n)["data-passbridge"] === "suggestions") || null;
  const under = [];
  if (host) {
    (function walk(n) {
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
    textOf: (node) => textUnder(node),
    find: (pred) => nodes.find(pred),
    // element in the menu whose own text contains the string (a row label, not the whole list)
    menuElement(str) {
      return under.find((n) => n.nodeType === 1 && (n.children || []).some((c) => c.nodeName === "#text" && c.nodeValue?.includes(str))) || null;
    },
    menuInput() {
      return under.find((n) => n.nodeName === "INPUT") || null;
    },
    async call(node, fn) {
      const { object } = await client.send("DOM.resolveNode", { nodeId: node.nodeId });
      const { result } = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: fn,
        returnByValue: true,
      });
      return result.value;
    },
    async box(node) {
      const { model } = await client.send("DOM.getBoxModel", { nodeId: node.nodeId });
      const [x1, y1, , , x2, y2] = model.border;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    },
    async click(node) {
      const b = await view.box(node);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    },
    async focus(node) {
      await client.send("DOM.focus", { nodeId: node.nodeId });
    },
  };
  return view;
}

export async function menuText(page) {
  return (await pierced(page)).text;
}

export async function menuShown(page) {
  return (await page.locator('[data-passbridge="suggestions"]').count()) > 0;
}

// click the menu row labelled str; false if the menu or the row is missing
export async function clickMenu(page, str) {
  const view = await pierced(page);
  const el = view.menuElement(str);
  if (!el) return false;
  await view.click(el);
  return true;
}

// type into the input inside the menu (the PIN box)
export async function typeInMenu(page, str) {
  const view = await pierced(page);
  const input = view.menuInput();
  if (!input) return false;
  await view.focus(input);
  await page.keyboard.type(str);
  return true;
}
