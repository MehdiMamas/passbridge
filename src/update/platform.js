// on Windows, Chrome asks before saving every .js file, so updates there go only through the helper
export const HELPER_ZIP_URL = "https://github.com/MehdiMamas/passbridge/releases/latest/download/passbridge-windows-helper.zip";

export function isWindows(nav = globalThis.navigator) {
  return /^win/i.test(nav?.userAgentData?.platform || nav?.platform || "");
}

// "native": the helper swaps the files. "helper": install it first. "folder": write through the picked folder
export function updateRoute({ windows, helper }) {
  if (!windows) return "folder";
  return helper ? "native" : "helper";
}
