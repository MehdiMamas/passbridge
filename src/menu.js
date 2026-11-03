// the right-click menu: only items that can work on this page, built fresh for the active tab
import { resolveLocale, t } from "./i18n/runtime.js";

const ON_PAGE = ["editable", "page"];

// resolve the UI language in the background's lifetime; t() falls back to en until it lands
void resolveLocale();

/**
 * @param {{ ready: boolean, onSite?: boolean, logins: { username?: string }[], hasCode: boolean, hasGenerated?: boolean }} state
 * ready: the vault is unlocked; onSite: the tab is a web page that can have logins
 * @returns {chrome.contextMenus.CreateProperties[]}
 */
export function menuItems({ ready, onSite = true, logins, hasCode, hasGenerated = false }) {
  const items = [{ id: "pb-root", title: t("menuRoot"), contexts: ["editable", "page", "image"] }];
  const add = (props) => items.push({ parentId: "pb-root", contexts: ON_PAGE, ...props });
  if (!ready) {
    add({ id: "pb-unlock", title: t("menuUnlock") });
  } else if (!onSite) {
    // settings and chrome:// pages have nothing to fill
  } else if (logins.length === 1) {
    const name = logins[0].username;
    add({ id: "pb-fill-0", title: name ? t("menuFillName", [name]) : t("menuFillLogin") });
    if (name) add({ id: "pb-user-0", title: t("menuCopyUsername") });
    add({ id: "pb-pass-0", title: t("menuCopyPassword") });
  } else if (logins.length) {
    logins.forEach((login, i) => {
      add({ id: `pb-acct-${i}`, title: login.username || t("menuNoUsername") });
      const sub = (props) => items.push({ parentId: `pb-acct-${i}`, contexts: ON_PAGE, ...props });
      sub({ id: `pb-fill-${i}`, title: t("menuFill") });
      if (login.username) sub({ id: `pb-user-${i}`, title: t("menuCopyUsername") });
      sub({ id: `pb-pass-${i}`, title: t("menuCopyPassword") });
    });
  } else {
    add({ id: "pb-none", title: t("menuNone"), enabled: false });
  }
  if (ready && hasCode) add({ id: "pb-otp", title: t("menuCopyCode") });
  add({ id: "pb-sep-1", type: "separator" });
  add({ id: "pb-gen", title: t("menuFillStrong"), contexts: ["editable"] });
  add({ id: "pb-gen-alnum", title: t("menuFillAlnum"), contexts: ["editable"] });
  add({ id: "pb-gen-copy", title: t("menuCopyStrong"), contexts: ["page"] });
  add({ id: "pb-gen-copy-alnum", title: t("menuCopyAlnum"), contexts: ["page"] });
  if (hasGenerated) add({ id: "pb-gen-last", title: t("menuCopyGenerated") });
  add({ id: "pb-qr-image", title: t("menuScanImage"), contexts: ["image"] });
  add({ id: "pb-sep-2", type: "separator", contexts: ["page"] });
  add({ id: "pb-report", title: t("menuReport"), contexts: ["page"] });
  return items;
}

/** @returns {{ action: string, index: number } | null} "pb-pass-2" → { action: "pass", index: 2 } */
export function loginAction(menuItemId) {
  const m = /^pb-(fill|user|pass)-(\d+)$/.exec(String(menuItemId));
  return m ? { action: m[1], index: Number(m[2]) } : null;
}
export function send(msg) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "no extension" });
      return;
    }
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}
