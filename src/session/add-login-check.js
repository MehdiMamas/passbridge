// After Add login, wait until the vault holds a NEW entry for the username.
// Bounded by elapsed time, not by a count of polls.

/**
 * @param {unknown} a
 * @param {unknown} b
 */
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * @param {unknown} entries
 * @param {unknown} username
 * @returns {number}
 */
export function countLogins(entries, username) {
  return (Array.isArray(entries) ? entries : []).filter((e) => same(e?.username, username)).length;
}

/**
 * Returns "saved", "locked" or "timeout".
 * @param {object} opts
 * @param {() => Promise<unknown>} opts.lookup
 * @param {unknown} opts.username
 * @param {number} [opts.before]
 * @param {() => boolean} [opts.isReady]
 * @param {number} [opts.deadlineMs]
 * @param {number} [opts.pollMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<unknown>} [opts.sleep]
 * @returns {Promise<"saved" | "locked" | "timeout">}
 */
export async function confirmLoginAdded({
  lookup,
  username,
  before = 0,
  isReady = () => true,
  deadlineMs = 30000,
  pollMs = 1000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const end = now() + deadlineMs;
  for (;;) {
    if (!isReady()) return "locked";
    try {
      if (countLogins(await lookup(), username) > before) return "saved";
    } catch {
      // a failed lookup counts as not found yet
    }
    if (!isReady()) return "locked";
    if (now() >= end) return "timeout";
    await sleep(pollMs);
  }
}

// Add login takes Passwords' new-login sheet when this username already shows for the site,
// so the helper never turns "add" into "update" another login (#170).
/**
 * @param {object} opts
 * @param {unknown} opts.username
 * @param {number} opts.before
 * @param {unknown} opts.canSheet
 * @returns {boolean}
 */
export function useNewLoginSheet({ username, before, canSheet }) {
  return !!String(username || "").trim() && before > 0 && canSheet === true;
}
