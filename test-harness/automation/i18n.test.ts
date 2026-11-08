// i18n suite: catalog parity, locale resolution, substitution, manifest wiring and menu output.
import { readFileSync } from "fs";
import { resolveLocale, setLocale, normalizeLocale, substitute, t, SUPPORTED_LOCALES } from "../../src/i18n/runtime.js";
import { menuItems } from "../../src/menu.js";
import { SETTINGS_DEFAULTS } from "../../src/settings.js";

let failed = 0;
function ok(name: string, cond: unknown, _detail?: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const en = JSON.parse(readFileSync(new URL("../../_locales/en/messages.json", import.meta.url), "utf8"));

// every shipped catalog has exactly the en keys
for (const locale of SUPPORTED_LOCALES) {
  const cat = JSON.parse(readFileSync(new URL(`../../_locales/${locale}/messages.json`, import.meta.url), "utf8"));
  const keys = Object.keys(cat);
  ok(`catalog ${locale}: same key count as en (${keys.length})`, keys.length === Object.keys(en).length);
  ok(`catalog ${locale}: every en key present`, Object.keys(en).every((k) => k in cat));
  const broken = keys.filter((k) => typeof cat[k]?.message !== "string");
  ok(`catalog ${locale}: every entry carries a message`, broken.length === 0, broken.join(", ") || undefined);
  const phMismatch = keys.filter((k) =>
    JSON.stringify(Object.keys(en[k].placeholders || {})) !== JSON.stringify(Object.keys(cat[k]?.placeholders || {})));
  ok(`catalog ${locale}: placeholders match en`, phMismatch.length === 0, phMismatch.join(", ") || undefined);
}

const chromeOnly = Object.keys(en).filter((k) => /\bChrome\b/.test(en[k].message));
ok("copy en: no message names Chrome, every Chromium browser runs PassBridge", chromeOnly.length === 0, chromeOnly.join(", ") || undefined);

// one name per thing in the en copy
const MIXED_NAMES: [RegExp, string][] = [
  [/System default/, "System"],
  [/iCloud Keychain|Apple Passwords|Passwords vault/, "iCloud Passwords"],
  [/(?:\bin|\bto|\bopen) Passwords\b(?! app)|^Passwords\b(?! app)/, "the Passwords app"],
  [/\bPassword helper\b|Passwords helper|updater helper|PassBridge helper not reachable/, "Apple's password helper or the PassBridge helper"],
  [/Needs the verification code|verification code was|Enter the code|for a new code|the new code\b|Request a new code/, "unlock code"],
  [/Look up/, "Search"],
  [/\bLet agents\b/, "Allow"],
  [/Create a login|New login in/, "Add login"],
  [/No saved passwords|No saved login\b/, "No saved logins"],
  [/fully quit|Restart your browser/i, "Quit and reopen the browser"],
  [/What's new on GitHub/, "View release"],
  [/Code from Messages/, "Verification code from Messages"],
  [/Click Update again/, "Update now"],
  [/without Touch ID/, "Windows Hello on the Windows-only passkey row"],
];
for (const [re, name] of MIXED_NAMES) {
  const hits = Object.keys(en).filter((k) => re.test(en[k].message));
  ok(`copy en: one name per thing, say ${name}`, hits.length === 0, hits.join(", ") || undefined);
}

// ellipsis: only on a label that asks for more input before it finishes, and always the single character
const ASKS_FOR_INPUT = ["addLogin", "addCode", "newLoginInPasswords", "createLogin", "menuUnlock", "menuReport", "reportThisPage", "unlockAutofill", "unlockCodes", "passkeyImportBtn", "changeFolder", "shortcutsBtn"];
const OPENS_ONLY = ["settings", "openInPasswords", "searchUserInPasswords", "pmOpen", "passkeysBtn", "checkNow", "viewRelease", "whatsNew"];
const missingDots = ASKS_FOR_INPUT.filter((k) => !en[k].message.endsWith("…"));
ok("copy en: a label that asks for more input ends with …", missingDots.length === 0, missingDots.join(", ") || undefined);
const extraDots = OPENS_ONLY.filter((k) => en[k].message.endsWith("…"));
ok("copy en: a label that only opens a page has no …", extraDots.length === 0, extraDots.join(", ") || undefined);
const threeDots = Object.keys(en).filter((k) => en[k].message.includes("..."));
ok("copy en: ellipsis is one character, not three dots", threeDots.length === 0, threeDots.join(", ") || undefined);

// writing style in the en copy
const STYLE: [RegExp, string][] = [
  [/!/, "no exclamation marks"],
  [/Strong Password|Special Characters/, "sentence case"],
  [/^(?:Fill|Copy) password without/, "a password without special characters"],
  [/This QR\b|\bQR is\b/, "That QR code"],
  [/otpauth/, "setup key, not the link scheme"],
  [/^Off by default\./, "no default in the help line, the switch shows it"],
  [/^When the /, "a help line is a full sentence"],
];
for (const [re, rule] of STYLE) {
  const hits = Object.keys(en).filter((k) => re.test(en[k].message));
  ok(`copy en: style, ${rule}`, hits.length === 0, hits.join(", ") || undefined);
}

// locale resolution
ok("normalize: zh-CN and zh map to zh_CN", normalizeLocale("zh-CN") === "zh_CN" && normalizeLocale("zh") === "zh_CN");
ok("normalize: en-US and en map to en", normalizeLocale("en-US") === "en" && normalizeLocale("en") === "en");
ok("normalize: an unsupported language is null", normalizeLocale("fr") === null && normalizeLocale("pt-BR") === null);
ok("normalize: empty or garbage is null", normalizeLocale("") === null && normalizeLocale(undefined) === null);
ok("resolveLocale falls back to en without chrome", await resolveLocale() === "en");

// substitution
ok("substitute: $1 is replaced", substitute("Fill $1", ["ada@example.com"]) === "Fill ada@example.com");
ok("substitute: $1..$2 in order", substitute("$1 — $2", ["err", "your Mac"]) === "err — your Mac");
ok("substitute: missing subs become empty", substitute("$1 and $2", ["only"]) === "only and ");
ok("substitute: no subs leaves the message", substitute("plain", []) === "plain");

// t() behaviour
setLocale("en");ok("t: en value", t("unlock") === "Unlock");
ok("t: placeholder filled", t("menuFillName", ["ada@example.com"]) === "Fill ada@example.com");
ok("t: unknown key renders itself", t("noSuchKey") === "noSuchKey");
setLocale("zh_CN");
ok("t: zh_CN value", t("unlock") === en.unlock.message || /[一-鿿]/.test(t("unlock")));
ok("t: zh_CN placeholder filled", !t("menuFillName", ["ada@example.com"]).includes("$1"));
const zhCat = JSON.parse(readFileSync(new URL("../../_locales/zh_CN/messages.json", import.meta.url), "utf8"));
const translated = Object.keys(zhCat).filter((k) => zhCat[k].message !== en[k].message).length;
ok("zh_CN: most messages are actually translated", translated >= Object.keys(en).length * 0.9, `${translated}/${Object.keys(en).length}`);
setLocale((null as any));
ok("t: unresolved locale falls back to en", t("unlock") === "Unlock");

// manifest wiring
const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
ok("manifest: default_locale is en", manifest.default_locale === "en");
ok("manifest: name and description use __MSG_", manifest.name === "__MSG_extensionName__" && manifest.description === "__MSG_extensionDescription__");
ok("manifest: extensionName and extensionDescription exist in en", "extensionName" in en && "extensionDescription" in en);
ok("manifest: action title uses __MSG_extensionName__", manifest.action.default_title === "__MSG_extensionName__");
for (const cmd of Object.values<any>(manifest.commands || {})) {
  const key = /^__MSG_([A-Za-z0-9_]+)__$/.exec(cmd.description)?.[1];
  ok(`manifest: command description ${key}`, !!key && key in en);
}

// settings
ok("settings: uiLanguage default follows the system", SETTINGS_DEFAULTS.uiLanguage === "");

// menu items stay addressable and carry localized titles
setLocale("en");
const items = menuItems({ ready: true, onSite: true, logins: [{ username: "ada@example.com" }], hasCode: true });
ok("menu: ids unchanged", items.some((i) => i.id === "pb-root") && items.some((i) => i.id === "pb-fill-0"));
ok("menu: titles come from the catalog", (items.find((i) => i.id === "pb-root") as any).title === "PassBridge" && items.find((i) => i.id === "pb-copy-username" || i.id === "pb-user-0")?.title === "Copy username");
ok("menu: fill title carries the username", (items.find((i) => i.id === "pb-fill-0") as any).title === "Fill ada@example.com");
const none = menuItems({ ready: true, onSite: true, logins: [], hasCode: false });
ok("menu: empty site shows the greyed note", (none.find((i) => i.id === "pb-none") as any).title === "No saved logins for this site" && (none.find((i) => i.id === "pb-none") as any).enabled === false);

// icon-click empty row key exists in every locale
for (const locale of SUPPORTED_LOCALES) {
  const cat = JSON.parse(readFileSync(new URL(`../../_locales/${locale}/messages.json`, import.meta.url), "utf8"));
  ok(`catalog ${locale}: inlineNoLogins present`, typeof cat.inlineNoLogins?.message === "string" && cat.inlineNoLogins.message.length > 0);
}

console.log("" + (failed ? `i18n: ${failed} FAIL` : "i18n ok"));
process.exit(failed ? 1 : 0);
