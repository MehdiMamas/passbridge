const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
document.documentElement.style.colorScheme = params.get("scheme") || "";

const root = document.createElement("div");
root.style.cssText = [
  "box-sizing:border-box",
  "width:100%",
  "padding:14px 14px 12px",
  "border-radius:14px",
  "background:Canvas",
  "color:CanvasText",
  "border:1px solid rgba(128,128,128,0.35)",
  "box-shadow:0 12px 32px rgba(0,0,0,0.22)",
  "font:13px/1.4 system-ui,sans-serif",
].join(";");
document.body.appendChild(root);

function button(label, action, primary) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = primary
    ? "background:#0a84ff;color:#fff;border:none;border-radius:8px;padding:6px 10px;cursor:pointer"
    : "background:transparent;color:inherit;border:none;padding:6px 8px;cursor:pointer;opacity:.8";
  b.addEventListener("click", () => parent.postMessage({ token, action }, "*"));
  return b;
}

function line(text, style) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = style;
  return el;
}

function reportHeight() {
  const h = Math.ceil(root.getBoundingClientRect().height);
  parent.postMessage({ token, action: "resize", height: h }, "*");
}

function render(data) {
  root.replaceChildren();
  const who = [data.issuer, data.account].filter(Boolean).join(" · ");
  if (data.mode === "error") {
    root.append(
      line("Couldn't add a verification code", "font-weight:650;margin-bottom:4px"),
      line(data.error || "Something went wrong.", "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end";
    row.append(button("OK", "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "handed") {
    root.append(
      line(data.launched ? "Sent to Passwords" : "Couldn't open Passwords", "font-weight:650;margin-bottom:4px"),
      line(
        data.detail || "Finish adding the code in Passwords. If it did not take the code, copy the setup key and paste it there.",
        "opacity:.7;margin-bottom:8px",
      ),
    );
    // only on an explicit click: Windows clipboard history and cloud clipboard keep what was copied
    if (data.hasKey) root.append(line("The setup key is a secret. Clipboard history may keep it after PassBridge clears it.", "opacity:.7;font-size:12px;margin-bottom:12px"));
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    if (data.hasKey) row.append(button("Copy setup key", "copyKey", false));
    row.append(button("OK", "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "copied") {
    root.append(
      line(data.filled ? "Verification code added" : "Setup key copied", "font-weight:650;margin-bottom:4px"),
      line(data.detail || "Paste it in Passwords, then clear your clipboard history.", "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end";
    row.append(button("OK", "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "empty") {
    root.append(
      line("No saved login for this site", "font-weight:650;margin-bottom:4px"),
      line(who ? `${who}. This code can only live on a login.` : "This code can only live on a login.", "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;align-items:center";
    row.append(button("Create a login in Passwords", "create", false), button("Cancel", "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  root.append(
    line("Add a verification code?", "font-weight:650;margin-bottom:4px"),
    line(who || "Verification code", "opacity:.7;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
  );
  const list = document.createElement("ul");
  list.style.cssText = "margin:0 0 8px;padding:0 0 0 18px;max-height:96px;overflow:auto";
  for (const name of data.usernames || []) {
    const li = document.createElement("li");
    li.textContent = name;
    li.style.cssText = "margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    list.append(li);
  }
  root.append(
    list,
    line("Passwords asks which login gets this code. You can pick a different one, or create a new login, there.", "opacity:.7;margin-bottom:12px"),
  );
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
  row.append(button("Cancel", "cancel", false), button("Choose a login", "choose", true));
  root.append(row);
  reportHeight();
  requestAnimationFrame(reportHeight);
}

window.addEventListener("message", (e) => {
  if (e.source !== parent || e.data?.token !== token || e.data?.type !== "totp-bar") return;
  render(e.data);
});
parent.postMessage({ token, action: "ready" }, "*");
