// "Report this page" builds a public bug report, so nothing typed, secret or personal may survive the scrub.

export const REPORT_REPO = "MehdiMamas/passbridge";
// a frame's HTML is cut here so one heavy page can't make the file unusable
export const REPORT_FRAME_HTML_MAX = 400_000;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// long opaque runs (session ids, csrf tokens, jwt parts); short words and class names stay
const TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;

export function scrubText(s) {
  return String(s ?? "").replace(EMAIL, "[email]");
}

// keeps the path (what the site is) and drops what the query and fragment carry (who the user is)
export function scrubUrl(raw) {
  const s = String(raw ?? "");
  if (/^data:/i.test(s)) return s.length > 120 ? `${s.slice(0, 40)}…[data removed]` : s;
  let u;
  try {
    u = new URL(s, "https://x.invalid/");
  } catch {
    return scrubAttr(s);
  }
  if (!/^https?:$/i.test(u.protocol)) return scrubAttr(s);
  const keys = [...new Set(u.searchParams.keys())];
  const query = keys.length ? `?${keys.map((k) => `${encodeURIComponent(k)}=…`).join("&")}` : "";
  const hash = u.hash ? "#…" : "";
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("//");
  const base = relative ? scrubAttr(s.split(/[?#]/)[0]) : `${u.origin}${scrubAttr(u.pathname)}`;
  return `${base}${query}${hash}`;
}

export function scrubAttr(s) {
  return scrubText(s).replace(TOKEN, "[token]");
}

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data", "srcset", "cite", "background"]);
const DROP_ATTRS = new Set(["nonce", "integrity", "value", "placeholder-value"]);
const SECRET_META = /csrf|xsrf|token|nonce|key|session|user|email|account/i;
const KEEP_VALUE_TYPES = new Set(["submit", "button", "reset", "checkbox", "radio", "image"]);

/**
 * Scrubs a cloned element tree in place.
 * @param {Element} root
 * @param {(el: Element) => boolean} isOurs PassBridge's own injected elements, which are removed
 */
export function scrubTree(root, isOurs) {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    // a descendant of an element removed above
    if (!root.contains(el)) continue;
    if (isOurs(el)) {
      el.remove();
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "script") {
      if (el.textContent) el.textContent = "/* script removed */";
    } else if (tag === "style") {
      el.textContent = (el.textContent || "").replace(/url\(\s*["']?data:[^)]{100,}\)/gi, "url(data:…)");
    } else if (tag === "textarea") {
      el.textContent = "";
    } else if (tag === "meta") {
      const name = `${el.getAttribute("name") || ""} ${el.getAttribute("property") || ""} ${el.getAttribute("http-equiv") || ""}`;
      if (SECRET_META.test(name)) el.setAttribute("content", "[removed]");
    } else if (tag === "template") {
      el.innerHTML = "";
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "value") {
        if (!(tag === "input" && KEEP_VALUE_TYPES.has((el.getAttribute("type") || "").toLowerCase()))) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, scrubAttr(attr.value));
      } else if (DROP_ATTRS.has(name) || name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (name === "style") {
        el.setAttribute(attr.name, attr.value.replace(/url\(\s*["']?data:[^)]{100,}\)/gi, "url(data:…)"));
      } else if (URL_ATTRS.has(name)) {
        el.setAttribute(
          attr.name,
          name === "srcset" ? attr.value.split(",").map((p) => scrubUrl(p.trim().split(/\s+/)[0])).join(", ") : scrubUrl(attr.value),
        );
      } else {
        el.setAttribute(attr.name, scrubAttr(attr.value));
      }
    }
  }
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement?.tagName.toLowerCase();
    if (parent === "script" || parent === "style") continue;
    const v = scrubText(n.nodeValue);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
  return root;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function frameLine(f) {
  const fields = f.fields || [];
  const login = fields.filter((x) => x.visible && x.login).length;
  const otp = fields.filter((x) => x.visible && x.otp).length;
  const state = f.error ? `error: ${f.error}` : f.blocked ? "site blocked in settings" : f.safe ? "PassBridge active" : "PassBridge stays silent (frame not trusted)";
  return `${f.top ? "page" : "iframe"} ${f.url} · ${state} · ${login} login field(s), ${otp} code field(s)`;
}

export function reportFileName(report) {
  const host = hostOf(report.url) || "page";
  return `passbridge-report-${host}-${String(report.createdAt).slice(0, 10)}.txt`;
}

// the file the reporter attaches: a summary, then each frame's fields and scrubbed HTML
export function reportText(report) {
  const out = [
    "PassBridge page report",
    `Page: ${report.url}`,
    `Version: ${report.version}`,
    `Browser: ${report.browser}`,
    `Created: ${report.createdAt}`,
    "Scrubbed: field values, script code, query strings, tokens and email addresses.",
    "",
  ];
  report.frames.forEach((f, i) => {
    out.push(`==== Frame ${i + 1}: ${frameLine(f)} ====`);
    if (f.title) out.push(`Title: ${f.title}`);
    for (const x of f.fields || []) {
      const flags = [x.visible ? "visible" : "hidden", x.login && "login", x.otp && "code"].filter(Boolean).join(", ");
      out.push(`  <${x.tag} type="${x.type}" name="${x.name}" id="${x.id}" autocomplete="${x.autocomplete}"> ${flags}`);
    }
    out.push("---- HTML ----", f.html || "(none)");
    if (f.truncated) out.push(`---- HTML cut at ${REPORT_FRAME_HTML_MAX} characters ----`);
    out.push("");
  });
  return out.join("\n");
}

// GitHub's new-issue form, prefilled; the body stays short because it travels in the URL
export function reportIssueUrl(report, note) {
  const host = hostOf(report.url) || "a page";
  const lines = [
    "**What went wrong:**",
    String(note || "").trim() || "_(describe what you expected PassBridge to do)_",
    "",
    `**Page:** ${report.url}`,
    `**PassBridge:** ${report.version}`,
    "",
    "**Frames:**",
    ...report.frames.slice(0, 12).map((f) => `- ${frameLine(f)}`),
    ...(report.frames.length ? [] : ["- none answered (reload the page and try again)"]),
    "",
    `**Page file:** drag \`${reportFileName(report)}\` from your Downloads into this box.`,
  ];
  const params = new URLSearchParams({ title: `Page report: ${host}`, body: lines.join("\n").slice(0, 6000), labels: "page-report" });
  return `https://github.com/${REPORT_REPO}/issues/new?${params}`;
}
