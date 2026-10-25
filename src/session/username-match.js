// matching a saved login to the username a page already shows (Gmail's password page names the account)

export function normalizeUsername(s) {
  return String(s ?? "").trim().toLowerCase();
}

// exact match, or "user" against "user@domain" by the local part (either side)
export function usernameMatchesPage(loginName, pageName) {
  const a = normalizeUsername(loginName);
  const b = normalizeUsername(pageName);
  if (!a || !b) return false;
  if (a === b) return true;
  const ai = a.indexOf("@");
  const bi = b.indexOf("@");
  if (ai > 0 && bi > 0) return false;
  const la = ai > 0 ? a.slice(0, ai) : a;
  const lb = bi > 0 ? b.slice(0, bi) : b;
  return la === lb;
}

// matching logins first, the rest keep their order
export function orderByPageUsername(logins, pageName) {
  if (!pageName || !Array.isArray(logins)) return logins;
  const hit = [];
  const rest = [];
  for (const l of logins) (usernameMatchesPage(l?.username, pageName) ? hit : rest).push(l);
  return hit.length ? [...hit, ...rest] : logins;
}
