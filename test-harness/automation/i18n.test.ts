// i18n suite: catalog parity, locale resolution, substitution, manifest wiring and menu output.
import { readFileSync } from "fs";
import { resolveLocale, setLocale, normalizeLocale, substitute, t, SUPPORTED_LOCALES, LOCALE_NAMES } from "../../src/i18n/runtime.js";
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

console.log("" + (failed ? `i18n: ${failed} FAIL` : "i18n ok"));
process.exit(failed ? 1 : 0);
