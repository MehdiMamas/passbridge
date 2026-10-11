// The typecheck stops here: the vendored Bitwarden file is built against shims (see scripts/build.mjs),
// not against @bitwarden/common's types. Only the lists content.js reads are declared.
export declare class AutoFillConstants {
  static readonly EmailFieldNames: string[];
  static readonly UsernameFieldNames: string[];
}
