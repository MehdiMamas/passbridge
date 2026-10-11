// otpauth://totp/... and apple-otpauth://totp/... only. The secret stays inside uri.
export function parseOtpAuth(raw) {
  const s = String(raw || "").trim();
  if (!/^(apple-)?otpauth:\/\//i.test(s)) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== "otpauth:" && proto !== "apple-otpauth:") return null;
  if (url.hostname.toLowerCase() !== "totp") return null;
  // sites often print the key in groups ("JBSW Y3DP EHPK 3PXP"), so spaces and hyphens are not part of it
  const secret = cleanSecret(url.searchParams.get("secret"));
  if (!/^[A-Za-z2-7]+=*$/.test(secret) || secret.replace(/=+$/, "").length < 8) return null;
  const pathLabel = safeDecode(url.pathname.replace(/^\//, "")).trim();
  let issuer = safeDecode(url.searchParams.get("issuer") || "").trim();
  let account = pathLabel;
  const colon = pathLabel.indexOf(":");
  if (colon >= 0) {
    if (!issuer) issuer = pathLabel.slice(0, colon).trim();
    account = pathLabel.slice(colon + 1).trim();
  }
  return { uri: s, issuer, account };
}

// base32 setup key only. Callers copy or hand this to the Windows helper; it is not a label.
export function otpAuthSecret(raw) {
  const parsed = parseOtpAuth(raw);
  if (!parsed) return "";
  let secret = "";
  try {
    secret = cleanSecret(new URL(parsed.uri).searchParams.get("secret"));
  } catch {
    return "";
  }
  if (!/^[A-Za-z2-7]+=*$/.test(secret) || secret.replace(/=+$/, "").length < 8) return "";
  return secret.replace(/=+$/, "");
}

function cleanSecret(s) {
  return String(s || "").replace(/[\s-]+/g, "");
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
