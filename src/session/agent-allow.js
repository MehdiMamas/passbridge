// the save bar can add the site to the agent allowlist; the list rules live here so the
// background, the settings page and the tests share one copy
import { hostBlocked } from "../settings.js";
import { registrableDomain } from "./site-domain.js";

// hosts where every company or user has its own subdomain, so the full host is allowed, never the parent
const SHARED_HOST_SUFFIXES = ["myworkdayjobs.com", "myworkdaysite.com"];

// hostBlocked compares bare hostnames, so https://example.com/ or *.example.com would never match
export function domainLines(value) {
  const out = [];
  for (const line of value.split(/[\n,]+/)) {
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

export function agentHostFor(host) {
  const h = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (SHARED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s))) return h;
  return registrableDomain(h) || h;
}

export function addToAllowlist(list, host) {
  return domainLines([...(Array.isArray(list) ? list : []), host].join("\n"));
}

export function agentOfferFor(settings, host, generated) {
  const h = agentHostFor(host);
  const show = !!(
    settings?.agentSignIn &&
    !settings.agentAllowAll &&
    h &&
    !hostBlocked(h, settings.agentAllowlist)
  );
  return { show, host: h, suggested: !!generated };
}
