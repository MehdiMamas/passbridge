// Pure helpers for adding a verification code from the popup: a pasted setup key or otpauth link
// becomes one otpauth URI, and the saved login the user picked becomes its account label.
// The secret stays inside the uri; nothing here logs it or touches the clipboard.
import { otpAuthSecret, parseOtpAuth } from "./otpauth.js";

// accepts an otpauth:// link (alone or inside pasted text) or a bare base32 setup key, grouped or not
export function parseSetupInput(raw, fallbackLabel = "") {
  const text = String(raw || "").trim();
  if (!text) return null;
  const link = text.match(/(?:apple-)?otpauth:\/\/\S+/i);
  if (link) return parseOtpAuth(link[0]);
  const key = text.replace(/[\s-]+/g, "");
  if (!/^[A-Za-z2-7]+=*$/.test(key) || key.replace(/=+$/, "").length < 8) return null;
  const label = encodeURIComponent(String(fallbackLabel || "").trim());
  return parseOtpAuth(`otpauth://totp/${label}?secret=${key.replace(/=+$/, "").toUpperCase()}`);
}

// relabels the setup link with the login the user chose, keeping the secret and its other parameters
export function withAccount(uri, { username, issuer } = {}) {
  const secret = otpAuthSecret(uri);
  if (!secret) return null;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const parsed = parseOtpAuth(uri);
  const iss = String(issuer || parsed?.issuer || "").trim();
  const account = String(username || parsed?.account || "").trim();
  url.pathname = "/" + encodeURIComponent(iss && account ? `${iss}:${account}` : account || iss);
  if (iss) url.searchParams.set("issuer", iss);
  return url.toString();
}

// the message the helper client gets: the uri and the page it belongs to, nothing else
export function totpHandoff(uri, pageUrl) {
  return { totpUri: uri, totpPageUrl: pageUrl };
}
