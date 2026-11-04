// Answers WebAuthn requests from the vault through chrome.webAuthenticationProxy.
// While attached the proxy suspends every other authenticator in the browser, so it is attached only
// while the active tab's site has a stored passkey, and detached otherwise.
// background.js calls register() at the top level, so the listeners exist each time the worker wakes,
// and refresh() on wake to work out again whether to be attached.

import { listPasskeys, passkeysForHost, readPasskey, savePasskey } from "./store.js";
import { allowsRecord, checkGet, createPasskey, requestError, signAssertion } from "./webauthn.js";

/** chrome.storage.local key: per machine, set from the options page. */
export const PASSKEY_SETTING = "passkeyStore";
const LIST_TTL_MS = 60000;
const DEFAULT_TIMEOUT_MS = 120000;

const hostOf = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol) ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * @param {{
 *   api: () => any, client: any, ensureConnected: () => Promise<void>,
 *   enabled: () => Promise<boolean>, getTab: () => Promise<{ id?: number, url?: string } | undefined>,
 *   notifyUnlock?: () => void, sleep?: (ms: number) => Promise<void>, pollMs?: number,
 * }} deps
 */
export function createPasskeyProxy({ api, client, ensureConnected, enabled, getTab, notifyUnlock = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 500 }) {
  let attached = null; // unknown after a wake
  let cache = null; // { at, list }
  let chain = Promise.resolve();
  let registeredOn = null;
  const canceled = new Set();

  const invalidate = () => {
    cache = null;
  };

  async function names() {
    if (cache && Date.now() - cache.at < LIST_TTL_MS) return cache.list;
    const tab = await getTab();
    const list = await listPasskeys(client, tab?.id ?? 0);
    cache = { at: Date.now(), list };
    return list;
  }

  async function wantAttached() {
    if (!(await enabled())) return false;
    const tab = await getTab();
    const host = hostOf(tab?.url);
    // a locked vault cannot be listed: keep what we have, else stay detached
    if (!host || !client.ready) return !!host && attached === true;
    try {
      return passkeysForHost(await names(), host).length > 0;
    } catch {
      return false;
    }
  }

  async function syncOnce() {
    const p = api();
    if (!p) return;
    const want = await wantAttached();
    if (want === attached) return;
    // attach() and detach() report a problem as a string; a repeat on the current state is harmless
    await (want ? p.attach() : p.detach());
    attached = want;
  }

  /** Attach if the feature is on and the active tab's site has a stored passkey, else detach. */
  function refresh() {
    chain = chain.then(syncOnce, syncOnce).catch(() => {});
    return chain;
  }

  async function detach() {
    invalidate();
    const p = api();
    chain = chain.then(async () => {
      if (p) await p.detach();
      attached = false;
    }).catch(() => {});
    return chain;
  }

  // wait for an unlocked vault, for as long as the request allows
  async function ready(deadline, id) {
    if (client.ready) return;
    notifyUnlock();
    await ensureConnected();
    while (!client.ready) {
      if (canceled.has(id)) throw requestError("NotAllowedError", "The request was canceled");
      if (Date.now() >= deadline) throw requestError("NotAllowedError", "Timed out waiting for the vault to unlock");
      await sleep(pollMs);
    }
  }

  const asError = (e) => (e && e.name && e.message !== undefined ? { name: e.name, message: String(e.message) } : { name: "NotAllowedError", message: String(e?.message || e) });

  async function finish(complete, id, run) {
    let out;
    try {
      out = { responseJson: await run() };
    } catch (e) {
      out = { error: asError(e) };
    }
    if (canceled.has(id)) return canceled.delete(id); // a canceled request cannot be completed
    await complete({ requestId: id, ...out });
  }

  async function onGet(req) {
    await finish((d) => api().completeGetRequest(d), req.requestId, async () => {
      const details = JSON.parse(req.requestDetailsJson);
      const { rpId } = checkGet(details);
      const deadline = Date.now() + (Number(details.timeout) > 0 ? Number(details.timeout) : DEFAULT_TIMEOUT_MS);
      await ready(deadline, req.requestId);
      const allowed = (details.allowCredentials || []).map((c) => String(c.id).slice(0, 8));
      const entries = (await names()).filter((p) => p.rpId === rpId && (!allowed.length || allowed.includes(p.idPrefix)));
      if (!entries.length) throw requestError("NotAllowedError", "No passkey for this site");
      const tab = await getTab();
      // the name only carries an 8-character prefix: confirm the full credential id after the read
      for (const entry of entries) {
        const read = await readPasskey(client, tab?.id ?? 0, entry);
        if (read && allowsRecord(details, read.record)) return signAssertion(details, read.record, { userVerified: read.userVerified });
      }
      throw requestError("NotAllowedError", "The stored passkey could not be read");
    });
  }

  async function onCreate(req) {
    await finish((d) => api().completeCreateRequest(d), req.requestId, async () => {
      const details = JSON.parse(req.requestDetailsJson);
      const deadline = Date.now() + (Number(details.timeout) > 0 ? Number(details.timeout) : DEFAULT_TIMEOUT_MS);
      await ready(deadline, req.requestId);
      const { record, responseJson } = await createPasskey(details);
      const tab = await getTab();
      const saved = await savePasskey(client, tab?.id ?? 0, record);
      invalidate();
      // never report a passkey the vault does not hold
      if (saved !== "saved") throw requestError("NotAllowedError", "The passkey could not be saved to the vault");
      return responseJson;
    });
  }

  /** Add the proxy's listeners once per API object; safe to call again after the permission is granted. */
  function register() {
    const p = api();
    if (!p || registeredOn === p) return;
    registeredOn = p;
    p.onCreateRequest.addListener((req) => void onCreate(req));
    p.onGetRequest.addListener((req) => void onGet(req));
    p.onIsUvpaaRequest.addListener((req) => void p.completeIsUvpaaRequest({ requestId: req.requestId, isUvpaa: true }));
    p.onRequestCanceled.addListener((id) => {
      canceled.add(id);
    });
  }

  return { register, refresh, detach, invalidate, onGet, onCreate };
}
