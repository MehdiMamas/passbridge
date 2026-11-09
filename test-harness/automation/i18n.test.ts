// i18n suite: catalog parity, locale resolution, substitution, manifest wiring and menu output.
import { readdirSync, readFileSync } from "fs";
import { resolveLocale, setLocale, normalizeLocale, substitute, t, SUPPORTED_LOCALES, LOCALE_NAMES } from "../../src/i18n/runtime.js";
import { menuItems } from "../../src/menu.js";
import { SETTINGS_DEFAULTS } from "../../src/settings.js";
import { uiPinReply } from "../../src/session/pin-reply.js";

let failed = 0;
function ok(name: string, cond: unknown, _detail?: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const en = JSON.parse(readFileSync(new URL("../../_locales/en/messages.json", import.meta.url), "utf8"));

// ellipsis: only on a label that asks for more input before it finishes, and always the single character
const ASKS_FOR_INPUT = ["addLogin", "addCode", "newLoginInPasswords", "createLogin", "menuUnlock", "menuReport", "reportThisPage", "unlockAutofill", "unlockCodes", "passkeyImportBtn", "changeFolder", "shortcutsBtn"];
const OPENS_ONLY = ["settings", "openInPasswords", "searchUserInPasswords", "pmOpen", "passkeysBtn", "checkNow", "viewRelease", "whatsNew"];
const SAME_IN_EVERY_LANGUAGE = ["extensionName", "menuRoot", "pinPlaceholder", "codePlaceholder", "fieldsSummary"];
// words that are spelled the same as in English
const SAME_AS_EN: Record<string, string[]> = { tr: ["colSite"] };
const ZH_ONE_NAME: Record<string, [RegExp, string][]> = { zh_TW: [[/通行金鑰|密碼金鑰/, "通行密鑰"]] };

// every shipped catalog has exactly the en keys and follows the language-neutral copy rules
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
  const chromeOnly = keys.filter((k) => /\bChrome\b/.test(cat[k]?.message));
  ok(`copy ${locale}: no message names Chrome, every Chromium browser runs PassBridge`, chromeOnly.length === 0, chromeOnly.join(", ") || undefined);
  const threeDots = keys.filter((k) => /\.\.\./.test(cat[k]?.message));
  ok(`copy ${locale}: ellipsis is one character, not three dots`, threeDots.length === 0, threeDots.join(", ") || undefined);
  const missingDots = ASKS_FOR_INPUT.filter((k) => !cat[k]?.message?.endsWith("…"));
  ok(`copy ${locale}: a label that asks for more input ends with …`, missingDots.length === 0, missingDots.join(", ") || undefined);
  const extraDots = OPENS_ONLY.filter((k) => cat[k]?.message?.endsWith("…"));
  ok(`copy ${locale}: a label that only opens a page has no …`, extraDots.length === 0, extraDots.join(", ") || undefined);
  const exclaimed = keys.filter((k) => /[!！]/.test(cat[k]?.message));
  ok(`copy ${locale}: style, no exclamation marks`, exclaimed.length === 0, exclaimed.join(", ") || undefined);
  if (locale !== "en") {
    const untranslated = keys.filter((k) => !SAME_IN_EVERY_LANGUAGE.includes(k) && !(SAME_AS_EN[locale] || []).includes(k) && cat[k]?.message === en[k].message);
    ok(`copy ${locale}: every message is translated`, untranslated.length === 0, untranslated.join(", ") || undefined);
  }
  const mixed = (ZH_ONE_NAME[locale] || []).flatMap(([re, name]) => keys.filter((k) => re.test(cat[k]?.message)).map((k) => `${k} (say ${name})`));
  ok(`copy ${locale}: one name per thing`, mixed.length === 0, mixed.join(", ") || undefined);
}

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

// writing style in the en copy
const STYLE: [RegExp, string][] = [
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
ok("normalize: tr and tr-TR map to tr", normalizeLocale("tr") === "tr" && normalizeLocale("tr-TR") === "tr");
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
ok("tr: picker shows its own name", LOCALE_NAMES.tr === "Türkçe");
const tr = JSON.parse(readFileSync(new URL("../../_locales/tr/messages.json", import.meta.url), "utf8"));
const trEntries = Object.entries<{ message: string }>(tr);
const trKeysWhere = (test: (message: string) => boolean) => trEntries.filter(([, v]) => test(v.message)).map(([k]) => k);
const slots = (message: string) => (message.match(/\$\d/g) || []).sort().join();
setLocale("tr");
ok("t: tr value", t("unlock") === "Kilidi aç");
ok("t: tr placeholder filled", t("menuFillName", ["ada@example.com"]) === "ada@example.com hesabını doldur");
ok("tr: most messages are actually translated", trEntries.filter(([k, v]) => v.message !== en[k].message).length >= Object.keys(en).length * 0.9);
const lostSlots = Object.keys(en).filter((k) => slots(en[k].message) !== slots(tr[k].message));
ok("tr: every $N slot kept", lostSlots.length === 0, lostSlots.join(", ") || undefined);
ok("tr: no exclamation marks", trKeysWhere((m) => m.includes("!")).length === 0);
ok("tr: ellipsis is the single glyph", trKeysWhere((m) => m.includes("...")).length === 0);
ok("tr: says the browser, not Chrome", trKeysWhere((m) => /chrome/i.test(m.replaceAll("chrome://", ""))).length === 0);
const unlockCodeKeys = ["statusNeedsPin", "pinSentWin", "pinSentMac", "requestNewCode", "getNewCode", "askingNewCode", "enterCodeOn", "enterNewCode", "pinErrorNewCode", "couldntRequestCode"];
const trLower = (k: string) => tr[k].message.toLocaleLowerCase("tr");
ok("tr: the pairing code is the unlock code", unlockCodeKeys.every((k) => trLower(k).includes("kilit açma kod")));
ok("tr: the pairing code is never the verification code", unlockCodeKeys.every((k) => !trLower(k).includes("doğrulama kod")));
ok("tr: check is kontrol, as in Bitwarden", trKeysWhere((m) => /denetle|denetim/i.test(m)).length === 0);
ok("tr: the autofill tab is one word", tr.tabAutofill.message === "Doldurma");
ok("tr: verification code keeps Apple's name", tr.codeTotp.message === "Doğrulama kodu");
ok("tr: passkeys keep Apple's name", tr.passkeys.message === "Geçiş anahtarları");
ok("tr: iCloud Passwords keeps Apple's name", tr.connectingApple.message.includes("iCloud Parolaları"));
ok("tr: the Passwords app keeps Apple's name", tr.noHelperMac.message.includes("Parolalar uygulaması"));
ok("tr: iCloud for Windows keeps Apple's name", tr.noHelperWin.message.includes("Windows için iCloud"));
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

// jsx text and labels come from the catalog, never from code
const UI_TEXT = [/>\s*([A-Z][a-z]+ [^<>{}]*?)\s*</g, /(?:aria-label|title|placeholder)="([A-Z][^"]*)"/g];
const JSX_TEXT_WITH_VALUES = /(?<!=)>\s*((?:[^<>{};=]|\{[^{}]*\})+?)\s*</g;
const hardcoded = readdirSync(new URL("../../src/ui/", import.meta.url)).filter((f) => f.endsWith(".jsx") && f !== "preview.jsx").flatMap((f) => {
  const src = readFileSync(new URL(`../../src/ui/${f}`, import.meta.url), "utf8");
  const withValues = [...src.matchAll(JSX_TEXT_WITH_VALUES)].map((m) => m[1]).filter((s) => s.includes("{") && /[a-z]{2}/i.test(s.replace(/\{[^{}]*\}/g, "")));
  return [...UI_TEXT.flatMap((re) => [...src.matchAll(re)].map((m) => m[1])), ...withValues].map((s) => `${f}: ${s.trim()}`);
});
ok("ui: jsx text and labels come from the catalog", hardcoded.length === 0, hardcoded.join("; ") || undefined);
const background = readFileSync(new URL("../../src/background.js", import.meta.url), "utf8");
const rawErrors = ["no tab", "no active tab", "refusing to fill on a non-HTTPS page", "code list expired, focus the field again", "unknown code", "no code returned"].filter((e) => background.includes(`"${e}"`));
ok("background: errors the popup shows come from the catalog", rawErrors.length === 0, rawErrors.join(", ") || undefined);
setLocale("en");
const wrongCode = uiPinReply({ ok: false, error: "Incorrect code", newCode: true });
ok("pin: a wrong unlock code reads from the catalog and keeps the reply", wrongCode.error === t("incorrectCode") && wrongCode.newCode === true && wrongCode.error !== "incorrectCode");
const replacedCode = uiPinReply({ ok: false, error: "Enter the new code your Mac is showing now", newCode: true });
ok("pin: a replaced unlock code reads from the catalog and keeps the reply", replacedCode.error === t("verificationFailed") && replacedCode.newCode === true && replacedCode.error !== "verificationFailed");
ok("pin: other unlock errors pass through", uiPinReply({ ok: false, error: "verification timed out" }).error === "verification timed out");

console.log("" + (failed ? `i18n: ${failed} FAIL` : "i18n ok"));
process.exit(failed ? 1 : 0);
