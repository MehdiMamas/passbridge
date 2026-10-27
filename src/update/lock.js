// one update at a time across every open PassBridge page: the web lock is shared by the whole extension
export const UPDATE_LOCK = "passbridge-update";
export const BUSY_MESSAGE = "An update is already running in another PassBridge page.";

/**
 * @template T
 * @param {() => Promise<T>} run
 * @param {{ request: (name: string, opts: object, cb: (lock: object | null) => Promise<any>) => Promise<any> }} [locks]
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: "busy" }>}
 */
export async function withUpdateLock(run, locks = globalThis.navigator?.locks) {
  // Node before 24 (unit tests in CI) has no web locks; every extension page does
  if (!locks) return { ok: true, value: await run() };
  return locks.request(UPDATE_LOCK, { ifAvailable: true }, async (lock) => (lock ? { ok: true, value: await run() } : { ok: false, error: "busy" }));
}
