// agent sign-in: a local program asks over a native host to fill a login or code into a tab.
// replies carry status and usernames only, never a password or a code.
import { getSettings, hostBlocked } from "./settings.js";

const HOST = "com.passbridge.agent";
const LOG_KEY = "agentLog";
const LOG_MAX = 200;
export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 10 * 60 * 1000;

// exact host or a subdomain of an entry, so github.com.evil.io and evilgithub.com stay out
export const hostAllowed = hostBlocked;

// sliding window, the caller passes the clock so tests need no timers
export function createLimiter(max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  let hits = [];
  return {
    take(now = Date.now()) {
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
    dump: () => hits.slice(),
    load(list) {
      hits = (Array.isArray(list) ? list : []).filter((t) => typeof t === "number");
    },
  };
}

// every reply goes through here: any key that could carry a secret is dropped at any depth
const SECRET_KEYS = /^(password|passwd|pass|code|otp|secret|token)$/i;
export function sanitizeReply(value) {
  if (Array.isArray(value)) return value.map(sanitizeReply);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = sanitizeReply(v);
    }
    return out;
  }
  return value;
}

const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const fail = (error, extra) => ({ ok: false, error, ...extra });

// the whole request flow, deps injected so it runs without chrome
export async function handleAgentRequest(msg, deps, limiter, now = Date.now()) {
  const op = msg?.op;
  const settings = await deps.getSettings();
  if (op === "status") {
    return { ok: true, paired: !!deps.client.ready, enabled: !!settings.agentSignIn, allowlist: settings.agentAllowlist || [] };
  }
  const base = { host: "", username: "" };
  const done = (reply, extra) => Object.assign(base, extra, { reply });
  if (!settings.agentSignIn) return done(fail("not_enabled"));
  if (!["logins", "sign_in", "fill_code"].includes(op)) return done(fail("unknown_op"));

  let tab = null;
  try {
    tab = await deps.getTab(Number(msg.tabId));
  } catch {}
  if (!tab || tab.id == null || !tab.url) return done(fail("no_tab"));
  const host = deps.hostnameOf(tab.url);
  base.host = host;
  if (!(await deps.isFillUrlAllowed(tab.url)) || !host || !hostAllowed(host, settings.agentAllowlist)) {
    return done(fail("not_allowed"));
  }
  if (op !== "logins" && !limiter.take(now)) return done(fail("rate_limited"));
  if (!deps.client.ready) return done(fail("needs_user"));

  try {
    const logins = deps.uniqueByUsername(await deps.siteLogins(tab.id, tab.url));
    const names = logins.map((l) => l.username);
    if (op === "logins") return done({ ok: true, domain: host, usernames: names });

    if (op === "sign_in") {
      if (!names.length) return done(fail("no_login"));
      let username = msg.username;
      if (username == null || username === "") {
        if (names.length > 1) return done(fail("choose_login", { usernames: names }));
        username = names[0];
      } else {
        const hit = names.find((n) => same(n, username));
        if (!hit) return done(fail("no_login"));
        username = hit;
      }
      base.username = username;
      const r = await deps.fillLoginOnTab(tab, username);
      if (!r?.filled) return done(fail(r?.reason || "fill_failed"));
      return done({ ok: true, domain: host, username: r.username || username }, { username: r.username || username });
    }

    // fill_code
    const r = await deps.fillCodeOnTab(tab);
    if (r?.username) base.username = r.username;
    if (!r?.filled) return done(fail(r?.reason || "fill_failed", r?.reason === "choose_code" ? { usernames: r.usernames } : undefined));
    return done({ ok: true, domain: host, username: r.username || "" });
  } catch {
    // a refused or timed-out read is the Touch ID case
    return done(fail("needs_user"));
  }
}

async function appendLog(entry) {
  try {
    const o = await chrome.storage.local.get(LOG_KEY);
    const list = Array.isArray(o[LOG_KEY]) ? o[LOG_KEY] : [];
    list.push(entry);
    await chrome.storage.local.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
  } catch {}
}

export function initAgent(deps) {
  const limiter = createLimiter();
  let port = null;
  let timer = null;
  let delay = 1000;
  let loaded = false;

  async function loadLimiter() {
    if (loaded) return;
    loaded = true;
    try {
      const o = await chrome.storage.session.get("agentHits");
      limiter.load(o.agentHits);
    } catch {}
  }
  const saveLimiter = () => {
    try {
      chrome.storage.session.set({ agentHits: limiter.dump() });
    } catch {}
  };

  async function onRequest(p, msg) {
    const id = msg?.id;
    await loadLimiter();
    let out;
    try {
      out = await handleAgentRequest(msg, deps, limiter);
    } catch {
      out = { reply: fail("fill_failed"), host: "", username: "" };
    }
    saveLimiter();
    // status returns a plain reply, the rest wrap one with log fields
    const reply = out.reply ? out.reply : out;
    const safe = sanitizeReply({ ...reply, id });
    try {
      p.postMessage(safe);
    } catch {}
    if (msg?.op !== "status") {
      appendLog({ t: Date.now(), op: String(msg?.op || ""), host: out.host || "", username: out.username || "", result: safe.ok ? "ok" : safe.error });
    }
  }

  function connect() {
    if (port) return;
    try {
      const p = chrome.runtime.connectNative(HOST);
      port = p;
      p.onMessage.addListener((m) => onRequest(p, m));
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port === p) port = null;
        schedule();
      });
      // a connection that lasted resets the backoff
      setTimeout(() => {
        if (port === p) delay = 1000;
      }, 5000);
    } catch {
      port = null;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
    delay = Math.min(delay * 2, 60000);
  }

  async function sync() {
    const on = !!(await getSettings()).agentSignIn;
    if (!on) {
      clearTimeout(timer);
      delay = 1000;
      if (port) {
        const p = port;
        port = null;
        try {
          p.disconnect();
        } catch {}
      }
      return;
    }
    connect();
  }

  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.agentSignIn) {
      delay = 1000;
      sync();
    }
  });
  sync();
}
