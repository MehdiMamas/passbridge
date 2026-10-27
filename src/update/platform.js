// on Windows, Chrome asks before saving every .js file, so updates there go through the helper unless the user picks the folder update
export const HELPER_ZIP_URL = "https://github.com/MehdiMamas/passbridge/releases/latest/download/passbridge-windows-helper.zip";

export function isWindows(nav = globalThis.navigator) {
  return /^win/i.test(nav?.userAgentData?.platform || nav?.platform || "");
}

// "native": the helper swaps the files. "helper": install it first. "folder": write through the picked folder
export function updateRoute({ windows, helper, noHelper = false }) {
  if (!windows) return "folder";
  if (helper) return "native";
  return noHelper ? "folder" : "helper";
}
