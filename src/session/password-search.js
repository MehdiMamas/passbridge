// parent or child only. a bare TLD is not a site, and notaugustana.edu does not match augustana.edu
/**
 * @param {string | null | undefined} frameHost
 * @param {string | null | undefined} siteHost
 * @returns {boolean}
 */
export function hostsRelated(frameHost, siteHost) {
  if (!frameHost || !siteHost || frameHost === siteHost) return false;
  if (!frameHost.includes(".") || !siteHost.includes(".")) return false;
  return frameHost.endsWith("." + siteHost) || siteHost.endsWith("." + frameHost);
}

/**
 * @param {unknown} site
 * @returns {string | null}
 */
export function hostOfSite(site) {
  const raw = String(site || "").trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} sites
 * @returns {string[]}
 */
export function siteHosts(sites) {
  const raw = Array.isArray(sites) ? sites : sites ? [sites] : [];
  /** @type {string[]} */
  const out = [];
  for (const s of raw) {
    const text = typeof s === "string" ? s : s?.url || s?.URL || s?.host || "";
    const h = hostOfSite(text);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * @param {string} frameHost
 * @param {unknown} sites
 * @returns {string | null}
 */
export function bestRelatedHost(frameHost, sites) {
  const hosts = siteHosts(sites).filter((h) => hostsRelated(frameHost, h));
  const parents = hosts.filter((h) => frameHost.endsWith("." + h)).sort((a, b) => b.length - a.length);
  if (parents.length) return parents[0];
  const children = hosts.filter((h) => h.endsWith("." + frameHost)).sort((a, b) => a.length - b.length);
  return children[0] || null;
}

// Page hostname first. After that misses, Apple's extension retries with the record's
// first website as the outer url. Further misses search each other website on that
// same helper response, then a parent or child host with the frame as the outer url.
// viaHost is the parent domain whose list returned the login (apple.com on account.apple.com),
// searched first because the page host never lists that login.
/**
 * @param {string | null | undefined} frameHost
 * @param {unknown} sites
 * @param {string | null | undefined} [pathUrl]
 * @param {string | null | undefined} [viaHost]
 * @returns {{ search: string, envelope: string }[]}
 */
export function passwordSearchSteps(frameHost, sites, pathUrl, viaHost) {
  /** @type {{ search: string, envelope: string }[]} */
  const steps = [];
  /**
   * @param {string | null | undefined} search
   * @param {string | null | undefined} envelope
   */
  const push = (search, envelope) => {
    const s = search || frameHost;
    const e = envelope || frameHost;
    if (!s || !e) return;
    if (steps.some((step) => step.search === s && step.envelope === e)) return;
    steps.push({ search: s, envelope: e });
  };
  if (viaHost && viaHost !== frameHost) {
    push(viaHost, viaHost);
    push(viaHost, frameHost);
  }
  push(frameHost, frameHost);
  if (pathUrl && pathUrl !== frameHost) push(pathUrl, frameHost);
  const hosts = siteHosts(sites);
  const primary = hosts[0];
  if (primary) push(frameHost, primary);
  for (const site of hosts) {
    if (site === frameHost) continue;
    push(site, primary || frameHost);
  }
  const related = bestRelatedHost(/** @type {string} */ (frameHost), sites);
  if (related) push(related, frameHost);
  return steps;
}
