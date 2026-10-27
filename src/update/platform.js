// on Windows, Chrome asks before saving every .js file, so the folder update needs the helper first
export const HELPER_ZIP_URL = "https://github.com/MehdiMamas/passbridge/releases/latest/download/passbridge-windows-helper.zip";

export function isWindows(nav = globalThis.navigator) {
  return /^win/i.test(nav?.userAgentData?.platform || nav?.platform || "");
}

export function helperFirst({ windows, helper, skipped }) {
  return !!windows && !helper && !skipped;
}
