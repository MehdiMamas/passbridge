// @ts-check
// shared wording for the machine that shows the 6-digit pairing code

export function labelForOs(os) {
  if (os === "win") return "your PC";
  if (os === "mac") return "your Mac";
  return "this computer";
}
