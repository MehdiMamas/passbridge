import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

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
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(false);

  // the captured values are read from the background, not passed in the iframe URL
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "getSaveDraft" }).then((r) => {
      if (r?.ok) {
        setUsername(r.username || "");
        setPassword(r.password || "");
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  async function save() {
    try { await chrome.runtime.sendMessage({ type: "confirmSave", username: username.trim(), password }); } catch {}
    close("save");
  }

  const noUser = !username.trim();
  return (
    <div data-passbridge="save-bar" className="w-[360px] rounded-2xl border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] p-3.5 text-[CanvasText] shadow-xl">
      <p className="text-sm font-semibold">{update ? "Update password in iCloud Passwords?" : "Save login to iCloud Passwords?"}</p>
      <label className="mt-2 block text-xs opacity-70">
        Username
        <input
          type="text"
          data-field="username"
          autoComplete="off"
          spellCheck={false}
          value={username}
          placeholder="No username found, type one"
          onChange={(e) => setUsername(e.target.value)}
          className={`${field} ${noUser ? "border-danger ring-1 ring-danger" : "border-[color-mix(in_srgb,CanvasText_25%,Canvas)]"}`}
        />
      </label>
      <label className="mt-2 block text-xs opacity-70">
        Password
        <span className="flex gap-1.5">
          <input
            type={shown ? "text" : "password"}
            data-field="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${field} border-[color-mix(in_srgb,CanvasText_25%,Canvas)]`}
          />
          <button type="button" data-action="toggle" className="mt-1 px-1.5 text-[13px] opacity-80" onClick={() => setShown(!shown)}>
            {shown ? "Hide" : "Show"}
          </button>
        </span>
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="px-2 py-1 text-[13px] opacity-80" onClick={() => close("never")}>
          Never for this site
        </button>
        <button type="button" className="px-2 py-1 text-[13px] opacity-80" onClick={() => close("dismiss")}>
          Not now
        </button>
        <button type="button" data-action="save" disabled={!loaded || !password} className="rounded-lg bg-accent px-2.5 py-1 text-[13px] font-semibold text-white disabled:opacity-50" onClick={save}>
          {update ? "Update" : "Save"}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<SavePrompt />);
