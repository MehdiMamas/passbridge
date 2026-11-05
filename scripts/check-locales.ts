// static locale check, run by npm test:
// 1. every key the code uses (a t("key") literal call in src/ or overlay/) exists in _locales/en
// 2. every en key exists in each locale file (no missing translations)
// 3. placeholders match en in each locale
// Usage: node scripts/check-locales.ts

import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @param {...string} p */
const at = (...p) => join(REPO, ...p);

const LOC_DIR = at("_locales");
const locales = readdirSync(LOC_DIR).filter((d) => statSync(join(LOC_DIR, d)).isDirectory());
if (!locales.includes("en")) throw new Error("_locales/en is missing");

/** @param {string} locale */
const load = (locale) => JSON.parse(readFileSync(at("_locales", locale, "messages.json"), "utf8"));
const en = load("en");

// collect source files that can call t()
/** @type {string[]} */
const codeFiles = [];
/** @param {string} dir */
const walk = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(js|jsx|ts|tsx)$/.test(ent.name)) codeFiles.push(p);
  }
};
walk(at("src"));
walk(at("overlay"));

// a t("key") call: the translation helper t, a string literal first argument
const CALL = /\bt\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
const used = new Set();
for (const file of codeFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(CALL)) used.add(m[1]);
}

const problems = [];

// 1. keys the code uses must exist in en
for (const key of [...used].sort()) if (!(key in en)) problems.push(`code uses t("${key}") but it is missing from _locales/en/messages.json`);

// 2 + 3. every en key in every locale, placeholders identical
for (const locale of locales) {
  const cat = load(locale);
  for (const key of Object.keys(en)) {
    if (!(key in cat)) {
      problems.push(`en key "${key}" is missing from _locales/${locale}/messages.json`);
      continue;
    }
    const want = Object.keys(en[key].placeholders || {}).sort().join(",");
    const got = Object.keys(cat[key].placeholders || {}).sort().join(",");
    if (want !== got) problems.push(`placeholders for "${key}" differ between en and ${locale} (en: [${want}] vs ${locale}: [${got}])`);
  }
  for (const key of Object.keys(cat)) if (!(key in en)) problems.push(`unknown key "${key}" in _locales/${locale}/messages.json (not in en)`);
}

if (problems.length) {
  console.error(`locale check failed (${problems.length} problem(s)):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`locale check ok: ${codeFiles.length} source files, ${used.size} distinct keys used in code, ${locales.length} locales (${locales.join(", ")}) — all keys present, placeholders match`);
