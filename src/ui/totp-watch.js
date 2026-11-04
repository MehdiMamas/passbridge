import { totpRowMatches } from "../session/otp-list.js";

export const TOTP_WATCH_EVERY_MS = 3000;
export const TOTP_WATCH_MAX_MS = 120000;

// "saved" once a totp row for the target shows (any totp row when there is no target).
// On Windows the list command can stay empty for a saved code, so one empty poll ends in "check" (tap refresh), never "timeout"
export function watchState(rows, { target, elapsedMs, maxMs = TOTP_WATCH_MAX_MS, windows = false }) {
  const hit = (rows || []).some((r) => (target ? totpRowMatches(r, target) : r?.source === "totp"));
  if (hit) return "saved";
  if (windows) return "check";
  return elapsedMs >= maxMs ? "timeout" : "waiting";
}
