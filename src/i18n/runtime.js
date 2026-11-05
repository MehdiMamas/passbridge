// i18n: every user-facing string lives in _locales/<locale>/messages.json (Chrome's catalog format).
// The UI language is the "uiLanguage" setting when the user picked one, else Chrome's UI language.
// Chrome's own chrome.i18n.getMessage() follows the browser UI language and cannot be overridden, so the
// pages and content scripts read the catalogs below directly; the manifest still uses __MSG_ keys for
// name, description and command descriptions, which Chrome localizes from _locales itself.

import en from "../../_locales/en/messages.json" with { type: "json" };
import zhCN from "../../_locales/zh_CN/messages.json" with { type: "json" };
import zhTW from "../../_locales/zh_TW/messages.json" with { type: "json" };
import { settingsStore } from "../settings.js";

/** @typedef {Record<string, Record<string, { message: string }>>} CatalogMap */

export const CATALOGS = { en, zh_CN: zhCN, zh_TW: zhTW };
export const SUPPORTED_LOCALES = Object.keys(CATALOGS);
export const DEFAULT_LOCALE = "en";

// shown in the options language picker, in each language's own name
export const LOCALE_NAMES = {
  en: "English",
  zh_CN: "简体中文",
  zh_TW: "繁體中文",
};

/**
 * Map a Chrome UI language ("zh-CN", "zh-Hans", "pt-BR", "ja") to a supported catalog, or null.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeLocale(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[- ]/g, "_");
  if (/** @type {CatalogMap} */ (CATALOGS)[s]) return s;
  const lower = s.toLowerCase();
  for (const key of SUPPORTED_LOCALES) if (key.toLowerCase() === lower) return key;
  const base = lower.split("_")[0];
  if (base === "zh") return SUPPORTED_LOCALES.includes("zh_CN") ? "zh_CN" : null;
  const matches = SUPPORTED_LOCALES.filter((k) => k.toLowerCase().split("_")[0] === base);
  return matches[0] || null;
}

/**
 * Replace $1..$9 in a message. Out-of-range substitutions become empty, so a catalog never
 * shows "$2" because a caller passed one argument.
 * @param {string} message
 * @param {unknown[] | undefined} subs
 * @returns {string}
 */
export function substitute(message, subs) {
  if (!subs?.length) return message;
  return message.replace(/\$(\d+)/g, (_, d) => {
    const v = subs[Number(d) - 1];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** @type {string | null} */
let locale = null;
/** @type {Promise<string> | null} */
let pending = null;

/** @param {string} next @returns {void} */
export function setLocale(next) {
  locale = /** @type {CatalogMap} */ (CATALOGS)[next] ? next : null;
}

/** drop the cache so resolveLocale() picks up a changed setting @returns {void} */
export function invalidateLocale() {
  locale = null;
  pending = null;
}

/** @returns {string | null} the resolved locale, before resolution finishes */
export function getLocale() {
  return locale;
}

/**
 * Resolve and cache the UI locale: the stored override first, then Chrome's UI language.
 * Safe to call without chrome (unit tests): falls back to en.
 * @returns {Promise<string>}
 */
export function resolveLocale() {
  if (locale) return Promise.resolve(locale);
  if (!pending) {
    pending = (async () => {
      let raw = "";
      try {
        const got = await settingsStore().get({ uiLanguage: "" });
        raw = /** @type {string} */ (got?.uiLanguage || "");
      } catch (_) {
        raw = "";
      }
      if (!raw) {
        try {
          raw = chrome?.i18n?.getUILanguage?.() || "";
        } catch (_) {
          raw = "";
        }
      }
      locale = normalizeLocale(raw) || DEFAULT_LOCALE;
      return locale;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Translate a key in the resolved locale, with en fallback for a missing key or catalog entry.
 * Never throws: an unknown key renders as itself so a typo is visible instead of a blank string.
 * @param {string} key
 * @param {unknown[]} [subs]
 * @returns {string}
 */
export function t(key, subs) {
  const catalogs = /** @type {CatalogMap} */ (CATALOGS);
  const catalog = (locale && catalogs[locale]) || catalogs[DEFAULT_LOCALE];
  const entry = catalog[key] || catalogs[DEFAULT_LOCALE][key];
  if (!entry?.message) return key;
  return subs ? substitute(entry.message, subs) : entry.message;
}

/**
 * Point <html lang> and the document title at the resolved locale. Call once per page after boot.
 * @param {Document} doc
 * @param {string} [titleKey] message key for document.title, or the current title
 * @returns {Promise<void>}
 */
export async function applyDocumentLanguage(doc, titleKey) {
  const l = await resolveLocale();
  if (doc?.documentElement) doc.documentElement.lang = l.replace("_", "-");
  if (titleKey) doc.title = t(titleKey);
}
