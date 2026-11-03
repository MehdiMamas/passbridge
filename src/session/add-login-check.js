// After Add login, wait until the vault holds a NEW entry for the username.
// Bounded by elapsed time, not by a count of polls.

const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

export function countLogins(entries, username) {
  return (Array.isArray(entries) ? entries : []).filter((e) => same(e?.username, username)).length;
}

// Returns "saved", "locked" or "timeout".
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
