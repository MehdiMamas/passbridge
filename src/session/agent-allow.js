// the agent allowlist: one normaliser for Settings and the save bar, and the rules for offering a site
import { hostBlocked } from "../settings.js";
import { registrableDomain } from "./site-domain.js";

// hostBlocked compares bare hostnames, so https://example.com/ or *.example.com would never match
export function domainLines(value) {
  const out = [];
  for (const line of String(value || "").split(/[\n,]+/)) {
    const d = line
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*\./, "")
      .replace(/^\.+|\.+$/g, "");
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

// one account per tenant on these, so the parent domain would cover every company
export const SHARED_HOST_SUFFIXES = ["myworkdayjobs.com", "myworkdaysite.com"];

export function agentHostFor(host) {
  const h = domainLines(host)[0] || "";
  if (!h) return "";
  if (SHARED_HOST_SUFFIXES.some((s) => h.endsWith("." + s))) return h;
  return registrableDomain(h) || h;
}

export function addToAllowlist(list, host) {
  return domainLines([...(Array.isArray(list) ? list : []), host].join("\n"));
}

// the save bar's "Let agents sign in" checkbox: shown only when it could change something,
// ticked from the start only for a password made in this flow
export function agentOfferFor(settings, host, generated) {
  const site = agentHostFor(host);
  const show =
    !!site &&
    settings?.agentSignIn === true &&
    settings?.agentAllowAll !== true &&
    !hostBlocked(site, settings?.agentAllowlist);
  return { show, host: site, suggested: show && generated === true };
}
