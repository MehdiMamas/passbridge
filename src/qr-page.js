import { frameOffsetFromWindow } from "./adapter/frame-offset.js";

let qrImageEl = null;
let qrImageAt = 0;
let totpHost = null;
let totpOnMsg = null;

function asPicture(node) {
  if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement || node instanceof SVGSVGElement) return node;
  if (node instanceof HTMLPictureElement) return node.querySelector("img");
  if (node instanceof SVGElement && node.ownerSVGElement) return node.ownerSVGElement;
  return null;
}

function pictureFromEvent(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const node of path) {
    const found = asPicture(node);
    if (found) return found;
  }
  if (!(e.target instanceof Element)) return null;
  return asPicture(e.target.closest("img, canvas, svg, picture"));
}

export function installQrPage() {
  document.addEventListener("contextmenu", (e) => {
    const el = pictureFromEvent(e);
    if (!el) return;
    qrImageEl = el;
    qrImageAt = Date.now();
  }, true);
}

export function qrImageRect() {
  const img = qrImageEl;
  if (!img || !img.isConnected || Date.now() - qrImageAt > 10000) return null;
  const r = img.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const off = frameOffsetFromWindow(window);
  return {
    x: r.left + off.x,
    y: r.top + off.y,
    w: r.width,
    h: r.height,
    dpr: window.devicePixelRatio || 1,
  };
}

export function hideTotpBar() {
  if (totpOnMsg) {
    window.removeEventListener("message", totpOnMsg);
    totpOnMsg = null;
  }
  if (!totpHost) return;
  try { totpHost.hidePopover?.(); } catch {}
  totpHost.remove();
  totpHost = null;
}

export function showTotpBar(payload) {
  hideTotpBar();
  const host = document.createElement("div");
  host.setAttribute("data-passbridge-totp", "1");
  host.setAttribute("popover", "manual");
  const shadow = host.attachShadow({ mode: "closed" });
  const iframe = document.createElement("iframe");
  const token = Math.random().toString(36).slice(2);
  Object.assign(iframe.style, {
    width: "360px",
    height: "48px",
    border: "none",
    background: "transparent",
    overflow: "hidden",
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
    height: "48px",
    overflow: "hidden",
  });
  (document.body || document.documentElement).appendChild(host);
  try { host.showPopover(); } catch {}
  totpHost = host;
  const paint = () => {
    iframe.contentWindow?.postMessage({
      token,
      type: "totp-bar",
      mode: payload.mode,
      issuer: payload.issuer || "",
      account: payload.account || "",
      usernames: payload.usernames || [],
      error: payload.error || "",
      filled: !!payload.filled,
      detail: payload.detail || "",
    }, "*");
  };
  iframe.addEventListener("load", paint);
  iframe.src = chrome.runtime.getURL(`overlay/totp-bar.html?token=${token}`);
  let pending = false;
  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow || e.data?.token !== token) return;
    if (e.data.action === "ready") {
      paint();
      return;
    }
    if (e.data.action === "resize") {
      const h = Math.max(48, Math.min(420, Number(e.data.height) || 0));
      iframe.style.height = `${h}px`;
      host.style.height = `${h}px`;
      return;
    }
    if (pending) return;
    const action = e.data.action;
    if (action === "choose" || action === "create") {
      pending = true;
      chrome.runtime.sendMessage({ type: "confirmTotp" }, (resp) => {
        void chrome.runtime.lastError;
        showTotpBar(resp?.ok
          ? { mode: "copied", filled: !!resp.filled, detail: resp.detail || "" }
          : { mode: "error", error: resp?.error || "Couldn't add a verification code." });
      });
      return;
    }
    hideTotpBar();
    chrome.runtime.sendMessage({ type: "dismissTotp" }).catch(() => {});
  };
  totpOnMsg = onMsg;
  window.addEventListener("message", onMsg);
}
