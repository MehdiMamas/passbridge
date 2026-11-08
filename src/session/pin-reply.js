import { freshCodeMessage, INCORRECT_CODE } from "../apple/protocol.ts";
import { t } from "../i18n/runtime.js";

/** @param {{ ok: boolean, error?: string, [key: string]: any }} reply */
export function uiPinReply(reply) {
  if (reply.error === INCORRECT_CODE) return { ...reply, error: t("incorrectCode") };
  if (reply.error === freshCodeMessage()) return { ...reply, error: t("verificationFailed") };
  return reply;
}
