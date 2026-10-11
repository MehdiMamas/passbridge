import jsQR from "jsqr";

let timer = null;
let pending = "";

function fromExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && sender.tab == null;
}

// an offscreen page never has focus, so navigator.clipboard rejects here.
// execCommand works with the CLIPBOARD reason and the clipboardWrite/clipboardRead permissions.
function writeClipboard(text) {
  const area = document.createElement("textarea");
  area.value = text || " ";
  document.body.append(area);
  area.select();
  // the copy event sets the exact text, an empty string included
  const onCopy = (e) => {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true });
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
    area.remove();
  }
  return ok;
}

function readClipboard() {
  const area = document.createElement("textarea");
  document.body.append(area);
  area.focus();
  let ok = false;
  try {
    ok = document.execCommand("paste");
  } catch {}
  const value = area.value;
  area.remove();
  return ok ? value : null;
}

// leave the clipboard alone when the user copied something else since
function clearIfUnchanged(expected) {
  if (!expected) return;
  const current = readClipboard();
  if (current === null || current === expected) writeClipboard("");
  if (pending === expected) pending = "";
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "offscreenClear") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return false;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    clearIfUnchanged(pending);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "offscreenCopy") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return false;
    }
    const text = String(msg.text || "");
    const clearMs = Number(msg.clearMs) || 10000;
    let ok = false;
    try {
      ok = writeClipboard(text);
    } catch {}
    if (!ok) {
      sendResponse({ ok: false, error: "Couldn't write to the clipboard." });
      return false;
    }
    pending = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      clearIfUnchanged(pending);
    }, clearMs);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type !== "offscreenDecodeQr") return false;
  decodeQr(msg.dataUrl, msg.rect)
    .then((values) => sendResponse({ ok: true, values }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read the screenshot."));
    img.src = url;
  });
}

function readQr(img, x, y, w, h, scale) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
  return code?.data ? [code.data] : [];
}

async function decodeQr(dataUrl, rect) {
  const img = await loadImage(dataUrl);
  const dpr = Number(rect?.dpr) || 1;
  const pad = 16 * dpr;
  let x = Math.floor((Number(rect?.x) || 0) * dpr - pad);
  let y = Math.floor((Number(rect?.y) || 0) * dpr - pad);
  let w = Math.floor((Number(rect?.w) || 0) * dpr + pad * 2);
  let h = Math.floor((Number(rect?.h) || 0) * dpr + pad * 2);
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > img.width) w = img.width - x;
  if (y + h > img.height) h = img.height - y;
  w = Math.max(1, w);
  h = Math.max(1, h);
  const scale = Math.max(1, Math.min(3, 240 / Math.max(w, h)));
  const first = readQr(img, x, y, w, h, scale);
  if (first.length) return first;
  if (scale >= 2) return [];
  return readQr(img, x, y, w, h, Math.min(3, scale * 2));
}
