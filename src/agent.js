// agent sign-in: a local program asks over a native host to fill a login into a tab.
// replies carry status and usernames only, never a password or a code.
import { SETTINGS_AREA, getSettings, hostBlocked } from "./settings.js";
import { hostOfSite, siteHosts } from "./session/password-search.js";

/**
 * Injected collaborators. Results are `any` where they are owned by background.js or the vault (shapes not typed there).
 * @typedef {object} AgentDeps
 * @property {() => Promise<any>} getSettings
 * @property {{ ready?: boolean }} client
 * @property {(id: number) => Promise<any>} getTab
 * @property {(url: string) => any} hostnameOf the host, or null for an unparsable url
 * @property {(url: string) => Promise<boolean>} isFillUrlAllowed
 * @property {(host: string) => boolean | undefined} isLocalDevHost
 * @property {(tabId: number, url: string) => Promise<any[]>} siteLogins
 * @property {(logins: any[]) => any[]} uniqueByUsername
 * @property {(tab: any, username: string, opts: Record<string, unknown>) => Promise<any>} fillLoginOnTab
 */

const HOST = "com.passbridge.agent";
const LOG_KEY = "agentLog";
const LOG_MAX = 200;
export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 10 * 60 * 1000;

// exact host or a subdomain of an entry, so github.com.evil.io and evilgithub.com stay out
export const hostAllowed = hostBlocked;

// the host is the site or one of its subdomains. a site with no dot (com, localhost) matches itself only
/**
 * @param {string} host
 * @param {string} site
 */
export function onSiteOrSubdomain(host, site) {
  return host === site || (site.includes(".") && host.endsWith("." + site));
}

// a login is saved for this host: a saved site, a subdomain of it, or the saved www. host without its www.
/**
 * @param {string | null | undefined} host
 * @param {any} sites saved-site list from the vault, shape owned by session/password-search.js
 */
export function loginSavedFor(host, sites) {
  if (!host) return false;
  return siteHosts(sites).some((s) => onSiteOrSubdomain(host, s) || host === s.replace(/^www\./, ""));
}

// child frames the agent may fill: a real child (not the top frame) whose own host is on the allowlist,
// e.g. idmsa.apple.com under apple.com. frames are {frameId, url} from webNavigation.getAllFrames
/**
 * @param {any} frames webNavigation.getAllFrames result
 * @param {unknown[] | undefined} allowlist
 * @param {(url: string) => any} hostnameOf the host, or null for an unparsable url
 */
export function pickAllowedFrames(frames, allowlist, hostnameOf) {
  /** @type {{ frameId: number, host: string }[]} */
  const out = [];
  for (const f of Array.isArray(frames) ? frames : []) {
    if (!f || !f.frameId) continue;
    let host = "";
    try {
      host = hostnameOf(f.url);
    } catch {}
    if (host && hostAllowed(host, allowlist)) out.push({ frameId: f.frameId, host });
  }
  return out;
}

// sliding window, the caller passes the clock so tests need no timers
export function createLimiter(max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  /** @type {number[]} */
  let hits = [];
  return {
    take(now = Date.now()) {
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
    dump: () => hits.slice(),
    /**
     * @param {unknown} list
     */
    load(list) {
      hits = (Array.isArray(list) ? list : []).filter((t) => typeof t === "number");
    },
  };
}

// every reply goes through here: any key that could carry a secret is dropped at any depth
const SECRET_KEYS = /^(password|passwd|pass|code|otp|secret|token)$/i;
/**
 * @param {any} value reply JSON, any shape
 * @returns {any}
 */
export function sanitizeReply(value) {
  if (Array.isArray(value)) return value.map(sanitizeReply);
  if (value && typeof value === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = sanitizeReply(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
/**
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
const fail = (error, extra) => ({ ok: false, error, ...extra });

// the whole request flow, deps injected so it runs without chrome
/**
 * @param {any} msg request from the native host, any JSON
 * @param {AgentDeps} deps
 * @param {ReturnType<typeof createLimiter>} limiter
 * @param {number} [now]
 * @returns {Promise<any>} a plain reply for status, else { reply, host, username }
 */
export async function handleAgentRequest(msg, deps, limiter, now = Date.now()) {
  const op = msg?.op;
  const settings = await deps.getSettings();
  if (op === "status") {
    return { ok: true, paired: !!deps.client.ready, enabled: !!settings.agentSignIn, allowlist: settings.agentAllowlist || [], allowAll: settings.agentAllowAll === true };
  }
  const base = { host: "", username: "" };
  /**
   * @param {any} reply
   * @param {Record<string, unknown>} [extra]
   */
  const done = (reply, extra) => Object.assign(base, extra, { reply });
  if (!settings.agentSignIn) return done(fail("not_enabled"));
  if (!["logins", "sign_in"].includes(op)) return done(fail("unknown_op"));

  /** @type {{ id?: number, url?: string } | null} */
  let tab = null;
  try {
    tab = await deps.getTab(Number(msg.tabId));
  } catch {}
  if (!tab || tab.id == null || !tab.url) return done(fail("no_tab"));
  const host = deps.hostnameOf(tab.url);
  base.host = host;
  // an agent that names its site must be on it
  if (msg.site != null) {
    const want = hostOfSite(msg.site);
    if (!host || !want || !onSiteOrSubdomain(host, want)) return done(fail("not_allowed", { reason: "site_mismatch" }));
  }
  if (!host || hostBlocked(host, settings.blockedDomains)) return done(fail("not_allowed"));
  // every-site: the setting is on, https only, never a dev host. what it fills is limited to logins saved for this host
  let everySite = false;
  if (hostAllowed(host, settings.agentAllowlist)) {
    if (!(await deps.isFillUrlAllowed(tab.url))) return done(fail("not_allowed"));
  } else if (settings.agentAllowAll === true && /^https:\/\//i.test(tab.url) && !deps.isLocalDevHost(host)) {
    everySite = true;
  } else {
    return done(fail("not_allowed"));
  }
  if (op !== "logins" && !limiter.take(now)) return done(fail("rate_limited"));
  if (!deps.client.ready) return done(fail("needs_user"));

  try {
    let found = await deps.siteLogins(tab.id, tab.url);
    if (everySite) found = found.filter((l) => loginSavedFor(host, l.saved));
    const logins = deps.uniqueByUsername(found);
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
      const r = await deps.fillLoginOnTab(tab, username, everySite ? { savedOnly: true } : { frameAllowlist: settings.agentAllowlist });
      if (!r?.filled) return done(fail(r?.reason || "fill_failed"));
      return done({ ok: true, domain: host, username: r.username || username }, { username: r.username || username });
    }
  } catch {
    // a refused or timed-out read is the Touch ID case
    return done(fail("needs_user"));
  }
}

/**
 * @param {Record<string, unknown>} entry
 */
async function appendLog(entry) {
  try {
    const o = await chrome.storage.local.get(LOG_KEY);
    const list = Array.isArray(o[LOG_KEY]) ? o[LOG_KEY] : [];
    list.push(entry);
    await chrome.storage.local.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
  } catch {}
}

/**
 * A relay tells the extension whether it owns the endpoint ("active") or waits behind another browser ("standby").
 * @param {any} m
 * @returns {"active" | "standby" | null}
 */
export function relayEvent(m) {
  if (!m || typeof m !== "object" || "id" in m) return null;
  return m.event === "active" || m.event === "standby" ? m.event : null;
}

/**
 * @param {string | null} state
 */
const setRelay = (state) => {
  try {
    if (state) chrome.storage.session.set({ agentRelay: state });
    else chrome.storage.session.remove("agentRelay");
  } catch {}
};

/**
 * @param {AgentDeps} deps
 */
export function initAgent(deps) {
  const limiter = createLimiter();
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
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

  /**
   * @param {chrome.runtime.Port} p
   * @param {any} msg
   */
  async function onRequest(p, msg) {
    const id = msg?.id;
    await loadLimiter();
    /** @type {any} */
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
      appendLog({ t: Date.now(), op: String(msg?.op || ""), host: out.host || "", username: out.username || "", result: safe.ok ? "ok" : safe.reason || safe.error });
    }
  }

  function connect() {
    if (port) return;
    try {
      const p = chrome.runtime.connectNative(HOST);
      port = p;
      p.onMessage.addListener((m) => {
        const ev = relayEvent(m);
        if (ev) setRelay(ev);
        else onRequest(p, m);
      });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port === p) {
          port = null;
          setRelay(null);
        }
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
    if (area === SETTINGS_AREA && changes.agentSignIn) {
      delay = 1000;
      sync();
    }
  });
  sync();
}
