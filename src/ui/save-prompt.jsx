import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyDocumentLanguage, t } from "../i18n/runtime.js";


const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const update = params.get("update") === "1";
const user = params.get("user") || "";
document.documentElement.style.colorScheme = params.get("scheme") || "";

// "close" only tells the page to remove the bar; the password never goes through window.postMessage,
// where the page's own listeners would see it. Save talks to the background directly.
function close(action) {
  parent.postMessage({ token, action }, "*");
}

const field = "mt-1 w-full rounded-lg border bg-[Canvas] px-2 py-1 text-[13px] text-[CanvasText] outline-none focus:border-accent";

function SavePrompt() {
  const [username, setUsername] = useState(user);
  const [password, setPassword] = useState("");
  const [site, setSite] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(false);
  const [offer, setOffer] = useState({ show: false, host: "" });
  const [allowAgent, setAllowAgent] = useState(false);
  const [canNewSheet, setCanNewSheet] = useState(false);
  const [drag, setDrag] = useState({ x: 0, y: 0 });

  // the captured values are read from the background, not passed in the iframe URL
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "getSaveDraft" }).then((r) => {
      if (r?.ok) {
        setUsername(r.username || "");
        setPassword(r.password || "");
        setSite(r.site || "");
        setCanNewSheet(r.canNewSheet === true);
        if (r.agentOffer?.show) {
          setOffer(r.agentOffer);
          setAllowAgent(!!r.agentOffer.suggested);
        }
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  // drag the bar by its empty areas: title, labels, buttons
  useEffect(() => {
    const bar = document.querySelector("[data-passbridge=save-bar]");
    if (!bar) return;
    let startX = 0, startY = 0, originX = 0, originY = 0;
    let dragging = false;

    const down = (e) => {
      // let clicks on inputs, buttons and labels through
      if (e.target.closest("input, button, label, a, [contenteditable]")) return;
      dragging = true;
      const rect = bar.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxX = window.innerWidth - bar.offsetWidth;
      const maxY = window.innerHeight - bar.offsetHeight;
      setDrag({ x: Math.min(Math.max(0, originX + dx), maxX), y: Math.min(Math.max(0, originY + dy), maxY) });
    };
    const up = () => { dragging = false; };

    bar.addEventListener("mousedown", down);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      bar.removeEventListener("mousedown", down);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  // send the new position to the parent so the host element moves
  useEffect(() => {
    if (drag.x || drag.y) parent.postMessage({ token, action: "drag", x: drag.x, y: drag.y }, "*");
  }, [drag]);

  async function save(asNew) {
    try { await chrome.runtime.sendMessage({ type: "confirmSave", username: username.trim(), password, site: site.trim(), asNew: asNew === true, allowAgent: offer.show && allowAgent }); } catch {}
    close("save");
  }

  const noUser = !username.trim();
  return (
    <div data-passbridge="save-bar" className="w-[360px] rounded-2xl border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] p-3.5 text-[CanvasText] shadow-xl cursor-move" style={{ position: "fixed", left: `${drag.x}px`, top: `${drag.y}px` }}>
      <p className="text-sm font-semibold">{update ? t("updateTitle") : t("saveTitle")}</p>

      <label className="mt-2 block text-xs opacity-70">
        {t("website")}
        <input
          type="text"
          data-field="site"
          autoComplete="off"
          spellCheck={false}
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className={`${field} border-[color-mix(in_srgb,CanvasText_25%,Canvas)]`}
        />
      </label>
      <label className="mt-2 block text-xs opacity-70">
        {t("username")}
        <input

          type="text"
          data-field="username"
          autoComplete="off"
          spellCheck={false}
          value={username}
          placeholder={t("noUserFound")}

          onChange={(e) => setUsername(e.target.value)}
          className={`${field} ${noUser ? "border-danger ring-1 ring-danger" : "border-[color-mix(in_srgb,CanvasText_25%,Canvas)]"}`}
        />
      </label>
      <label className="mt-2 block text-xs opacity-70">
        {t("password")}
        <span className="flex gap-1.5">

          <input
            type={shown ? "text" : "password"}
            data-field="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${field} border-[color-mix(in_srgb,CanvasText_25%,Canvas)]`}
          />
          <button type="button" data-action="toggle" className="mt-1 px-1.5 text-[13px] opacity-80 shrink-0 whitespace-nowrap" onClick={() => setShown(!shown)}>
            {shown ? t("hide") : t("show")}

          </button>
        </span>
      </label>
      {offer.show && (
        <label className="mt-2 flex items-center gap-1.5 text-xs">
          <input type="checkbox" data-field="allow-agent" checked={allowAgent} onChange={(e) => setAllowAgent(e.target.checked)} />
          {t("letAgentsSignIn", [offer.host])}
        </label>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="px-2 py-1 text-[13px] opacity-80" onClick={() => close("never")}>
          {t("neverSite")}
        </button>
        <button type="button" className="px-2 py-1 text-[13px] opacity-80" onClick={() => close("dismiss")}>
          {t("notNow")}
        </button>
      </div>
      <div className="mt-1 flex justify-end gap-2">
        {update && canNewSheet && (
          <button type="button" data-action="save-new" disabled={!loaded || !password || noUser} className="rounded-lg border border-[color-mix(in_srgb,CanvasText_25%,Canvas)] px-2.5 py-1 text-[13px] font-semibold disabled:opacity-50" onClick={() => save(true)}>
            {t("saveAsNewLogin")}
          </button>
        )}
        <button type="button" data-action="save" disabled={!loaded || !password} className="rounded-lg bg-accent px-2.5 py-1 text-[13px] font-semibold text-white disabled:opacity-50" onClick={() => save(false)}>
          {update ? t("update") : t("save")}
        </button>
      </div>
    </div>
  );
}

void applyDocumentLanguage(document);
createRoot(document.getElementById("root")).render(<SavePrompt />);

