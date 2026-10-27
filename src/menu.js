// the right-click menu: only items that can work on this page, built fresh for the active tab

const ON_PAGE = ["editable", "page"];

/**
 * @param {{ ready: boolean, logins: { username?: string }[], hasCode: boolean }} state
 * @returns {chrome.contextMenus.CreateProperties[]}
 */
export function menuItems({ ready, logins, hasCode }) {
  const items = [{ id: "pb-root", title: "PassBridge", contexts: ["editable", "page", "image"] }];
  const add = (props) => items.push({ parentId: "pb-root", contexts: ON_PAGE, ...props });
  if (!ready) {
    add({ id: "pb-unlock", title: "Unlock PassBridge…" });
  } else if (logins.length === 1) {
    const name = logins[0].username;
    add({ id: "pb-fill-0", title: name ? `Fill ${name}` : "Fill login" });
    if (name) add({ id: "pb-user-0", title: "Copy username" });
    add({ id: "pb-pass-0", title: "Copy password" });
  } else if (logins.length) {
    logins.forEach((login, i) => {
      add({ id: `pb-acct-${i}`, title: login.username || "(no username)" });
      const sub = (props) => items.push({ parentId: `pb-acct-${i}`, contexts: ON_PAGE, ...props });
      sub({ id: `pb-fill-${i}`, title: "Fill" });
      if (login.username) sub({ id: `pb-user-${i}`, title: "Copy username" });
      sub({ id: `pb-pass-${i}`, title: "Copy password" });
    });
  } else {
    add({ id: "pb-none", title: "No saved logins for this site", enabled: false });
  }
  if (ready && hasCode) add({ id: "pb-otp", title: "Copy verification code" });
  add({ id: "pb-sep-1", type: "separator" });
  add({ id: "pb-gen", title: "Fill a strong password", contexts: ["editable"] });
  add({ id: "pb-gen-copy", title: "Copy a strong password", contexts: ["page"] });
  add({ id: "pb-qr-image", title: "Scan this image for a verification code", contexts: ["image"] });
  add({ id: "pb-sep-2", type: "separator", contexts: ["page"] });
  add({ id: "pb-report", title: "Report this page…", contexts: ["page"] });
  return items;
}

/** @returns {{ action: string, index: number } | null} "pb-pass-2" → { action: "pass", index: 2 } */
export function loginAction(menuItemId) {
  const m = /^pb-(fill|user|pass)-(\d+)$/.exec(String(menuItemId));
  return m ? { action: m[1], index: Number(m[2]) } : null;
}
