// @ts-check
// after an extension reload or update chrome leaves the old content script on open pages with a dead
// runtime, and does not inject the new one. the background re-injects, the old copy removes its UI.

export const REPLACED_EVENT = "passbridge:replaced";

/** @param {unknown} err */
export function isInvalidated(err) {
  return /context invalidated|receiving end does not exist/i.test(String(/** @type {any} */ (err)?.message ?? err));
}

/**
 * @param {{ win?: Window, runtime?: any, hostSelector?: string }} [opts]
 */
export function createLifecycle({ win = window, runtime = globalThis.chrome?.runtime, hostSelector = "[data-passbridge-save],[data-passbridge-totp],[data-passbridge-host],[data-passbridge-icon]" } = {}) {
  const ctl = new AbortController();
  /** @type {Array<() => void>} */
  const cleanups = [];
  let dead = false;

  function alive() {
    try {
      return !dead && !!(runtime && runtime.id);
    } catch {
      return false;
    }
  }

  function teardown() {
    if (dead) return;
    dead = true;
    ctl.abort();
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch {}
    }
    try {
      win.document.querySelectorAll(hostSelector).forEach((el) => el.remove());
    } catch {}
  }

  /** @param {() => void} fn */
  function onTeardown(fn) {
    cleanups.push(fn);
  }

  /**
   * listener that goes away with teardown
   * @param {EventTarget} target
   * @param {string} type
   * @param {(e: any) => void} fn
   * @param {boolean | AddEventListenerOptions} [opts]
   */
  function listen(target, type, fn, opts) {
    if (dead) return;
    const o = typeof opts === "boolean" ? { capture: opts } : { ...opts };
    target.addEventListener(type, fn, { ...o, signal: ctl.signal });
  }

  // a rejected runtime call that says the context is gone ends this copy
  /** @param {unknown} err */
  function noteError(err) {
    if (isInvalidated(err) || !alive()) teardown();
  }

  // the newer copy announces itself first, then this one starts listening for the next
  win.dispatchEvent(new CustomEvent(REPLACED_EVENT));
  listen(win, REPLACED_EVENT, () => teardown());

  return { alive, teardown, onTeardown, listen, noteError, isDead: () => dead };
}

/**
 * re-inject the content scripts into open http(s) tabs
 * @param {{ tabs: any, scripting: any, runtime: any }} api
 */
export async function reinjectContentScripts({ tabs, scripting, runtime }) {
  const files = (runtime.getManifest().content_scripts || []).flatMap((c) => c.js || []);
  if (!files.length) return 0;
  let tabList = [];
  try {
    tabList = await tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return 0;
  }
  let done = 0;
  for (const tab of tabList) {
    if (tab.id == null || !/^https?:/.test(tab.url || "https:")) continue;
    try {
      await scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files });
      done++;
    } catch {
      // restricted pages, discarded tabs and the web store refuse
    }
  }
  return done;
}
