import { REPORT_REPO } from "../report-scrub.js";
import { t } from "../i18n/runtime.js";

/** @typedef {"checking" | "present" | "missing"} HelperState */
/** @typedef {"ready" | "checking" | "locked"} RowState */
/** @typedef {{ text: string, href: string | null } | null} Notice */

export const OPTION_TABS = [
  { id: "autofill", labelKey: "tabAutofill" },
  { id: "appearance", labelKey: "tabAppearance" },
  { id: "browser", labelKey: "tabBrowser" },
  { id: "agents", labelKey: "tabAgents" },
  { id: "updates", labelKey: "tabUpdates" },
];

const SETUP_URL = `https://github.com/${REPORT_REPO}/blob/main/SETUP.md`;
const SETUP_ANCHORS = {
  mac: { browser: "optional-macos-helper", agents: "agent-sign-in-macos", updates: "one-click-update-macos" },
  windows: { browser: "windows", agents: "agent-sign-in-windows", updates: "automatic-updates-windows" },
};

/**
 * @param {boolean} isWindows
 * @returns {{ helpKey: "passkeysHelpWin" | "passkeysHelpMac", url: string }}
 */
export function passkeysView(isWindows) {
  return { helpKey: isWindows ? "passkeysHelpWin" : "passkeysHelpMac", url: `${SETUP_URL}#passkeys` };
}

const ROW_STATE = { checking: "checking", present: "ready", missing: "locked" };

/**
 * @param {{ ok?: boolean, note?: string, error?: string }} reply
 * @param {boolean} isToggle
 * @returns {string}
 */
export function policyMessage(reply, isToggle) {
  if (!reply.ok) return reply.error || (isToggle ? t("policyFail") : "");
  return isToggle ? reply.note || t("policyRestart") : "";
}

/**
 * @param {string} hash
 * @returns {string}
 */
export function tabFromHash(hash) {
  const id = String(hash || "").replace(/^#/, "");
  return OPTION_TABS.some((t) => t.id === id) ? id : OPTION_TABS[0].id;
}

/**
 * @param {{ helpers: { policy: HelperState, updater: HelperState }, isWindows: boolean, canCheckForUpdates: boolean, relay?: string }} input
 * @returns {{ rows: { policy: RowState, agents: RowState, autoInstall: RowState }, notices: { browser: Notice, agents: Notice, updates: Notice } }}
 */
export function helperView({ helpers, isWindows, canCheckForUpdates, relay }) {
  const anchors = isWindows ? SETUP_ANCHORS.windows : SETUP_ANCHORS.mac;
  const notice = (state, tab) => (state === "missing" ? { text: t("helperNotice"), href: `${SETUP_URL}#${anchors[tab]}` } : null);
  return {
    rows: {
      policy: ROW_STATE[helpers.policy],
      agents: ROW_STATE[helpers.policy],
      autoInstall: ROW_STATE[helpers.updater],
    },
    notices: {
      browser: notice(helpers.policy, "browser"),
      agents: relay === "standby" ? { text: t("standbyNotice"), href: null } : notice(helpers.policy, "agents"),
      updates: canCheckForUpdates ? notice(helpers.updater, "updates") : null,
    },
  };
}

/** True when enough time has passed since the last helper check to run another. */
export function shouldRecheck(lastMs, nowMs, minGapMs = 5000) {
  return nowMs - lastMs >= minGapMs;
}
