// agent sign-in: a local program asks over a native host to fill a login into a tab.
// replies carry status and usernames only, never a password or a code.
import { SETTINGS_AREA, getSettings, hostBlocked } from "./settings.js";
import { hostOfSite, siteHosts } from "./session/password-search.js";

/**
 * Injected collaborators. Results are `any` where they are owned by background.js or the vault (shapes not typed there).
 * @typedef {object} AgentDeps
 * @property {() => Promise<any>} getSettings
 * @property {{ ready?: boolean }} client
 * @property {(opts: { ifNeeded?: boolean }) => Promise<any>} [pairStart] asks Apple for a pairing code
 * @property {(pin: string) => Promise<{ ok: boolean, state?: any, error?: string }>} [pairPin] checks the code
 * @property {(id: number) => Promise<any>} getTab
 * @property {(url: string) => any} hostnameOf the host, or null for an unparsable url
 * @property {(url: string) => Promise<boolean>} isFillUrlAllowed
 * @property {(host: string) => boolean | undefined} isLocalDevHost
 * @property {(tabId: number | undefined, url: string) => Promise<any[]>} siteLogins
 * @property {(logins: any[]) => any[]} uniqueByUsername
 * @property {(tab: any, username: string, opts: Record<string, unknown>) => Promise<any>} fillLoginOnTab
 * @property {(tabId: number | undefined, url: string, username: string, password: string) => Promise<any>} [saveLogin] adds a login, reports an unanswered Apple prompt as an error
 * @property {(host: string, username: string) => void} [notifySaved]
 * @property {() => Promise<string>} [platform] "mac", "win" or other, after the platform is known
 * @property {() => Promise<boolean>} [codeReaderOn] the per-profile code reader switch
 * @property {(tab: any) => Promise<{ frameId: number, host: string }[]>} [codeFrames]
 * @property {(tabId: number, frames: { frameId: number, host: string }[]) => Promise<{ frameId: number, host: string } | null>} [probeCodeField]
 * @property {(tabId: number, frame: { frameId: number, host: string }, code: string) => Promise<boolean>} [fillCode]
 * @property {(kind?: "pin") => Promise<{ ok: boolean, code?: string, error?: string }>} [readCode] kind "pin" reads the pairing code shown for an unlock
 * @property {(host: string, filled: boolean) => void} [notifyCode]
 */

const HOST = "com.passbridge.agent";
const LOG_KEY = "agentLog";
const LOG_MAX = 200;
const PIN_FAILS_KEY = "agentPinFails";
export const PIN_FAILS_MAX = 5;
export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const CODE_RATE_MAX = 3;
export const UNLOCK_RATE_MAX = 3;
// Apple sign-in hosts that may receive a verification code, matched exactly (no subdomains)
export const CODE_HOSTS = ["appleid.apple.com", "account.apple.com", "idmsa.apple.com", "www.icloud.com", "icloud.com"];

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

/**
 * @param {string} host
 */
export function isCodeHost(host) {
  return CODE_HOSTS.includes(String(host || "").toLowerCase());
}

// frames that may get a verification code: the top frame or a child, on the allowlist and an exact Apple sign-in host
/**
 * @param {any} frames webNavigation.getAllFrames result
 * @param {unknown[] | undefined} allowlist
 * @param {(url: string) => any} hostnameOf the host, or null for an unparsable url
 */
export function pickCodeFrames(frames, allowlist, hostnameOf) {
  /** @type {{ frameId: number, host: string }[]} */
  const out = [];
  for (const f of Array.isArray(frames) ? frames : []) {
    if (!f) continue;
    let host = "";
    try {
      host = hostnameOf(f.url);
    } catch {}
    if (host && hostAllowed(host, allowlist) && isCodeHost(host)) out.push({ frameId: f.frameId || 0, host });
  }
  return out;
}

// sliding window, the caller passes the clock so tests need no timers. entries are {t, op}
export function createLimiter(max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  /** @type {{ t: number, op: string }[]} */
  let hits = [];
  /**
   * @param {number} now
   * @param {string} op
   * @param {number} opMax
   */
  const ok = (now, op, opMax) => {
    hits = hits.filter((h) => now - h.t < windowMs);
    if (hits.length >= max) return false;
    if (opMax && hits.filter((h) => h.op === op).length >= opMax) return false;
    return true;
  };
  return {
    take(now = Date.now(), op = "", opMax = 0) {
      if (!ok(now, op, opMax)) return false;
      hits.push({ t: now, op });
      return true;
    },
    // the same question as take, nothing recorded
    peek: (now = Date.now(), op = "", opMax = 0) => ok(now, op, opMax),
    dump: () => hits.slice(),
    /**
     * @param {unknown} list
     */
    load(list) {
      hits = (Array.isArray(list) ? list : []).flatMap((h) => {
        if (typeof h === "number") return [{ t: h, op: "" }];
        if (h && typeof h === "object" && typeof h.t === "number") return [{ t: h.t, op: typeof h.op === "string" ? h.op : "" }];
        return [];
      });
    },
  };
}

// the one gate for the save op. the approval model is decided separately; a per-save prompt would plug in here
/**
 * @param {{ agentSave?: boolean } | null | undefined} settings
 */
export function agentSaveAllowed(settings) {
  return settings?.agentSave === true;
}

// what the request log keeps of a request: never the password
/**
 * @param {any} msg
 * @param {any} out handleAgentRequest result
 * @param {any} safe the sanitized reply
 * @param {number} [now]
 */
export function logEntry(msg, out, safe, now = Date.now()) {
  /** @type {Record<string, unknown>} */
  const entry = { t: now, op: String(msg?.op || ""), host: out?.host || "", username: out?.username || "", result: safe?.ok ? "ok" : safe?.reason || safe?.error };
  if (msg?.op === "save") {
    if (msg.tabId != null) entry.tabId = Number(msg.tabId);
    // the origin only, never the path or query
    if (msg.url != null) {
      try {
        entry.url = new URL(msg.url).origin;
      } catch {}
    }
  }
  return entry;
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

// wrong codes in a row, kept in session storage so a worker restart does not reset the lockout
async function pinFails() {
  try {
    const o = await chrome.storage.session.get(PIN_FAILS_KEY);
    return Number(o[PIN_FAILS_KEY]) || 0;
  } catch {
    return 0;
  }
}
/**
 * @param {number} n
 */
async function setPinFails(n) {
  try {
    await chrome.storage.session.set({ [PIN_FAILS_KEY]: n });
  } catch {}
}

// pairing from another device: no tab, no host. the pin is never logged or echoed
/**
 * @param {string} op
 * @param {any} msg
 * @param {AgentDeps} deps
 */
async function pair(op, msg, deps) {
  if (!deps.pairStart || !deps.pairPin) return fail("fill_failed");
  try {
    if (op === "pair_start") {
      if (deps.client.ready) return { ok: true, state: "paired" };
      await setPinFails(0);
      await deps.pairStart({ ifNeeded: true });
      return { ok: true, state: "needs_pin" };
    }
    if (typeof msg.pin !== "string" || !/^\d{6}$/.test(msg.pin)) return fail("bad_pin");
    if ((await pinFails()) >= PIN_FAILS_MAX) return fail("locked");
    const r = await deps.pairPin(msg.pin);
    if (r?.ok) {
      await setPinFails(0);
      return { ok: true, state: "paired" };
    }
    await setPinFails((await pinFails()) + 1);
    return fail("wrong_pin");
  } catch {
    return fail("fill_failed");
  }
}

// unlock: pair a locked store without a person. the pairing code goes from the relay's reader into pairPin and nowhere else:
// not into a reply, the Activity list, storage or a log
/**
 * @param {AgentDeps} deps
 * @param {ReturnType<typeof createLimiter>} limiter
 * @param {number} now
 * @param {(reply: any, extra?: Record<string, unknown>) => any} done
 */
async function unlock(deps, limiter, now, done) {
  if (!(await deps.codeReaderOn?.())) return done(fail("not_allowed", { reason: "code_reader_off" }));
  if ((await deps.platform?.()) !== "win") return done(fail("not_allowed", { reason: "win_only" }));
  if (!deps.pairStart || !deps.pairPin) return done(fail("fill_failed"));
  if (deps.client.ready) return done({ ok: true, state: "paired" });
  if ((await pinFails()) >= PIN_FAILS_MAX) return done(fail("locked"));
  if (!limiter.take(now, "unlock", UNLOCK_RATE_MAX)) return done(fail("rate_limited"));
  try {
    await deps.pairStart({ ifNeeded: true });
    const r = await deps.readCode?.("pin");
    if (!r?.ok) {
      const e = r?.error || "reader_failed";
      if (e === "code_reader_off") return done(fail("not_allowed", { reason: e }));
      if (e === "mac_only") return done(fail("not_allowed", { reason: "win_only" }));
      if (["busy", "no_prompt", "reader_missing"].includes(e)) return done(fail(e));
      return done(fail("reader_failed"));
    }
    if (typeof r.code !== "string" || !/^\d{6}$/.test(r.code)) return done(fail("reader_failed"));
    if (!(await deps.codeReaderOn?.())) return done(fail("not_allowed", { reason: "code_reader_off" }));
    const p = await deps.pairPin(r.code);
    if (p?.ok) {
      await setPinFails(0);
      return done({ ok: true, state: "paired" });
    }
    await setPinFails((await pinFails()) + 1);
    return done(fail("wrong_pin"));
  } catch {
    return done(fail("reader_failed"));
  }
}

// the code never leaves this function: it goes from the reader to the probed field and nowhere else
/**
 * @param {any} msg
 * @param {AgentDeps} deps
 * @param {ReturnType<typeof createLimiter>} limiter
 * @param {number} now
 * @param {any} settings
 * @param {{ host: string, username: string }} base
 * @param {(reply: any, extra?: Record<string, unknown>) => any} done
 */
async function verifyCode(msg, deps, limiter, now, settings, base, done) {
  if (!(await deps.codeReaderOn?.())) return done(fail("not_allowed", { reason: "code_reader_off" }));
  const platform = await deps.platform?.();
  if (platform !== "mac" && platform !== "win") return done(fail("not_allowed", { reason: "mac_only" }));
  if (msg.url != null) return done(fail("bad_request"));
  /** @type {any} */
  let tab = null;
  try {
    tab = await deps.getTab(Number(msg.tabId));
  } catch {}
  if (!tab || !tab.url || tab.id == null) return done(fail("no_tab"));
  const host = deps.hostnameOf(tab.url);
  base.host = host;
  if (msg.site != null) {
    const want = hostOfSite(msg.site);
    if (!host || !want || !onSiteOrSubdomain(host, want)) return done(fail("not_allowed", { reason: "site_mismatch" }));
  }
  if (!host || hostBlocked(host, settings.blockedDomains)) return done(fail("not_allowed"));
  // the every-site path never applies here
  if (!hostAllowed(host, settings.agentAllowlist) || !(await deps.isFillUrlAllowed(tab.url))) return done(fail("not_allowed"));
  if (!isCodeHost(host)) return done(fail("not_allowed", { reason: "not_apple_site" }));
  if (!limiter.peek(now, "verify_code", CODE_RATE_MAX)) return done(fail("rate_limited"));
  const frames = (await deps.codeFrames?.(tab)) || [];
  const frame = await deps.probeCodeField?.(tab.id, frames);
  if (!frame) return done(fail("no_field"));
  if (!limiter.take(now, "verify_code", CODE_RATE_MAX)) return done(fail("rate_limited"));
  try {
    const r = await deps.readCode?.();
    if (!r?.ok) {
      const e = r?.error || "reader_failed";
      if (e === "code_reader_off" || e === "mac_only" || e === "not_apple_site" || e === "site_mismatch") return done(fail("not_allowed", { reason: e }));
      if (e === "reader_permission") return done(fail("needs_user", { reason: "reader_permission" }));
      if (["busy", "no_prompt", "several_prompts", "not_configured", "reader_missing"].includes(e)) return done(fail(e));
      return done(fail("reader_failed"));
    }
    if (typeof r.code !== "string" || !/^\d{6}$/.test(r.code)) return done(fail("reader_failed"));
    if (!(await deps.codeReaderOn?.())) return done(fail("not_allowed", { reason: "code_reader_off" }));
    const filled = await deps.fillCode?.(tab.id, frame, r.code);
    deps.notifyCode?.(host, !!filled);
    if (!filled) return done(fail("fill_failed"));
    return done({ ok: true, domain: host, filled: true });
  } catch {
    return done(fail("reader_failed"));
  }
}

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
    return { ok: true, paired: !!deps.client.ready, enabled: !!settings.agentSignIn, allowlist: settings.agentAllowlist || [], allowAll: settings.agentAllowAll === true, save: agentSaveAllowed(settings) };
  }
  const base = { host: "", username: "" };
  /**
   * @param {any} reply
   * @param {Record<string, unknown>} [extra]
   */
  const done = (reply, extra) => Object.assign(base, extra, { reply });
  if (!settings.agentSignIn) return done(fail("not_enabled"));
  if (op === "pair_start" || op === "pair_pin") {
    if (!limiter.take(now)) return done(fail("rate_limited"));
    return done(await pair(op, msg, deps));
  }
  if (op === "unlock") return unlock(deps, limiter, now, done);
  if (op === "verify_code") return verifyCode(msg, deps, limiter, now, settings, base, done);
  if (!["logins", "sign_in", "save"].includes(op)) return done(fail("unknown_op"));
  if (op === "save" && !agentSaveAllowed(settings)) return done(fail("not_allowed", { reason: "save_off" }));
  /** @type {string} */
  const saveName = op === "save" && typeof msg.username === "string" ? msg.username.trim() : "";
  if (op === "save" && (!saveName || typeof msg.password !== "string" || !msg.password)) return done(fail("bad_request"));

  // save may name a site by url instead of a tab. both or neither is bad_request, and only save takes a url
  const urlMode = op === "save" && msg.url != null;
  if (op === "save" && (msg.url != null) === (msg.tabId != null)) return done(fail("bad_request"));
  if (op !== "save" && msg.url != null) return done(fail("bad_request"));
  if (urlMode) {
    let parsed = null;
    try {
      parsed = typeof msg.url === "string" ? new URL(msg.url) : null;
    } catch {}
    // a url that parses but is not https falls to the https check below (not_allowed)
    if (!parsed) return done(fail("bad_request"));
  }

  /** @type {{ id?: number, url?: string } | null} */
  let tab = null;
  if (urlMode) tab = { id: undefined, url: msg.url };
  else {
    try {
      tab = await deps.getTab(Number(msg.tabId));
    } catch {}
  }
  if (!tab || !tab.url || (tab.id == null && !urlMode)) return done(fail("no_tab"));
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
  if (op === "save") {
    // the setting is the gate, so no allowlist. https only, never a dev host
    if (!/^https:\/\//i.test(tab.url) || deps.isLocalDevHost(host)) return done(fail("not_allowed"));
  } else if (hostAllowed(host, settings.agentAllowlist)) {
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
    if (op === "save") {
      base.username = saveName;
      // add-only: an existing login is never touched
      if (names.some((n) => same(n, saveName))) return done(fail("exists"));
      if (!deps.saveLogin) return done(fail("fill_failed"));
      await deps.saveLogin(tab.id, tab.url, saveName, msg.password);
      deps.notifySaved?.(host, saveName);
      return done({ ok: true, domain: host, username: saveName });
    }
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
    const o = await chrome.storage.session.get(LOG_KEY);
    const list = Array.isArray(o[LOG_KEY]) ? o[LOG_KEY] : [];
    list.push(entry);
    await chrome.storage.session.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
  } catch {}
}

/**
 * A relay tells the extension whether it owns the endpoint ("active") or waits behind another browser ("standby").
 * @param {any} m
 * @returns {"active" | "standby" | "code" | null}
 */
export function relayEvent(m) {
  if (!m || typeof m !== "object" || "id" in m) return null;
  if (m.event === "code") return "code";
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
  // the log used to live in local storage; it is session-only now, so drop any old copy
  try {
    chrome.storage.local.remove(LOG_KEY).catch(() => {});
  } catch {}
  const limiter = createLimiter();
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  // the helper says on active/standby whether it can read codes (an older helper does not)
  let relayCode = false;
  // an older relay ignores kind and would press Allow on a code prompt: only a relay that says pin:true gets a pin read
  let relayPin = false;
  /** @type {{ rid: string, resolve: (r: { ok: boolean, code?: string, error?: string }) => void, timer: ReturnType<typeof setTimeout> } | null} */
  let codeRead = null;

  /**
   * @param {{ ok: boolean, code?: string, error?: string }} r
   */
  function finishRead(r) {
    const c = codeRead;
    if (!c) return;
    codeRead = null;
    clearTimeout(c.timer);
    c.resolve(r);
  }

  /** @returns {Promise<{ ok: boolean, code?: string, error?: string }>} */
  function readCode(/** @type {"pin" | undefined} */ kind) {
    if (codeRead) return Promise.resolve({ ok: false, error: "busy" });
    if (kind === "pin" && !relayPin) return Promise.resolve({ ok: false, error: "reader_missing" });
    if (!port || !relayCode) return Promise.resolve({ ok: false, error: port ? "reader_missing" : "reader_failed" });
    const p = port;
    return new Promise((resolve) => {
      const rid = crypto.randomUUID();
      const timer = setTimeout(() => finishRead({ ok: false, error: "reader_failed" }), kind === "pin" ? 40000 : 85000);
      codeRead = { rid, resolve, timer };
      try {
        p.postMessage(kind === "pin" ? { cmd: "read_code", rid, kind } : { cmd: "read_code", rid });
      } catch {
        finishRead({ ok: false, error: "reader_failed" });
      }
    });
  }
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
      out = await handleAgentRequest(msg, { ...deps, readCode }, limiter);
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
      appendLog(logEntry(msg, out, safe));
    }
  }

  function connect() {
    if (port) return;
    try {
      const p = chrome.runtime.connectNative(HOST);
      port = p;
      p.onMessage.addListener((m) => {
        const ev = relayEvent(m);
        if (ev === "code") {
          // only the read in flight; any other code event is dropped
          if (codeRead && m.rid === codeRead.rid) finishRead({ ok: m.ok === true, code: m.code, error: m.error });
        } else if (ev) {
          relayCode = m.code === true;
          relayPin = m.pin === true;
          setRelay(ev);
        } else onRequest(p, m);
      });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finishRead({ ok: false, error: "reader_failed" });
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
    if (area === "local" && changes.agentCodeReader && changes.agentCodeReader.newValue !== true && codeRead) {
      try {
        port?.postMessage({ cmd: "cancel_code", rid: codeRead.rid });
      } catch {}
      finishRead({ ok: false, error: "code_reader_off" });
    }
    if (area === SETTINGS_AREA && changes.agentSignIn) {
      delay = 1000;
      sync();
    }
  });
  sync();
}
