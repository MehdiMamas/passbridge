import { listOtpEntries, matchSyncedTotp } from "../../src/session/otp-list.js";
import { watchState } from "../../src/ui/totp-watch.js";

let failed = 0;
function ok(name, cond) {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
}

const totp = (username, domain = "google.com") => ({ source: "totp", username, domain, code: "000000" });
const pw = (username) => ({ source: "password", username, domain: "google.com" });

// stub helper: main list rows, login names by host, cmd 17 rows by username
function stub({ list = [], names = {}, reads = {} }) {
  const calls = { reads: 0, namesFor: [] };
  return {
    calls,
    getOneTimeCodes: async () => ({ entries: list, requiresAuth: false }),
    getLoginNamesForURL: async (_t, url) => {
      const h = new URL(url).hostname;
      calls.namesFor.push(h);
      return (names[h] || []).map((username) => ({ username }));
    },
    readOneTimeCode: async (_t, _f, _u, username) => {
      calls.reads++;
      return reads[username] || [];
    },
  };
}
const args = (extra = {}) => ({ tabId: 1, frameId: 0, frameUrls: ["https://accounts.google.com/signin"], platform: "win", ...extra });

{
  // a: main list has only non-totp rows, fallback must still run
  const c = stub({ list: [pw("me@x.com")], names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("me@x.com")] } });
  const { entries } = await listOtpEntries(c, args());
  ok("a: non-totp rows only still runs the fallback", entries.some((e) => e.source === "totp"));
  ok("a: password row kept", entries.some((e) => e.source === "password"));
}
{
  // b: different username forms
  for (const [label, row] of [["case", "ME@X.com"], ["issuer:login", "Google:me@x.com"]]) {
    const c = stub({ names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp(row)] } });
    const { entries } = await listOtpEntries(c, args());
    ok(`b: ${label} label is matched`, entries.length === 1);
  }
}
{
  // c: saved under google.com while the tab is accounts.google.com
  const c = stub({ names: { "google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("me@x.com")] } });
  const { entries } = await listOtpEntries(c, args());
  ok("c: login saved on the parent domain is found", entries.length === 1);
  ok("c: both hosts were looked up", c.calls.namesFor.includes("accounts.google.com") && c.calls.namesFor.includes("google.com"));
}
{
  // wrong account must not match
  const c = stub({ names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("other@x.com"), totp("Google:other@x.com")] } });
  const { entries } = await listOtpEntries(c, args());
  ok("wrong account: not attributed", entries.length === 0);
  ok("matchSyncedTotp rejects a suffix that is not :<login>", matchSyncedTotp([totp("xme@x.com")], "me@x.com") === null);
}
{
  // no duplicates, usernames deduped, capped at 8
  const c = stub({ list: [totp("me@x.com")], names: {} });
  const r = await listOtpEntries(c, args());
  ok("existing totp row skips the fallback", c.calls.reads === 0 && r.entries.length === 1);
  const many = Array.from({ length: 12 }, (_, i) => `u${i}@x.com`);
  const c2 = stub({ names: { "accounts.google.com": many, "google.com": [many[0].toUpperCase()] } });
  await listOtpEntries(c2, args());
  ok("reads capped at 8 logins", c2.calls.reads === 8);
  const dup = stub({ list: [pw("me@x.com")], names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("me@x.com"), totp("me@x.com")] } });
  const d = await listOtpEntries(dup, args());
  ok("merge has no duplicates", d.entries.filter((e) => e.source === "totp").length === 1);
}
{
  const c = stub({ names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("me@x.com")] } });
  await listOtpEntries(c, args({ listOnly: true }));
  ok("listOnly makes no per-login reads", c.calls.reads === 0 && c.calls.namesFor.length === 0);
  const m = stub({ names: { "accounts.google.com": ["me@x.com"] }, reads: { "me@x.com": [totp("me@x.com")] } });
  await listOtpEntries(m, args({ platform: "mac" }));
  ok("non-Windows makes no fallback reads", m.calls.reads === 0);
}
{
  const rows = [pw("me@x.com"), totp("Google:me@x.com")];
  ok("watch: saved for target", watchState(rows, { target: "me@x.com", elapsedMs: 3000 }) === "saved");
  ok("watch: saved without target", watchState(rows, { target: "", elapsedMs: 3000 }) === "saved");
  ok("watch: other account keeps waiting", watchState([totp("other@x.com")], { target: "me@x.com", elapsedMs: 3000 }) === "waiting");
  ok("watch: Windows empty poll ends in check, never timeout", watchState([], { target: "me@x.com", elapsedMs: 3000, windows: true }) === "check" && watchState([], { target: "me@x.com", elapsedMs: 999999, windows: true }) === "check");
  ok("watch: Windows still saves when the row shows", watchState(rows, { target: "me@x.com", elapsedMs: 3000, windows: true }) === "saved");
  ok("watch: timeout", watchState([], { target: "me@x.com", elapsedMs: 120000 }) === "timeout");
  ok("watch: saved wins at the limit", watchState(rows, { target: "me@x.com", elapsedMs: 120000 }) === "saved");
}
console.log(failed ? `\n${failed} failed` : "\notp-list ok");
process.exit(failed ? 1 : 0);
