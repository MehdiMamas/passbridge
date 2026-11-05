// shared wording for the machine that shows the 6-digit pairing code

// protocol wording (sent to Apple's Passwords app, always English)
/**
 * @param {string | undefined} os
 */
export function labelForOs(os) {
  if (os === "win") return "your PC";
  if (os === "mac") return "your Mac";
  return "this computer";
}

// UI wording: the same device in the extension's own language
/**
 * @param {string | undefined} os
 * @param {(key: string) => string} t
 */
export function uiDeviceLabel(os, t) {
  if (os === "win") return t("deviceWin");
  if (os === "mac") return t("deviceMac");
  return t("deviceOther");
}
