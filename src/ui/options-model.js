import { REPORT_REPO } from "../report-scrub.js";

/** @typedef {"checking" | "present" | "missing"} HelperState */
/** @typedef {"ready" | "checking" | "locked"} RowState */
/** @typedef {{ text: string, href: string | null } | null} Notice */

export const OPTION_TABS = [
  { id: "autofill", label: "Autofill" },
  { id: "appearance", label: "Appearance" },
  { id: "browser", label: "Browser" },
  { id: "agents", label: "Agents" },
  { id: "updates", label: "Updates" },
];

const SETUP_URL = `https://github.com/${REPORT_REPO}/blob/main/SETUP.md`;
const HELPER_NOTICE = "Greyed-out settings need the PassBridge helper.";
const MAC_ONLY_NOTICE = "Agent sign-in works on macOS only.";
const SETUP_ANCHORS = {
  mac: { browser: "optional-macos-helper", agents: "agent-sign-in-macos", updates: "one-click-update-macos" },
  windows: { browser: "windows", updates: "automatic-updates-windows" },
};
const ROW_STATE = { checking: "checking", present: "ready", missing: "locked" };

/**
 * @param {{ ok?: boolean, note?: string, error?: string }} reply
 * @param {boolean} isToggle
 * @returns {string}
 */
export function policyMessage(reply, isToggle) {
  if (!reply.ok) return reply.error || (isToggle ? "Couldn't change the policy." : "");
  return isToggle ? reply.note || "Fully quit and reopen the browser to apply this." : "";
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
 * @param {{ helpers: { policy: HelperState, updater: HelperState }, isWindows: boolean, canCheckForUpdates: boolean }} input
 * @returns {{ rows: { policy: RowState, agents: RowState, autoInstall: RowState }, notices: { browser: Notice, agents: Notice, updates: Notice } }}
 */
export function helperView({ helpers, isWindows, canCheckForUpdates }) {
  const anchors = isWindows ? SETUP_ANCHORS.windows : SETUP_ANCHORS.mac;
  const notice = (state, tab) => (state === "missing" ? { text: HELPER_NOTICE, href: `${SETUP_URL}#${anchors[tab]}` } : null);
  return {
    rows: {
      policy: ROW_STATE[helpers.policy],
      agents: isWindows ? "locked" : ROW_STATE[helpers.policy],
      autoInstall: ROW_STATE[helpers.updater],
    },
    notices: {
      browser: notice(helpers.policy, "browser"),
      agents: isWindows ? { text: MAC_ONLY_NOTICE, href: null } : notice(helpers.policy, "agents"),
      updates: canCheckForUpdates ? notice(helpers.updater, "updates") : null,
    },
  };
}
