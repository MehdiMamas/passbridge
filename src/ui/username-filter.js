// popup username lookup: pure helpers, no chrome apis
/** @param {any} s */
const norm = (s) => String(s || "").trim().toLowerCase();

// logins whose username contains q, ignoring case and outer spaces; empty q keeps all
/**
 * @param {any[]} logins
 * @param {any} q
 */
export function filterByUsername(logins, q) {
  const needle = norm(q);
  if (!needle) return logins;
  return logins.filter((l) => norm(l.username).includes(needle));
}

// codes to show for the kept logins: grouped ones follow their login, an ungrouped one stays only if its own username matches
/**
 * @param {any[]} codes
 * @param {any[]} logins
 * @param {any} userQuery
 */
export function codesForLogins(codes, logins, userQuery) {
  const needle = norm(userQuery);
  const names = new Set(logins.map((l) => norm(l.username)));
  return codes.filter((row) => {
    const own = norm(row.username);
    if (own && names.has(own)) return true;
    return !needle || own.includes(needle);
  });
}
