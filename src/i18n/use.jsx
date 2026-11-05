import { useEffect, useState } from "react";
import { invalidateLocale, resolveLocale } from "./runtime.js";

// React pages: resolve the UI language once, then follow changes to the uiLanguage setting so a
// switch in the options page re-renders this page without a reload.
export function useLocale() {
  const [locale, setLocale] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    let dead = false;
    resolveLocale().then((l) => {
      if (!dead) setLocale(l);
    });
    /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
    const onChange = (changes, area) => {
      if (area === "sync" && changes.uiLanguage) {
        invalidateLocale();
        resolveLocale().then((l) => {
          if (!dead) setLocale(l);
        });
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      dead = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return locale;
}
