# Translating PassBridge

PassBridge's UI strings live in Chrome's standard i18n catalogs under
`_locales/<locale>/messages.json`. English (`en`) is the source of truth and the
default; every other language is a plain JSON file that contributors add by
copying `en` and translating the `message` values.

## Adding a language

1. **Copy the English catalog.** For a locale code like `ja` or `pt_BR`, create
   `_locales/<locale>/messages.json` as a copy of `_locales/en/messages.json`.
   The locale directory name uses an underscore for the region (`zh_CN`,
   `pt_BR`); Chrome maps `zh-CN` / `pt-BR` UI languages to it automatically.

2. **Translate the `message` values.** Leave the JSON structure, the keys, and
   the `placeholders` blocks untouched — only the text inside `"message"` is
   translated. Keep every `$1`, `$2`, … placeholder exactly where it is: the
   code substitutes them at runtime, and reordering words in another language
   still works because the placeholder marks the slot.

   ```jsonc
   // en
   "menuFillName": { "message": "Fill $1", "placeholders": { "name": { "content": "$1", "example": "ada@example.com" } } },
   // zh_CN — only "message" changes, $1 stays
   "menuFillName": { "message": "填充 $1", "placeholders": { "name": { "content": "$1", "example": "ada@example.com" } } },
   ```

   Product and app names stay as-is: **PassBridge**, **Chrome**, **iCloud**,
   **GitHub**, **macOS**, **Windows**, **Touch ID**, **Windows Hello**,
   **DuckDuckGo**. Apple's Passwords app is "密码" in zh-CN, "密碼" in zh-TW and "Parolalar" in tr.

3. **Register the locale** in `src/i18n/runtime.js` so it loads, is listed in
   the options language picker, and is matched by `chrome.i18n.getUILanguage()`:
   - add an `import … with { type: "json" }` for the new catalog
   - add it to `CATALOGS` and `LOCALE_NAMES` (shown in the picker, in the
     language's own name)
   - `normalizeLocale()` already falls back to the first matching locale for a
     language family (e.g. any `zh` tag → `zh_CN`), so no change is needed there
     unless you want a different default.

4. **Check it.** Run:

   ```bash
   pnpm test          # includes scripts/check-locales.ts
   pnpm typecheck
   ```

   `check-locales.ts` verifies that every key the code uses exists in `en`,
   that every `en` key exists in each locale, and that placeholders match. A
   missing or extra key fails the run.

5. **See it in the browser.** Build and load unpacked, then set the UI language
   in **Settings → Appearance → Language** (or follow Chrome's UI language):

   ```bash
   pnpm build      # output in dist/
   ```

   Open `chrome://extensions`, enable Developer mode, "Load unpacked", and pick
   `dist/`. (Disable Apple's own iCloud Passwords extension first — same ID.)

6. **Open a PR.** One language per PR keeps reviews small. Describe the locale
   and any terminology choices (e.g. zh-TW uses 登入 for "sign in" and 密碼 for
   "Passwords").

## Rules

- **One key per user-facing string.** If a sentence is built from several
  values, use placeholders (`$1`) instead of concatenating separate strings —
  word order differs between languages.
- **Never translate the keys or placeholder names** — only the `message` text.
- **Keep the tone short and direct**, like the English strings: buttons and
  menu items are a few words, help lines are one sentence.
- **Developer-facing text stays English**: console logs, `preview.jsx`, and the
  contents of a bug-report file are not user UI.
- The `example` fields under `placeholders` are developer hints; translate them
  if it helps, but they never render.

## Current languages

| Locale | Language | Maintainer |
| --- | --- | --- |
| `en` | English | built-in default |
| `zh_CN` | 简体中文 | community |
| `zh_TW` | 繁體中文 | community |
| `tr` | Türkçe | community |
