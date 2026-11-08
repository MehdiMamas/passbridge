import { INCORRECT_CODE } from "../apple/protocol.ts";
import { t } from "../i18n/runtime.js";

/** @param {{ ok: boolean, error?: string, [key: string]: any }} reply */
export function uiPinReply(reply) {
  return reply.error === INCORRECT_CODE ? { ...reply, error: t("incorrectCode") } : reply;
}
