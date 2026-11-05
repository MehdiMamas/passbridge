// The typecheck follows src/autofill/hints.ts into the vendored Bitwarden file. That file is built against the
// shims in this folder (see scripts/build.mjs), not against @bitwarden/common's types, so they are declared loosely here.
declare module "@bitwarden/common/autofill/constants" {
  export const AutofillTargetingRuleTypes: Record<string, any>;
  export const FormPurposeCategories: Record<string, any>;
}
declare module "@bitwarden/common/autofill/types" {
  export type AutofillTargetingRuleType = string;
  export type FormPurposeCategory = string;
}
declare module "@bitwarden/common/vault/enums" {
  export type CipherType = number;
  export const CipherType: Record<string, number>;
}
