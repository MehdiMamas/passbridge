// the verification-code hand-off bar, drawn inside a closed popover iframe on the page
import { applyDocumentLanguage, resolveLocale, t } from "../src/i18n/runtime.js";

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
      line(t("addErrTitle"), "font-weight:650;margin-bottom:4px"),
      line(data.error || t("somethingWrong"), "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end";
    row.append(button(t("ok"), "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "handed") {
    root.append(
      line(data.launched ? t("sentToPasswords") : t("couldntOpenPasswordsBar"), "font-weight:650;margin-bottom:4px"),
      line(
        data.detail || t("handedDetail"),
        "opacity:.7;margin-bottom:8px",
      ),
    );
    // only on an explicit click: Windows clipboard history and cloud clipboard keep what was copied
    if (data.hasKey) root.append(line(t("clipboardWarn"), "opacity:.7;font-size:12px;margin-bottom:12px"));
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    if (data.hasKey) row.append(button(t("copyKey"), "copyKey", false));
    row.append(button(t("ok"), "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "copied") {
    root.append(
      line(data.filled ? t("codeAdded") : t("keyCopied"), "font-weight:650;margin-bottom:4px"),
      line(data.detail || t("pasteDetail"), "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end";
    row.append(button(t("ok"), "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  if (data.mode === "empty") {
    root.append(
      line(t("noLoginSite"), "font-weight:650;margin-bottom:4px"),
      line(who ? t("emptyWho", [who]) : t("emptyDetail"), "opacity:.7;margin-bottom:12px"),
    );
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;align-items:center";
    row.append(button(t("createLogin"), "create", false), button(t("cancel"), "cancel", true));
    root.append(row);
    reportHeight();
    requestAnimationFrame(reportHeight);
    return;
  }
  root.append(
    line(t("addCodeQ"), "font-weight:650;margin-bottom:4px"),
    line(who || t("codeTotp"), "opacity:.7;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
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
    line(t("pickExplain"), "opacity:.7;margin-bottom:12px"),
  );
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
  row.append(button(t("cancel"), "cancel", false), button(t("chooseLogin"), "choose", true));
  root.append(row);
  reportHeight();
  requestAnimationFrame(reportHeight);
}

// resolve the UI language before the parent paints: t() falls back to en meanwhile
resolveLocale().then(() => {
  window.addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.token !== token || e.data?.type !== "totp-bar") return;
    render(e.data);
  });
  parent.postMessage({ token, action: "ready" }, "*");
});

// iframe pages can set their own <html lang> and title
void applyDocumentLanguage(document, "extensionName");
