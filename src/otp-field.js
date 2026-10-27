// a bare "code" field (Backblaze: name/id "code-field", label "Code") is a one-time code only when the form around it says so
const BARE_CODE = /^(?:[\w-]*[-_.\s])?code(?:[-_.\s]?(?:field|input))?$/i;
const TWO_FACTOR_TEXT = /two[\s-]?factor|2[\s-]?step|two[\s-]?step|verification code|authenticat(?:ion|or)\s+(?:app|code)|authenticator/i;
// coupon, promo, zip and similar codes are never one-time codes, even on a form that mentions verification
const OTHER_CODE = /coupon|promo|voucher|gift|discount|referral|invite|zip|post(?:al)?|country|area|sort|swift|pin\s?code|colou?r|language|currency|stock|product/i;
const MAX_CONTEXT = 600;

// names: the field's name, id, aria-label, placeholder and label texts; context: the text of its form
export function isBareCodeOtp(names, context) {
  const list = names.map((n) => String(n || "").trim()).filter(Boolean);
  if (!list.length || !list.some((n) => BARE_CODE.test(n))) return false;
  if (list.some((n) => OTHER_CODE.test(n))) return false;
  const text = String(context || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_CONTEXT) return false;
  return TWO_FACTOR_TEXT.test(text) && !OTHER_CODE.test(text);
}
