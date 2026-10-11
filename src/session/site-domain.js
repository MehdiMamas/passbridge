// Not the full public suffix list. These are the common suffixes where the site is
// three labels (bbc.co.uk), so account.bbc.co.uk stops at bbc.co.uk and never asks for co.uk.
const MULTI_LABEL_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "nhs.uk", "org.uk", "plc.uk", "police.uk", "sch.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "id.au", "net.au", "org.au",
  "ac.nz", "co.nz", "geek.nz", "gen.nz", "govt.nz", "net.nz", "org.nz", "school.nz",
  "ac.jp", "co.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp", "ne.jp", "or.jp",
  "ac.kr", "co.kr", "go.kr", "ne.kr", "or.kr", "re.kr",
  "com.br", "edu.br", "gov.br", "net.br", "org.br",
  "com.cn", "edu.cn", "gov.cn", "net.cn", "org.cn",
  "com.hk", "edu.hk", "gov.hk", "net.hk", "org.hk",
  "com.tw", "edu.tw", "gov.tw", "net.tw", "org.tw",
  "com.sg", "edu.sg", "gov.sg", "net.sg", "org.sg",
  "com.my", "edu.my", "gov.my", "net.my", "org.my",
  "co.in", "edu.in", "firm.in", "gen.in", "gov.in", "ind.in", "net.in", "org.in",
  "co.id", "go.id", "or.id", "web.id",
  "co.th", "go.th", "in.th", "or.th",
  "co.za", "gov.za", "org.za", "web.za",
  "co.il", "gov.il", "org.il", "ac.il",
  "com.tr", "gov.tr", "net.tr", "org.tr",
  "com.mx", "gob.mx", "net.mx", "org.mx",
  "com.ar", "gob.ar", "net.ar", "org.ar",
  "com.co", "gov.co", "net.co", "org.co",
  "com.pe", "gob.pe", "net.pe", "org.pe",
  "com.ua", "gov.ua", "net.ua", "org.ua",
  "com.pl", "net.pl", "org.pl",
  "com.ru", "net.ru", "org.ru",
  "com.eg", "com.sa", "com.pk", "com.ph", "com.vn", "com.ng", "com.qa", "com.kw",
  "co.ke", "co.ma",
  "ac.ae", "co.ae", "gov.ae", "net.ae", "org.ae",
  "ac.ir", "co.ir", "gov.ir", "org.ir",
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "herokuapp.com", "appspot.com", "web.app", "firebaseapp.com", "azurewebsites.net",
  "cloudfront.net", "blogspot.com", "wordpress.com",
]);

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

export function registrableDomain(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || isIpLiteral(h)) return h || null;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

// account.apple.com -> account.apple.com, apple.com. the page host always comes first
export function siteLookupHosts(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return [];
  const site = registrableDomain(h);
  if (!site || site === h || !h.endsWith("." + site)) return [h];
  const out = [h];
  const labels = h.split(".");
  for (let i = 1; i < labels.length; i++) {
    const parent = labels.slice(i).join(".");
    out.push(parent);
    if (parent === site) break;
  }
  return out;
}
