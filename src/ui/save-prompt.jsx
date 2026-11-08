import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyDocumentLanguage, t } from "../i18n/runtime.js";


const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const update = params.get("update") === "1";
const user = params.get("user") || "";
document.documentElement.style.colorScheme = params.get("scheme") || "";

// "close" only tells the page to remove the bar; the password never goes through window.postMessage,
// where the page's own listeners would see it. Save talks to the background directly.
/** @param {string} action */
function close(action) {
  parent.postMessage({ token, action }, "*");
}

const field = "select-text cursor-text mt-1 w-full rounded-lg border bg-[Canvas] px-2 py-1 text-[13px] text-[CanvasText] outline-none focus:border-accent";

const NO_DRAG = "input, button, select, textarea, a";

function SavePrompt() {
  const [dragging, setDragging] = useState(false);
  /** @type {import("react").MutableRefObject<{ x: number, y: number, dx: number, dy: number, raf: number } | null>} */
  const drag = useRef(null);

  // dragging the bar's own surface moves it; the page script moves the host from the deltas
  /** @param {import("react").PointerEvent<HTMLDivElement>} e */
  function onDown(e) {
    if (e.button !== 0 || /** @type {Element} */ (e.target).closest?.(NO_DRAG)) return;
    drag.current = { x: e.screenX, y: e.screenY, dx: 0, dy: 0, raf: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  }
  /** @param {import("react").PointerEvent<HTMLDivElement>} e */
  function onMove(e) {
    const d = drag.current;
    if (!d) return;
    // the button was released outside our view (no pointerup reached us): end the drag
    if (e.buttons === 0) return onUp();
    d.dx += e.screenX - d.x;
    d.dy += e.screenY - d.y;
    d.x = e.screenX;
    d.y = e.screenY;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => flush());
  }
  function flush() {
    const d = drag.current;
    if (!d) return;
    d.raf = 0;
    if (d.dx || d.dy) parent.postMessage({ token, action: "move", dx: d.dx, dy: d.dy }, "*");
    d.dx = 0;
    d.dy = 0;
  }
  function onUp() {
    if (!drag.current) return;
    if (drag.current.raf) cancelAnimationFrame(drag.current.raf);
    flush();
    drag.current = null;
    setDragging(false);
  }

  const [username, setUsername] = useState(user);
  const [password, setPassword] = useState("");
  const [site, setSite] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(false);
  const [offer, setOffer] = useState({ show: false, host: "" });
  const [allowAgent, setAllowAgent] = useState(false);
  const [canNewSheet, setCanNewSheet] = useState(false);

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

  // asNew makes a separate login even when one with this username and site exists
  /** @param {boolean} [asNew] */
  async function save(asNew) {
    try { await chrome.runtime.sendMessage({ type: "confirmSave", username: username.trim(), password, site: site.trim(), asNew: asNew === true, allowAgent: offer.show && allowAgent }); } catch {}
    close("save");
  }

  const noUser = !username.trim();
  return (
    <div data-passbridge="save-bar" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp} className={`select-none ${dragging ? "cursor-grabbing" : "cursor-grab"} w-[360px] rounded-2xl border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] p-3.5 text-[CanvasText] shadow-xl`}>
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
        <span className="flex items-center gap-1.5">

          <input
            type={shown ? "text" : "password"}
            data-field="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${field} min-w-0 flex-1 border-[color-mix(in_srgb,CanvasText_25%,Canvas)]`}
          />
          <button type="button" data-action="toggle" className="mt-1 shrink-0 cursor-pointer whitespace-nowrap px-1.5 text-[13px] opacity-80" onClick={() => setShown(!shown)}>
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
        <button type="button" className="cursor-pointer px-2 py-1 text-[13px] opacity-80" onClick={() => close("never")}>
          {t("neverSite")}
        </button>
        <button type="button" className="cursor-pointer px-2 py-1 text-[13px] opacity-80" onClick={() => close("dismiss")}>
          {t("notNow")}
        </button>
      </div>
      <div className="mt-1 flex justify-end gap-2">
        {update && canNewSheet && (
          <button type="button" data-action="save-new" disabled={!loaded || !password || noUser} className="cursor-pointer rounded-lg border border-[color-mix(in_srgb,CanvasText_25%,Canvas)] px-2.5 py-1 text-[13px] font-semibold disabled:opacity-50" onClick={() => save(true)}>
            {t("saveAsNewLogin")}
          </button>
        )}
        <button type="button" data-action="save" disabled={!loaded || !password} className="cursor-pointer rounded-lg bg-accent px-2.5 py-1 text-[13px] font-semibold text-white disabled:opacity-50" onClick={() => save(false)}>
          {update ? t("update") : t("save")}
        </button>
      </div>
    </div>
  );
}

void applyDocumentLanguage(document);
createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(<SavePrompt />);

