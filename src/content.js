import { AutoFillConstants } from "./autofill/hints.js";
import { generateAlphanumericPassword, generateApplePassword } from "./password-generate.js";
import { hideTotpBar, installQrPage, qrImageRect, showTotpBar } from "./qr-page.js";

const UPSTREAM_USER = new Set(
  [...AutoFillConstants.UsernameFieldNames, ...AutoFillConstants.EmailFieldNames].map((name) => name.toLowerCase()),
);

function hitsUpstreamName(el) {
  const raw = `${el.name || ""} ${el.id || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  return raw.split(/\s+/).some((token) => token && UPSTREAM_USER.has(token));
}

// OTP inputs are never fillable login fields, that misclassification is apple's balloon-on-every-OTP bug
console.log("[PassBridge] content script v1.0.0 loaded");

const PB_DEFAULTS = {
  inlineMenuVisibility: "on-focus",
  autofillOnPageLoad: false,
  showAnimations: true,
  blockedDomains: [],
};
let pbSettings = { ...PB_DEFAULTS };
function hostInList(host, list) {
  host = (host || "").toLowerCase();
  return (list || []).some((d) => {
    d = String(d || "").trim().toLowerCase();
    return d && (host === d || host.endsWith("." + d));
  });
}
try {
  chrome.storage?.local?.get(PB_DEFAULTS, (o) => {
    if (!chrome.runtime.lastError && o) pbSettings = { ...PB_DEFAULTS, ...o };
  });
  chrome.storage?.onChanged?.addListener((ch, area) => {
    if (area !== "local") return;
    for (const [k, v] of Object.entries(ch)) {
      if (k in PB_DEFAULTS) pbSettings[k] = v.newValue;
    }
  });
} catch {}

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT = /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b/i;

function attrBlob(el) {
  // snapchat's web login leaves the input bare and labels it via <label>/aria-labelledby
  let labelText = "";
  try {
    if (el.labels?.length) labelText = Array.from(el.labels, (l) => l.textContent).join(" ");
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      labelText += " " + lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" ");
    }
  } catch {}
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete"), labelText]
    .filter(Boolean)
    .join(" ");
}

function isOtpField(el) {
  const ac = el.getAttribute("autocomplete") || "";
  if (OTP_AUTOCOMPLETE.test(ac)) return true;
  const max = parseInt(el.getAttribute("maxlength") || "0", 10);
  if (el.inputMode === "numeric" && max === 1) return true;
  if (OTP_HINT.test(attrBlob(el))) return true;
  return false;
}

function isPasswordField(el) {
  return el instanceof HTMLInputElement && el.type === "password";
}

// a show-password toggle flips type to text at submit, which hid these from the collector
const everPassword = new WeakSet();

function isPasswordish(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "password") return true;
  if (everPassword.has(el)) return true;
  const t = (el.type || "text").toLowerCase();
  if (!["text", ""].includes(t)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("password")) return true;
  return /passw|pwd/i.test(attrBlob(el));
}

const NONLOGIN_HINT =
  /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;

function isSearchOrComboField(el) {
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "searchbox" || role === "combobox") return true;
  if ((el.type || "").toLowerCase() === "search") return true;
  if ((el.getAttribute("enterkeyhint") || "").toLowerCase() === "search") return true;
  const aac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
  if (aac === "list" || aac === "both" || aac === "inline") return true;
  return false;
}

function pageHasVisiblePassword(field) {
  if (Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)) return true;
  const root = field?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    return Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible);
  }
  return false;
}

function hasStrongIdentitySignal(el) {
  const t = (el.type || "text").toLowerCase();
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  // wells fargo and nintendo mark their username box autocomplete=webauthn
  if (ac.includes("username") || ac.includes("email") || ac.includes("webauthn")) return true;
  if (hitsUpstreamName(el)) return true;
  if (t === "email") return true;
  return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b/i.test(attrBlob(el));
}

const LOGINISH = /log[\s_-]?in|sign[\s_-]?in|auth|session|sso|oauth|account|idp|passport/i;

// gates the two-step case where no password field exists yet
function loginishContext(el) {
  if (LOGINISH.test(location.hostname + location.pathname)) return true;
  const form = el.form;
  if (form && LOGINISH.test(form.getAttribute("action") || "")) return true;
  const scope = form || document;
  return Array.from(scope.querySelectorAll("button, input[type=submit]")).some((b) => {
    const label = b.textContent || b.value || "";
    if (/\b(payment|shipping|checkout|address|guest|receipt)\b/i.test(label)) return false;
    return /\b(sign[\s-]?in|log[\s-]?in|continue|next)\b/i.test(label);
  });
}

function isUsernameField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isOtpField(el)) return false;
  if (isSearchOrComboField(el)) return false;
  const t = (el.type || "text").toLowerCase();
  if (!["text", "email", "tel", ""].includes(t)) return false;

  // "E-mail address" contains "address", which NONLOGIN_HINT would reject (nintendo)
  if (hasStrongIdentitySignal(el)) return true;

  const blob = attrBlob(el);
  if (NONLOGIN_HINT.test(blob)) return false;
  return /\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(blob);
}

let fillStyleInjected = false;
function ensureFillStyle() {
  if (fillStyleInjected) return;
  fillStyleInjected = true;
  const st = document.createElement("style");
  st.textContent = "@keyframes pb-fill{from{background-color:rgba(10,132,255,0.28)}to{background-color:transparent}} .pb-fill-flash{animation:pb-fill 200ms ease-out}";
  (document.head || document.documentElement).appendChild(st);
}

// native setter plus the Bitwarden insert sequence: click, focus, key events, value, input, change
function setValue(el, value) {
  ensureFillStyle();
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const write = (v) => {
    if (setter) setter.call(el, v);
    else el.value = v;
  };
  try { el.click(); } catch {}
  el.focus();
  const before = el.value;
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  if (el.value !== before) write(before);
  write(value);
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (pbSettings.showAnimations !== false) {
    el.classList.add("pb-fill-flash");
    setTimeout(() => el.classList.remove("pb-fill-flash"), 200);
  }
}

function isVisible(el) {
  if (!el.isConnected) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) < 0.1) return false;
  return true;
}

// hidden/manager-only fields are fine, block the clickjacking shapes (1px, opacity:0, offscreen)
function isFillable(el) {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);

  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
  if (el.offsetParent === null && s.position !== "fixed") return true;

  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (parseFloat(s.opacity) < 0.1) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
    // below the fold is legit, only far-offscreen exfil coords are hostile
    if (r.left < -1000 || r.top < -1000 || r.left > vw + 5000) return false;
  }
  return true;
}

async function fillCredentials(username, password, anchor) {
  const pool = new Set(document.querySelectorAll("input"));
  const root = anchor?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    for (const i of root.querySelectorAll("input")) pool.add(i);
  }
  const inputs = Array.from(pool).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);

  const anchorForm = anchor && anchor.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    if (pwInForm.length) passwords = pwInForm;
    if (userInForm.length) usernames = userInForm;
  }

  let firstPw = passwords[0];
  if (anchor && passwords.length > 1) {
    firstPw = passwords
      .map((p) => ({ p, d: Math.abs(domDistance(anchor, p)) }))
      .sort((a, b) => a.d - b.d)[0].p;
  }

  let userTarget = null;
  if (username) {
    if (anchor && isUsernameField(anchor)) userTarget = anchor;
    else if (usernames.length) {
      userTarget = usernames[0];
      if (firstPw) {
        const before = usernames.filter((u) => u.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (before.length) userTarget = before[before.length - 1];
      }
    }
  }

  let filled = false;
  if (userTarget) {
    setValue(userTarget, username);
    filled = true;
  }
  if (password && firstPw) {
    if (filled) await new Promise((r) => setTimeout(r, 20));
    setValue(firstPw, password);
    everPassword.add(firstPw);
    filled = true;
  }
  return filled;
}

function domDistance(a, b) {
  const all = Array.from(document.querySelectorAll("input"));
  return all.indexOf(a) - all.indexOf(b);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function passwordsMatch(hash, password) {
  if (!hash || !password) return false;
  return hash === (await sha256Hex(password));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "fill") return false;
  // host must match the origin the background pinned the cred to, so site A's cred never lands on site B
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, filled: false, error: "forbidden" });
    return true;
  }
  if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
    sendResponse({ ok: false, filled: false, error: "origin mismatch" });
    return true;
  }
  fillCredentials(msg.username, msg.password, liveField(fillAnchor)).then(async (filled) => {
    // a submit right after must not re-offer to save this existing login
    if (filled) {
      let passwordHash = "";
      try {
        if (msg.password) passwordHash = await sha256Hex(msg.password);
      } catch {}
      lastAutofill = {
        host: location.hostname,
        username: msg.username,
        passwordHash,
        at: Date.now(),
      };
      sendResponse({ ok: true, filled: true });
      return;
    }
    sendResponse({ ok: true, filled: false, error: "no fields" });
  }).catch((err) => {
    sendResponse({ ok: false, filled: false, error: String(err?.message ?? err) });
  });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.type) {
    case "fillOtp": {
      if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
        sendResponse({ ok: false, filled: false, error: "origin mismatch" });
        return true;
      }
      // a frame with no code field stays silent so another frame's answer wins
      const target = otpTargetField();
      if (!target) return false;
      fillOtp(target, msg.code);
      sendResponse({ ok: true, filled: true });
      return true;
    }
    case "oneTimeCodeAvailable": {
      const a = deepActiveElement();
      if (a instanceof HTMLInputElement && isOtpField(a) && isVisible(a) && frameIsSafe()) {
        buildOneTimeCodeSuggestion(a);
      }
      return false;
    }
    case "shortcut": {
      onShortcut();
      return false;
    }
    case "unlocked": {
      // auto-pair opened the vault while the inline PIN box was up
      if (suggestionEl && typeof lockedResume === "function") lockedResume();
      return false;
    }
    case "showSaveBar": {
      if (window !== window.top) return false;
      showSaveBar(msg);
      sendResponse({ ok: true });
      return true;
    }
    case "hideSaveBar": {
      hideSaveBar();
      return false;
    }
    case "qrImageRect": {
      sendResponse({ rect: qrImageRect() });
      return true;
    }
    case "showTotpBar": {
      if (window !== window.top) return false;
      showTotpBar(msg);
      sendResponse({ ok: true });
      return true;
    }
    case "hideTotpBar": {
      hideTotpBar();
      return false;
    }
    case "generatePassword": {
      const field = anchorPwField(document) || document.querySelector('input[type="password"]');
      if (field instanceof HTMLInputElement) fillGeneratedPassword(field, generateApplePassword());
      return false;
    }
    case "collectFields": {
      const inputs = Array.from(document.querySelectorAll("input"));
      sendResponse({
        fields: inputs.filter((el) => isVisible(el)).map((el, i) => ({
          opid: el.id || el.name || String(i),
          username: isUsernameField(el),
          password: isPasswordField(el),
          otp: isOtpField(el),
        })),
      });
      return true;
    }
  }
  return false;
});

let saveHost = null;
function hideSaveBar() {
  if (!saveHost) return;
  try { saveHost.hidePopover?.(); } catch {}
  saveHost.remove();
  saveHost = null;
}

function showSaveBar(msg) {
  hideSaveBar();
  const host = document.createElement("div");
  host.setAttribute("data-passbridge-save", "1");
  host.setAttribute("popover", "manual");
  const shadow = host.attachShadow({ mode: "closed" });
  const iframe = document.createElement("iframe");
  const token = Math.random().toString(36).slice(2);
  iframe.setAttribute("data-passbridge-frame", "save");
  iframe.src = chrome.runtime.getURL(`overlay/save-bar.html?token=${token}&update=${msg.update ? "1" : "0"}&user=${encodeURIComponent(msg.username || "")}`);
  Object.assign(iframe.style, {
    width: "360px",
    height: "148px",
    border: "none",
    borderRadius: "14px",
    background: "transparent",
  });
  shadow.appendChild(iframe);
  Object.assign(host.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    margin: "0",
    padding: "0",
    border: "none",
    background: "transparent",
    zIndex: "2147483647",
    width: "360px",
    height: "148px",
  });
  (document.body || document.documentElement).appendChild(host);
  try { host.showPopover(); } catch {}
  saveHost = host;
  window.addEventListener("message", function onSave(e) {
    if (e.source !== iframe.contentWindow || e.data?.token !== token) return;
    window.removeEventListener("message", onSave);
    const action = e.data.action;
    hideSaveBar();
    if (action === "save") chrome.runtime.sendMessage({ type: "confirmSave" }).catch(() => {});
    else if (action === "never") chrome.runtime.sendMessage({ type: "neverSave" }).catch(() => {});
    else chrome.runtime.sendMessage({ type: "dismissSave" }).catch(() => {});
  });
}

let fillAnchor = null;
let otpAnchor = null;
let lockedResume = null;
// suppresses a save offer for a login just filled from the vault
let lastAutofill = null;
// its submit always offers to save (reset page / password change)
let lastGenerated = null;

let suggestionEl = null;
let suggestionHost = null;
let iconHost = null;
let anchorField = null;
let cachedLogins = null;
let navItems = [];
let navIndex = -1;
let loginSearchEl = null;
let loginListReflow = null;
let loginListUnbind = null;
let menuGen = 0;

function isLoginField(el) {
  if (!isVisible(el)) return false;

  if (isPasswordField(el)) return true;

  if (!isUsernameField(el)) return false;

  const form = el.form;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();

  // explicit autocomplete=username is intentional even when the password lives in another form
  if (ac.includes("username")) return true;

  // beats autocomplete=off, which banks (wells fargo) set to block autofill, chrome/1password ignore it too
  if (form && Array.from(form.querySelectorAll("input")).some(isPasswordField)) return true;

  const formOptedOut = form && (form.getAttribute("autocomplete") || "").toLowerCase() === "off";
  if (formOptedOut) return false;

  // without this it fires on tag/search/newsletter boxes
  if (pageHasVisiblePassword(el)) return true;

  // two-step first page, no password anywhere yet
  if (hasStrongIdentitySignal(el) && loginishContext(el)) return true;

  return false;
}

function removeSuggestion() {
  menuGen++;
  loginListUnbind?.();
  loginListUnbind = null;
  loginListReflow = null;
  loginSearchEl = null;
  if (suggestionHost) {
    try { suggestionHost._pbWatch?.disconnect(); } catch {}
    try { suggestionHost.hidePopover?.(); } catch {}
    suggestionHost.remove();
    suggestionHost = null;
  } else if (suggestionEl) {
    suggestionEl.remove();
  }
  suggestionEl = null;
  anchorField = null;
  navItems = [];
  navIndex = -1;
  lockedResume = null;
}

function removeIcon() {
  if (!iconHost) return;
  try { iconHost.hidePopover?.(); } catch {}
  iconHost.remove();
  iconHost = null;
}

function setActiveNav(i) {
  navIndex = i;
  navItems.forEach((it, idx) => {
    const on = idx === i;
    it.el.style.background = on ? "rgba(10,132,255,0.18)" : "transparent";
    if (on) it.el.setAttribute("aria-selected", "true");
    else it.el.removeAttribute("aria-selected");
  });
  if (i >= 0 && navItems[i]) navItems[i].el.scrollIntoView({ block: "nearest" });
}

function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  navItems.push({ el: row, onActivate });
  // index is resolved at hover time so a rebuilt login list can keep the generator rows
  row.addEventListener("mouseenter", () => {
    const idx = navItems.findIndex((it) => it.el === row);
    if (idx >= 0) setActiveNav(idx);
  });
  // act on click not mousedown so the click cant land on a link behind the box (x.com forgot password, issue #2)
  row.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    rowPressAt = Date.now();
  });
  row.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
}

// a click that follows a row press but reaches the page (box torn down in between) must not act on the page
let rowPressAt = 0;
function eventHitsMenu(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (suggestionHost && path.includes(suggestionHost)) return true;
  if (iconHost && path.includes(iconHost)) return true;
  if (suggestionEl && (e.target === suggestionEl || suggestionEl.contains(e.target))) return true;
  return false;
}

document.addEventListener(
  "click",
  (e) => {
    if (!rowPressAt || Date.now() - rowPressAt > 700) return;
    if (eventHitsMenu(e)) return;
    rowPressAt = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);

function menuSearchFocused(e) {
  if (!loginSearchEl) return false;
  if (e.target === loginSearchEl) return true;
  // a closed shadow retargets the key event to the host
  return e.target === suggestionHost && document.activeElement === suggestionHost;
}

function menuHandlesKeys(e) {
  return e.target === anchorField || menuSearchFocused(e);
}

function onSuggestionKeydown(e) {
  if (!e.isTrusted) return;
  if (!suggestionEl) return;
  if (e.key === "Escape") {
    const field = anchorField;
    removeSuggestion();
    field?.focus();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key === "Tab" && suggestionEl) {
    removeSuggestion();
    return;
  }
  if (!navItems.length || !menuHandlesKeys(e)) return;
  if (e.key === "ArrowDown") {
    setActiveNav((navIndex + 1) % navItems.length);
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === "ArrowUp") {
    setActiveNav((navIndex - 1 + navItems.length) % navItems.length);
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === "Enter" && navIndex >= 0) {
    e.preventDefault();
    e.stopPropagation();
    navItems[navIndex].onActivate();
  } else if (e.key === "Enter" && menuSearchFocused(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function frameShift() {
  // The menu lives in this frame, so the field rect is already local.
  // The same walk is what a top frame would add for a child rect (depth cap 8).
  let x = 0;
  let y = 0;
  let depth = 0;
  let w = window;
  while (w !== w.top && depth < 8) {
    let fe = null;
    try { fe = w.frameElement; } catch { break; }
    if (!fe) break;
    const r = fe.getBoundingClientRect();
    const s = w.parent.getComputedStyle(fe);
    x += r.left + (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0);
    y += r.top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0);
    w = w.parent;
    depth++;
  }
  return { x, y, depth };
}

function pageIsFaded() {
  try {
    const html = parseFloat(getComputedStyle(document.documentElement).opacity);
    const body = document.body ? parseFloat(getComputedStyle(document.body).opacity) : 1;
    return html <= 0.6 || body <= 0.6;
  } catch {
    return false;
  }
}

function rectsOverlap(a, b) {
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

function overlapsControl(rect) {
  const nodes = document.querySelectorAll("input, textarea");
  for (const el of nodes) {
    if (el === anchorField) continue;
    if (!isVisible(el)) continue;
    if (rectsOverlap(rect, el.getBoundingClientRect())) return true;
  }
  return false;
}

function positionBox() {
  const host = suggestionHost || suggestionEl;
  if (!host || !anchorField) return;
  if (!anchorField.isConnected || !isVisible(anchorField)) {
    removeSuggestion();
    return;
  }
  if (pageIsFaded()) {
    removeSuggestion();
    return;
  }
  const r = anchorField.getBoundingClientRect();
  void frameShift();
  const GAP = 6;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const width = Math.min(320, Math.max(Math.min(r.width, 320), 200));
  let left = r.left;
  if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
  host.style.width = `${width}px`;
  host.style.maxWidth = "320px";
  host.style.minWidth = "0";
  loginListReflow?.();
  const h = (suggestionEl || host).offsetHeight || 0;
  const belowTop = r.bottom + GAP;
  const aboveTop = r.top - GAP - h;
  const belowRect = { left, top: belowTop, right: left + width, bottom: belowTop + h };
  const aboveRect = { left, top: aboveTop, right: left + width, bottom: aboveTop + h };
  const belowBad = belowRect.bottom > vh - 8 || overlapsControl(belowRect);
  const aboveOk = aboveTop >= 8 && !overlapsControl(aboveRect);
  host.style.left = `${left}px`;
  host.style.top = `${belowBad && aboveOk ? aboveTop : belowTop}px`;
  const mr = host.getBoundingClientRect();
  if (mr.width > 8 && mr.height > 8) {
    const top = document.elementFromPoint(mr.left + mr.width / 2, mr.top + Math.min(12, mr.height / 2));
    // Top-layer popovers are invisible to elementFromPoint in some Chrome builds.
    // Only treat a hit as a cover when it is another element that actually contains the point
    // and the menu host is an ancestor of nothing under it (a real overlay, not the page behind).
    const covered = top && top !== host && !host.contains(top) && top !== anchorField && host.contains(document.activeElement) === false && top.closest?.("[data-passbridge-host]");
    if (covered && !host.contains(covered)) removeSuggestion();
  }
}

const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Open Runde", system-ui, sans-serif';

function fontFaceCss() {
  return [
    ["Regular", 400],
    ["Medium", 500],
    ["Semibold", 600],
  ]
    .map(
      ([w, n]) =>
        `@font-face{font-family:"Open Runde";font-weight:${n};font-display:swap;src:url("${chrome.runtime.getURL(`fonts/OpenRunde-${w}.woff2`)}") format("woff2");}`,
    )
    .join("");
}

// solid Canvas stays as the fallback where light-dark() is unsupported
function glassify(el) {
  Object.assign(el.style, {
    background: "Canvas",
    color: "CanvasText",
    colorScheme: "light dark",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: "14px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.10)",
    backdropFilter: "blur(24px) saturate(180%)",
    webkitBackdropFilter: "blur(24px) saturate(180%)",
    overflow: "hidden",
    font: `13px/1.4 ${UI_FONT}`,
  });
  el.style.setProperty("background", "light-dark(rgba(252,252,253,0.72), rgba(28,28,30,0.66))");
  el.style.setProperty("border-color", "light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.14))");
  el.style.setProperty(
    "box-shadow",
    "0 12px 32px rgba(0,0,0,0.22), inset 0 0.5px 0 light-dark(rgba(255,255,255,0.75), rgba(255,255,255,0.12))",
  );
}

function watchMenuHost(host) {
  const mo = new MutationObserver(() => {
    if (!host.isConnected) return;
    if (host.getAttribute("popover") !== "manual") {
      host.setAttribute("popover", "manual");
      try { host.showPopover(); } catch {}
    }
    if (host.getAttribute("style") && /display\s*:\s*none/i.test(host.getAttribute("style"))) {
      host.style.display = "block";
    }
  });
  mo.observe(host, { attributes: true, attributeFilter: ["popover", "style", "hidden"] });
  host._pbWatch = mo;
}

function buildSuggestionBox(field) {
  removeSuggestion();
  anchorField = field;
  const host = document.createElement("div");
  host.setAttribute("data-passbridge-host", "menu");
  host.setAttribute("data-passbridge", "suggestions");
  host.setAttribute("popover", "manual");
  Object.assign(host.style, {
    position: "fixed",
    margin: "0",
    padding: "0",
    border: "none",
    background: "transparent",
    zIndex: "2147483647",
    overflow: "visible",
    maxWidth: "320px",
  });
  // The list lives in the closed shadow so the page cannot restyle it into a form control.
  const shadow = host.attachShadow({ mode: "closed" });
  const reset = document.createElement("style");
  reset.textContent = `${fontFaceCss()}:host{all:initial;display:block}:host::backdrop{display:none}`;
  const box = document.createElement("div");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Saved logins");
  glassify(box);
  shadow.append(reset, box);
  (document.body || document.documentElement).appendChild(host);
  try { host.showPopover(); } catch {}
  watchMenuHost(host);
  suggestionHost = host;
  suggestionEl = box;
  positionBox();
  return box;
}

function placeFieldIcon(field) {
  removeIcon();
  if (pbSettings.inlineMenuVisibility === "off") return;
  const host = document.createElement("div");
  host.setAttribute("data-passbridge-icon", "1");
  host.setAttribute("popover", "manual");
  const shadow = host.attachShadow({ mode: "closed" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "PassBridge";
  btn.setAttribute("aria-label", "PassBridge");
  const mark = document.createElement("img");
  mark.src = chrome.runtime.getURL("icons/icon48.png");
  mark.alt = "";
  mark.draggable = false;
  Object.assign(mark.style, {
    width: "100%",
    height: "100%",
    display: "block",
    pointerEvents: "none",
  });
  btn.appendChild(mark);
  Object.assign(btn.style, {
    width: "100%",
    height: "100%",
    padding: "0",
    border: "none",
    borderRadius: "5px",
    background: "transparent",
    cursor: "pointer",
    display: "block",
  });
  btn.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    if (isOtpField(field)) buildOneTimeCodeSuggestion(field);
    else buildOfferSuggestion(field);
  });
  shadow.appendChild(btn);
  Object.assign(host.style, {
    position: "fixed",
    margin: "0",
    padding: "0",
    border: "none",
    background: "transparent",
    zIndex: "2147483647",
    width: "20px",
    height: "20px",
  });
  (document.body || document.documentElement).appendChild(host);
  try { host.showPopover(); } catch {}
  const r = field.getBoundingClientRect();
  const size = Math.min(20, Math.max(14, r.height - 8));
  host.style.width = `${size}px`;
  host.style.height = `${size}px`;
  host.style.left = `${r.right - size - 6}px`;
  host.style.top = `${r.top + (r.height - size) / 2}px`;
  iconHost = host;
}

async function deviceLabel() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "getPlatform" });
    if (r?.label) return r.label;
  } catch (_) {}
  return "your Mac";
}

async function buildLockedSuggestion(field, onUnlock) {
  const place = await deviceLabel();
  const box = buildSuggestionBox(field);

  const msg = document.createElement("div");
  msg.textContent = `Enter the code shown on ${place}`;
  Object.assign(msg.style, { padding: "8px 10px 4px", fontSize: "12px", opacity: "0.7" });
  box.appendChild(msg);

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 6;
  input.placeholder = "------";
  Object.assign(input.style, {
    margin: "4px 12px 8px",
    width: "calc(100% - 24px)",
    padding: "9px",
    font: `16px ${UI_FONT}`,
    letterSpacing: "5px",
    textAlign: "center",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: "10px",
    background: "Canvas",
    color: "CanvasText",
    boxSizing: "border-box",
  });
  input.style.setProperty("background", "light-dark(rgba(255,255,255,0.55), rgba(0,0,0,0.28))");
  box.appendChild(input);

  const status = document.createElement("div");
  Object.assign(status.style, { padding: "0 10px 8px", fontSize: "12px", color: "#ff453a", minHeight: "14px" });
  box.appendChild(status);

  input.addEventListener("mousedown", (e) => e.stopPropagation());

  const setStatus = (text, isError) => {
    status.style.color = isError ? "#ff453a" : "rgba(128,128,128,0.9)";
    status.textContent = text;
  };

  const again = document.createElement("div");
  again.textContent = "Get a new code";
  Object.assign(again.style, {
    padding: "0 12px 10px",
    fontSize: "12px",
    opacity: "0.7",
    cursor: "pointer",
    textDecoration: "underline",
  });
  again.addEventListener("mousedown", (e) => e.stopPropagation());
  again.addEventListener("click", async () => {
    setStatus(`Asking ${place} for a new code...`, false);
    input.value = "";
    await chrome.runtime.sendMessage({ type: "requestChallenge" }).catch(() => {});
    setStatus(`Enter the new code on ${place}`, false);
    input.focus();
  });
  box.appendChild(again);

  // a second prompt would invalidate the code the user is reading
  chrome.runtime.sendMessage({ type: "requestChallenge", ifNeeded: true }).catch(() => {});

  // also reached from the background's "unlocked" message via lockedResume
  const finishUnlock = async () => {
    lockedResume = null;
    if (typeof onUnlock === "function") {
      removeSuggestion();
      onUnlock();
      return;
    }
    cachedLogins = null;
    const r2 = await chrome.runtime.sendMessage({ type: "inlineLogins" }).catch(() => null);
    cachedLogins = r2?.logins || [];
    if (cachedLogins.length === 1) {
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: cachedLogins[0] }).catch(() => {});
    } else if (cachedLogins.length > 1) {
      buildChooser(field, cachedLogins);
    } else {
      removeSuggestion();
    }
  };
  lockedResume = finishUnlock;

  let verifying = false;
  const doVerify = async () => {
    if (verifying) return;
    const pin = input.value.trim();
    if (pin.length < 4) return;
    verifying = true;
    setStatus("Verifying...", false);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "verifyPin", pin });
    } catch (err) {
      verifying = false;
      setStatus("Verification failed, try again", true);
      return;
    }
    verifying = false;
    if (res?.ok && res.state === "unlocked") {
      finishUnlock();
    } else {
      // the attempt burned that challenge, so the background already put a new code on the Mac
      const base = res?.error || "Verification failed";
      setStatus(res?.newCode ? `${base} - enter the new code on ${place}` : base, true);
      input.value = "";
      input.focus();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.key === "Enter") doVerify();
  });
  input.addEventListener("input", () => {
    if (input.value.trim().length === 6) doVerify();
  });

  setTimeout(() => input.focus(), 0);
}

function isNewPasswordField(el) {
  if (!isPasswordField(el)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("current-password")) return false;
  if (ac.includes("new-password")) return true;
  const pwCount = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible).length;
  if (pwCount >= 2) return true;
  return Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]")).some((b) =>
    /\b(sign[\s-]?up|register|create[\s-]?account|create[\s-]?your[\s-]?account)\b/i.test(b.textContent || b.value || ""),
  );
}

// react can remount the input between dropdown build and click, so re-resolve the node
function liveField(field) {
  if (!field || field.isConnected) return field;
  if (field.id) {
    const byId = document.getElementById(field.id);
    if (byId instanceof HTMLInputElement) return byId;
  }
  if (field.name) {
    const byName = document.querySelector(`input[name="${CSS.escape(field.name)}"]`);
    if (byName instanceof HTMLInputElement) return byName;
  }
  return anchorPwField(document) || field;
}

async function fillGeneratedPassword(field, pw) {
  field = liveField(field);
  const targets = new Set([field]);
  for (const p of Array.from(document.querySelectorAll('input[type="password"]')).filter(isFillable)) {
    if (p === field || p.value) continue;
    if (p.form && field.form && p.form !== field.form) continue;
    targets.add(p);
  }
  for (const t of targets) {
    setValue(t, pw);
    everPassword.add(t);
  }
  try {
    lastGenerated = { host: location.hostname, passwordHash: await sha256Hex(pw), at: Date.now() };
  } catch {}
}

// More than six saved logins scrolls inside the menu. Search is a case-insensitive
// username substring. One saved login still fills without this list. A filter that
// leaves one row does not fill until Enter or a click. Zero matches shows an empty
// list and types nothing.
const LOGIN_LIST_CAP = 6;
const LOGIN_ROW_PX = 40;

function pageUsernameQuery(field) {
  if (!field || isPasswordField(field)) return "";
  return (field.value || "").trim().toLowerCase();
}

function usernameMatches(login, query) {
  if (!query) return true;
  return (login.username || "").toLowerCase().includes(query);
}

function fitLoginScroller(scroller) {
  if (!anchorField || !suggestionEl) return;
  const r = anchorField.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const GAP = 6;
  const chrome = Math.max(0, suggestionEl.offsetHeight - scroller.offsetHeight);
  const below = vh - 8 - (r.bottom + GAP) - chrome;
  const above = r.top - GAP - 8 - chrome;
  const room = Math.max(below, above);
  const row = scroller.firstElementChild?.offsetHeight || LOGIN_ROW_PX;
  const cap = (row > 0 ? row : LOGIN_ROW_PX) * LOGIN_LIST_CAP;
  const max = Math.min(cap, Math.max(row > 0 ? row : LOGIN_ROW_PX, room));
  scroller.style.maxHeight = `${Math.round(max)}px`;
  scroller.style.overflowX = "hidden";
  scroller.style.overflowY = "auto";
  scroller.style.overscrollBehavior = "contain";
}

// fill routes through the origin-checked background path, page never sees the password
function appendLoginRows(box, field, logins) {
  for (const login of logins) {
    const label = login.username || "(no username)";
    const row = document.createElement("div");
    row.title = label;
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "10px 12px",
      cursor: "pointer",
      minWidth: "0",
    });
    const name = document.createElement("span");
    name.textContent = label;
    Object.assign(name.style, {
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontWeight: "500",
    });
    const hint = document.createElement("span");
    hint.textContent = "Fill";
    Object.assign(hint.style, {
      flex: "none",
      color: "#0a84ff",
      fontWeight: "600",
      fontSize: "12px",
    });
    row.append(name, hint);
    let busy = false;
    registerRow(row, async () => {
      if (busy) return;
      busy = true;
      fillAnchor = field;
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: "inlineFill", loginName: login });
      } catch {
        res = null;
      }
      if (res?.ok && res.filled) {
        removeSuggestion();
        return;
      }
      busy = false;
      hint.textContent = res?.error || "Couldn't fill this page.";
      hint.style.color = "#ff453a";
      hint.style.fontWeight = "500";
      hint.style.whiteSpace = "normal";
      hint.style.textAlign = "right";
      hint.style.maxWidth = "12em";
      positionBox();
    });
    box.appendChild(row);
  }
}

function mountLoginList(box, field, logins, hasGenerator) {
  const capped = logins.length > LOGIN_LIST_CAP;
  let query = pageUsernameQuery(field);
  let search = null;

  if (capped) {
    search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search usernames";
    search.setAttribute("aria-label", "Search usernames");
    search.autocomplete = "off";
    search.spellcheck = false;
    search.autocapitalize = "off";
    search.value = isPasswordField(field) ? "" : field.value || "";
    Object.assign(search.style, {
      display: "block",
      margin: "8px 10px",
      width: "calc(100% - 20px)",
      boxSizing: "border-box",
      padding: "7px 10px",
      font: `13px ${UI_FONT}`,
      border: "1px solid rgba(128,128,128,0.35)",
      borderRadius: "10px",
      background: "Canvas",
      color: "CanvasText",
    });
    search.style.setProperty("background", "light-dark(rgba(255,255,255,0.55), rgba(0,0,0,0.28))");
    search.addEventListener("mousedown", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase();
      render();
    });
    box.appendChild(search);
    loginSearchEl = search;
  }

  const scroller = document.createElement("div");
  scroller.setAttribute("data-passbridge-login-list", "1");
  box.removeAttribute("role");
  box.removeAttribute("aria-label");
  scroller.setAttribute("role", "listbox");
  scroller.setAttribute("aria-label", "Saved logins");
  box.appendChild(scroller);

  const genHost = document.createElement("div");
  let pinnedNav = [];
  if (hasGenerator) {
    box.appendChild(genHost);
    const saved = navItems;
    navItems = [];
    appendGeneratorOptions(genHost, field, true);
    pinnedNav = navItems.slice();
    navItems = saved;
  }

  const render = () => {
    navItems = [];
    navIndex = -1;
    scroller.replaceChildren();
    const matched = logins.filter((login) => usernameMatches(login, query));
    if (!matched.length) {
      const empty = document.createElement("div");
      empty.textContent = "No matching usernames";
      Object.assign(empty.style, { padding: "10px 12px", opacity: "0.65" });
      scroller.appendChild(empty);
    } else {
      appendLoginRows(scroller, field, matched);
    }
    for (const item of pinnedNav) navItems.push(item);
    positionBox();
  };

  if (!isPasswordField(field)) {
    const onInput = () => {
      if (!suggestionEl || anchorField !== field) return;
      const raw = field.value || "";
      query = raw.trim().toLowerCase();
      if (search && search.value !== raw) search.value = raw;
      render();
    };
    field.addEventListener("input", onInput);
    loginListUnbind = () => field.removeEventListener("input", onInput);
  }

  if (capped) loginListReflow = () => fitLoginScroller(scroller);
  render();
}

function appendGeneratorOptions(box, field, separatorAbove) {
  const options = [
    { label: "Strong Password", value: generateApplePassword() },
    { label: "Without Special Characters", value: generateAlphanumericPassword() },
  ];
  options.forEach((opt, idx) => {
    const item = document.createElement("div");
    item.setAttribute("data-op-generate", "1");
    Object.assign(item.style, {
      padding: "8px 12px",
      cursor: "pointer",
      borderTop: idx === 0 && separatorAbove ? "1px solid rgba(128,128,128,0.25)" : "none",
    });
    const label = document.createElement("div");
    label.textContent = opt.label;
    Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });
    const preview = document.createElement("div");
    preview.textContent = opt.value;
    Object.assign(preview.style, {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "12px",
      opacity: "0.65",
      marginTop: "2px",
    });
    item.append(label, preview);
    registerRow(item, () => {
      fillGeneratedPassword(field, opt.value);
      removeSuggestion();
    });
    box.appendChild(item);
  });
}

function deepActiveElement() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// a stale async read from an earlier focus must not draw over a newer one
let offerSeq = 0;

// fetch before building so an empty result never flashes a box on then off
async function buildOfferSuggestion(field) {
  const hasGenerator = isNewPasswordField(field);
  const seq = ++offerSeq;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineLogins" });
  } catch {
    res = null;
  }
  if (seq !== offerSeq || field !== deepActiveElement()) return;

  const locked = !!(res?.ok && res.locked);
  const logins = res?.ok && !locked ? res.logins || [] : [];
  if (!locked && !logins.length && !hasGenerator) return;

  const box = buildSuggestionBox(field);
  if (locked) {
    const row = document.createElement("div");
    row.textContent = "Unlock to autofill…";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    registerRow(row, () => buildLockedSuggestion(field));
    box.appendChild(row);
    if (hasGenerator) appendGeneratorOptions(box, field, true);
    positionBox();
    return;
  }

  if (logins.length) mountLoginList(box, field, logins, hasGenerator);
  else if (hasGenerator) {
    appendGeneratorOptions(box, field, false);
    positionBox();
  }
}

// codes are always an offer behind a click, never filled because a field appeared, a code is a bearer credential
let otpFilling = false;

function otpBoxGroup(el) {
  const scope = el.form || el.closest("div, section, fieldset") || document;
  const inputs = Array.from(scope.querySelectorAll("input")).filter(
    (i) => isVisible(i) && !i.disabled && !i.readOnly
  );
  // spotify sets no maxlength and clamps in JS, so a shared one-time-code autocomplete also marks a row
  const sized = inputs.filter((i) => parseInt(i.getAttribute("maxlength") || "0", 10) === 1);
  if (sized.includes(el) && sized.length >= 4) return sized;
  const tagged = inputs.filter((i) => OTP_AUTOCOMPLETE.test(i.getAttribute("autocomplete") || ""));
  if (tagged.includes(el) && tagged.length >= 4) return tagged;
  return null;
}

function fillOtp(field, code) {
  const chars = code.replace(/[^A-Za-z0-9]/g, "").split("");
  const boxes = otpBoxGroup(field);
  otpFilling = true;
  try {
    if (!boxes) {
      field.focus();
      setValue(field, chars.join(""));
      return;
    }
    const start = Math.max(0, boxes.indexOf(field));
    chars.forEach((c, i) => {
      const box = boxes[start + i];
      if (!box) return;
      box.focus();
      setValue(box, c);
      // some widgets advance focus on keyup rather than on input
      box.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
    });
    boxes[Math.min(start + chars.length - 1, boxes.length - 1)]?.focus();
  } finally {
    // release after the focus events settle
    setTimeout(() => { otpFilling = false; }, 0);
  }
}

function otpTargetField() {
  const anchored = liveField(otpAnchor);
  if (anchored instanceof HTMLInputElement && anchored.isConnected && isOtpField(anchored)) return anchored;
  const a = deepActiveElement();
  if (a instanceof HTMLInputElement && isOtpField(a) && isVisible(a)) return a;
  return Array.from(document.querySelectorAll("input")).find((i) => isOtpField(i) && isVisible(i)) || null;
}

// no innerHTML on a page we dont control
function codeIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.style.opacity = "0.5";
  svg.style.flex = "none";
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", "12");
  ring.setAttribute("cy", "12");
  ring.setAttribute("r", "9");
  const hands = document.createElementNS(NS, "path");
  hands.setAttribute("d", "M12 7v5l3 2");
  svg.append(ring, hands);
  return svg;
}

function appendOneTimeCodeRows(box, field, rows) {
  for (const r of rows) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      padding: "8px 12px",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: "9px",
    });
    row.appendChild(codeIcon());
    const text = document.createElement("div");
    Object.assign(text.style, { minWidth: "0" });
    const label = document.createElement("div");
    label.textContent =
      r.source === "totp"
        ? r.domain
          ? `Verification code for ${r.domain}`
          : "Verification code"
        : "Code from Messages";
    Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });
    text.appendChild(label);
    if (r.username) {
      const sub = document.createElement("div");
      sub.textContent = r.username;
      Object.assign(sub.style, {
        fontSize: "12px",
        opacity: "0.65",
        marginTop: "1px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      text.appendChild(sub);
    }
    row.appendChild(text);
    registerRow(row, () => {
      removeSuggestion();
      otpAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFillOneTimeCode", id: r.id }).catch(() => {});
    });
    box.appendChild(row);
  }
}

async function buildOneTimeCodeSuggestion(field) {
  if (otpFilling) return;
  const seq = ++offerSeq;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineOneTimeCodes" });
  } catch {
    return;
  }
  if (seq !== offerSeq) return;
  // a split widget moves focus between its boxes during the lookup (react can swap the node), accept any box in the group
  const active = deepActiveElement();
  const group = otpBoxGroup(field);
  if (!field.isConnected || !(active === field || (group && group.includes(active)))) return;
  if (active !== field && active instanceof HTMLInputElement) field = active;
  if (!res?.ok) return;
  const locked = !!res.locked;
  const rows = res.rows || [];
  // a locked vault is worth a row only if this helper can offer codes at all
  if (!locked && !rows.length) return;
  if (locked && res.supported === false) return;

  const box = buildSuggestionBox(field);
  if (locked) {
    const row = document.createElement("div");
    row.textContent = "Unlock to fill verification codes…";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    registerRow(row, () => buildLockedSuggestion(field, () => buildOneTimeCodeSuggestion(field)));
    box.appendChild(row);
    positionBox();
    return;
  }
  appendOneTimeCodeRows(box, field, rows);
  positionBox();
}

function onShortcut() {
  const a = deepActiveElement();
  if (a instanceof HTMLInputElement && isVisible(a) && frameIsSafe()) {
    if (isOtpField(a)) return void buildOneTimeCodeSuggestion(a);
    if (isLoginField(a)) return void buildOfferSuggestion(a);
  }
  if (window !== window.top) return;
  const target = Array.from(document.querySelectorAll("input")).find((i) => isVisible(i) && isLoginField(i));
  if (target) target.focus();
}

function buildChooser(field, logins) {
  if (!logins.length) {
    removeSuggestion();
    return;
  }
  const box = buildSuggestionBox(field);
  mountLoginList(box, field, logins, false);
}

// excludes generic app hosting (firebaseapp, vercel) where anyone can deploy
const IFRAME_LOGIN_ALLOWLIST = [
  "accounts.google.com", "adyen.com", "affirm.com", "afterpay.com", "amazon.com", "amazoncognito.com",
  "appleid.apple.com", "atlassian.com", "auth0.com", "authkit.app", "awsapps.com", "b2clogin.com",
  "beyondidentity.com", "cash.app", "ciamlogin.com", "clearpay.co.uk", "clerk.accounts.dev", "clerk.com",
  "corbado.io", "cyberark.cloud", "delinea.app", "descope.com", "descope.io", "discord.com",
  "dropbox.com", "duosecurity.com", "dynamicauth.com", "facebook.com", "finicity.com", "force.com",
  "forgeblocks.com", "forgerock.com", "forgerock.io", "frontegg.com", "fusionauth.io", "github.com",
  "gitlab.com", "hanko.io", "idaptive.app", "jumpcloud.com", "kakao.com", "kinde.com", "klarna.com",
  "line.me", "link.com", "linkedin.com", "live.com", "loginradius.com", "magic.link",
  "microsoftonline.com", "mojoauth.com", "moneydesktop.com", "naver.com", "okta-emea.com", "okta.com",
  "oktapreview.com", "onelogin.com", "openlogin.com", "ory.sh", "oryapis.com", "paypal.com",
  "phasetwo.io", "ping-eng.com", "pingidentity.com", "pingone.com", "plaid.com", "privy.io",
  "propelauth.com", "propelauthtest.com", "razorpay.com", "reddit.com", "sailpoint.com", "salesforce.com",
  "secureauth.com", "securid.com", "shop.app", "shopify.com", "slack.com", "spotify.com", "stripe.com",
  "stytch.com", "supertokens.com", "tink.com", "transmitsecurity.io", "truelayer.com", "twitch.tv",
  "twitter.com", "userfront.com", "venmo.com", "verify.ibm.com", "vk.com", "web3auth.io", "workos.com",
  "x.com", "xecurify.com", "yahoo.com", "yandex.com", "yandex.ru", "zitadel.cloud",
];

// suffix match so "clerk.accounts.dev" matches without matching a bare "accounts.dev"
function isAllowlistedLoginHost(host) {
  host = host.toLowerCase();
  return IFRAME_LOGIN_ALLOWLIST.some((d) => host === d || host.endsWith("." + d));
}

function frameIsSafe() {
  try {
    if (!location.hostname || location.origin === "null") return false;
  } catch {
    return false;
  }
  if (window === window.top) return true;
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top.location.origin;
  } catch {
    return false;
  }
}

async function onFocusIn(e) {
  if (hostInList(location.hostname, pbSettings.blockedDomains)) return;
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (suggestionHost && (e.target === suggestionHost || path.includes(suggestionHost))) return;
  // focusin from inside a shadow root retargets to the host, composedPath has the real input
  const field = path[0] || e.target;
  if (field instanceof HTMLInputElement && field.type === "password") everPassword.add(field);
  if (field instanceof HTMLInputElement && isOtpField(field) && isVisible(field)) {
    if (!frameIsSafe() || pbSettings.inlineMenuVisibility === "off") return;
    placeFieldIcon(field);
    if (pbSettings.inlineMenuVisibility === "on-click") return;
    buildOneTimeCodeSuggestion(field);
    return;
  }
  if (!(field instanceof HTMLInputElement) || !isLoginField(field)) {
    removeIcon();
    return;
  }
  if (!frameIsSafe() || pbSettings.inlineMenuVisibility === "off") return;
  placeFieldIcon(field);
  if (pbSettings.inlineMenuVisibility === "on-click") return;
  // still offer on a pre-filled field (apple/chrome do), only stay quiet if we just filled it
  const v = (field.value || "").trim();
  if (v) {
    const justOurs =
      lastAutofill &&
      lastAutofill.host === location.hostname &&
      Date.now() - lastAutofill.at < 8000 &&
      (v === (lastAutofill.username || "") || (await passwordsMatch(lastAutofill.passwordHash, v)));
    if (justOurs) {
      removeSuggestion();
      return;
    }
  }
  buildOfferSuggestion(field);
}

document.addEventListener("focusin", onFocusIn, true);
// capture so Enter is intercepted before the page's own submit handling
document.addEventListener("keydown", onSuggestionKeydown, true);
// focusing auto-scrolls the field, which used to fire this and kill the offer
document.addEventListener("scroll", positionBox, true);
window.addEventListener("resize", positionBox, true);
// focus moving into the box (inline PIN field) is kept
document.addEventListener(
  "focusout",
  (e) => {
    if (!suggestionEl) return;
    if (e.target !== anchorField && e.target !== suggestionHost) return;
    const next = e.relatedTarget;
    if (
      next &&
      (next === suggestionHost ||
        next === iconHost ||
        next === anchorField ||
        next === loginSearchEl ||
        suggestionHost?.contains(next) ||
        suggestionEl.contains(next))
    ) {
      return;
    }
    // closed shadow often reports the next focus as null or the host
    if (document.activeElement === suggestionHost) return;
    const gen = menuGen;
    const field = anchorField;
    setTimeout(() => {
      if (gen !== menuGen || !suggestionEl) return;
      const active = document.activeElement;
      if (active === field || active === suggestionHost || active === iconHost) return;
      if (suggestionHost?.contains(active) || suggestionEl?.contains(active)) return;
      removeSuggestion();
    }, 0);
  },
  true,
);
document.addEventListener(
  "mousedown",
  (e) => {
    if (!suggestionEl) return;
    if (eventHitsMenu(e)) return;
    if (e.target === anchorField) return;
    // another login field's focusin rebuilds the offer, closing here first would race
    if (e.target instanceof HTMLInputElement && isLoginField(e.target)) return;
    removeSuggestion();
  },
  true,
);

let lastSaveKey = "";
let lastSaveAt = 0;

const SUBMITY_LABEL =
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|done|set|apply|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b/i;

// ids and names carry no word boundaries ("findpwd", "loginBtn"), so match bare substrings
const SUBMITY_ATTR = /pwd|passw|reset|submit|login|signin|confirm|continue|next|done|save|set|apply/i;

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  const attrs = `${el.getAttribute("name") || ""} ${el.id || ""}`;
  if (tag === "button" && (type === "" || type === "button")) {
    return SUBMITY_LABEL.test((el.textContent || el.value || "") ?? "") || SUBMITY_ATTR.test(attrs);
  }
  // old-school pages (tplink) submit via <input type=button value="OK">
  if (tag === "input" && type === "button") {
    return SUBMITY_LABEL.test(el.value || "") || SUBMITY_ATTR.test(attrs);
  }
  // styled div/a with role=button (sling reset pages)
  if ((el.getAttribute("role") || "").toLowerCase() === "button" || tag === "a") {
    return SUBMITY_LABEL.test((el.textContent || attrBlob(el)) ?? "");
  }
  return false;
}

function collectSubmittedCredentials(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const inputs = Array.from(root.querySelectorAll("input"));
  // a show-password toggle leaves the field type=text at submit
  const pws = inputs.filter((i) => isPasswordish(i) && i.value);
  if (!pws.length) return null;
  // "last" alone saved the OLD password when current sat below new + confirm
  let password = pws[pws.length - 1].value;
  const counts = new Map();
  for (const p of pws) counts.set(p.value, (counts.get(p.value) || 0) + 1);
  const dup = [...counts.entries()].find(([, n]) => n >= 2);
  const marked = pws.find((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));
  if (dup) password = dup[0];
  else if (marked) password = marked.value;
  const firstPw = pws[0];
  const before = (el) => el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING;

  // a password value in the username slot is what got saved on toggled reset forms
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i) => !isPasswordish(i) && !pwValues.has(i.value.trim());

  const strict = inputs.filter((i) => isUsernameField(i) && i.value && usable(i));
  const strictBefore = strict.filter(before);
  let userEl = strictBefore.length ? strictBefore[strictBefore.length - 1] : strict[0] || null;

  // reject junk so a reset doesnt save "9" as the name
  if (!userEl) {
    const looksLikeUsername = (v) => {
      v = (v || "").trim();
      if (v.length < 3) return false;
      if (/^\d+$/.test(v) && v.length < 6) return false; // a short number is a code, not a name
      return true;
    };
    const guess = inputs.filter((i) => {
      if (!i.value || !usable(i)) return false;
      if (isOtpField(i) || isSearchOrComboField(i)) return false;
      const t = (i.type || "text").toLowerCase();
      if (!["text", "email", "tel", ""].includes(t)) return false;
      if (NONLOGIN_HINT.test(attrBlob(i))) return false;
      if (!looksLikeUsername(i.value)) return false;
      return before(i);
    });
    userEl = guess.length ? guess[guess.length - 1] : null;
  }

  // a change form's last field is often the current password, so the caller can spot a generated value that isnt last
  return { username: (userEl?.value || "").trim(), password, allPasswords: pws.map((p) => p.value) };
}

function anchorPwField(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const pws = Array.from(scope.querySelectorAll("input")).filter(isPasswordish);
  return pws.find(isVisible) || pws[0] || null;
}

// awaiting the lookup here lost the save on a redirect
async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred || !cred.password) return;

  let generated = false;
  let savePassword = cred.password;
  if (lastGenerated && lastGenerated.passwordHash && Date.now() - lastGenerated.at < 600000) {
    for (const candidate of cred.allPasswords || []) {
      if (await passwordsMatch(lastGenerated.passwordHash, candidate)) {
        generated = true;
        savePassword = candidate;
        break;
      }
    }
  }

  // a login we just autofilled unchanged is not a save
  if (
    !generated &&
    lastAutofill &&
    lastAutofill.host === location.hostname &&
    lastAutofill.passwordHash &&
    Date.now() - lastAutofill.at < 300000 &&
    (await passwordsMatch(lastAutofill.passwordHash, cred.password))
  ) {
    console.debug("[PassBridge] save skipped: recently autofilled");
    return;
  }

  // 15s covers the click+submit+Enter burst ("shows up twice" fix)
  const key = `${location.hostname} ${cred.username || ""}`;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 15000) return;
  lastSaveKey = key;
  lastSaveAt = now;

  const root = scope && scope.querySelectorAll ? scope : document;
  const pwInputs = Array.from(root.querySelectorAll("input")).filter(isPasswordish);
  const newPwCtx =
    generated ||
    (cred.allPasswords || []).length >= 2 ||
    pwInputs.some((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));

  // fire and forget, awaiting would let a navigating submit kill us
  console.debug("[PassBridge] handing save to background", {
    host: location.hostname,
    user: cred.username || "(none)",
    generated,
    newPwCtx,
  });
  chrome.runtime
    .sendMessage({
      type: "resolveSave",
      username: cred.username,
      password: savePassword,
      generated,
      newPwCtx,
    })
    .catch(() => {});
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted) return;
    removeSuggestion();
    maybeOfferSave(e.target);
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl)) maybeOfferSave(ctrl.form || document);
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || e.key !== "Enter") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) {
      removeSuggestion(); // formless submit, Enter doesnt fire a submit event
      maybeOfferSave(t.form || document);
    }
  },
  true,
);

try {
  const menuPort = chrome.runtime.connect({ name: "autofill-inline-menu-list-port" });
  menuPort.onMessage.addListener((msg) => {
    if (msg?.command === "init" && anchorField) {
      const r = anchorField.getBoundingClientRect();
      const shift = frameShift();
      menuPort.postMessage({
        command: "fieldRect",
        portKey: msg.portKey,
        rect: { x: r.left + shift.x, y: r.top + shift.y, width: r.width, height: r.height },
      });
    }
  });
} catch {}

if (window === window.top) {
  const tryPageLoadFill = () => {
    if (!pbSettings.autofillOnPageLoad || !frameIsSafe()) return;
    chrome.runtime.sendMessage({ type: "inlineLogins" }).then((res) => {
      if (!res?.ok || res.locked || res.logins?.length !== 1) return;
      const field = Array.from(document.querySelectorAll("input")).find((i) => isVisible(i) && isLoginField(i));
      if (!field || (field.value || "").trim()) return;
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: res.logins[0] }).catch(() => {});
    }).catch(() => {});
  };
  if (document.readyState === "complete") tryPageLoadFill();
  else window.addEventListener("load", tryPageLoadFill, { once: true });
}

installQrPage();
