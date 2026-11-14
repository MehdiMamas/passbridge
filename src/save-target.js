// Two save-offer decisions, kept out of background.js and content.js so they can be unit-tested.
// Both used to drop a password the user had just corrected, which is why they live together here.

/**
 * Does this submit look like a new password rather than a plain re-login?
 *
 * `correctedAfterFill` is the one that matters most: we filled the vault's value and the form
 * submitted something else, so the user retyped it and the vault is stale. Without it, an
 * ordinary single-field login page counts as a re-login and the correction is never offered.
 *
 * @param {object} p
 * @param {boolean} p.generated the password came from PassBridge's generator
 * @param {number} p.passwordCount password inputs in the submitted scope
 * @param {boolean} p.hasNewPasswordMark one of them carries autocomplete=new-password
 * @param {boolean} p.correctedAfterFill submitted password differs from the value we filled here
 * @returns {boolean}
 */
export function newPasswordContext({ generated = false, passwordCount = 0, hasNewPasswordMark = false, correctedAfterFill = false }) {
  return !!(generated || correctedAfterFill || passwordCount >= 2 || hasNewPasswordMark);
}

/**
 * Which vault entry a submitted login belongs to, and whether to offer to save it at all.
 *
 * @param {object} p
 * @param {string[]} p.existing usernames already saved for this host
 * @param {string} p.detected username read off the submitted form, "" when none was found
 * @param {boolean} p.generated the password came from PassBridge's generator
 * @param {boolean} p.newPwCtx see newPasswordContext()
 * @param {string} [p.recent] most recently used username, for the form-less case
 * @returns {string | null} the username to save, "" to let Apple's sheet ask, null to save nothing
 */
export function pickSaveTarget({ existing = [], detected = "", generated = false, newPwCtx = false, recent = "" }) {
  const name = String(detected || "");
  const matched = name && existing.find((u) => u.toLowerCase() === name.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (name) return name;
  // attach to the MRU account, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) return recent || existing[0];
  if (generated) return "";
  return null;
}

/**
 * Does this offer need no decision, so it can be saved without the bar?
 * Only a new login with a known username and a password, and only when the user opted in.
 * Updates could overwrite a good password with a typo; an empty username needs the user to name it.
 *
 * @param {{ enabled?: boolean, update?: boolean, target?: string | null, password?: string }} p
 * @returns {boolean}
 */
export function canAutoSave({ enabled = false, update = false, target = "", password = "" }) {
  return enabled === true && !update && !!target && !!password;
}

/**
 * Saves without the bar when allowed. Any failure (settings read, save) returns false so the caller shows the bar.
 *
 * @param {{ getEnabled: () => Promise<boolean>, update: boolean, target: string | null, password: string, save: () => Promise<unknown> }} p
 * @returns {Promise<boolean>} true when the login was saved
 */
export async function tryAutoSave({ getEnabled, update, target, password, save }) {
  try {
    if (!canAutoSave({ enabled: await getEnabled(), update, target, password })) return false;
    await save();
    return true;
  } catch {
    return false;
  }
}
