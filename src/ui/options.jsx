import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const DEFAULTS = {
  inlineMenuVisibility: "on-focus",
  autofillOnPageLoad: false,
  copyTotpAfterFill: true,
  clipboardClearMs: 30000,
  enableContextMenu: true,
  enableBadge: true,
  askToSave: true,
  askToUpdate: true,
  showAnimations: true,
  showFavicons: true,
  excludedDomains: [],
  blockedDomains: [],
  hidePasskeys: false,
};

function Row({ label, note, children }) {
  return (
    <label className="flex items-center justify-between gap-4 border-b border-[color-mix(in_srgb,CanvasText_8%,Canvas)] py-2.5 text-[13px]">
      <span>
        {label}
        {note && <span className="mt-0.5 block text-[11px] text-[color-mix(in_srgb,CanvasText_55%,Canvas)]">{note}</span>}
      </span>
      {children}
    </label>
  );
}

function Switch({ checked, onChange }) {
  return (
    <input
      type="checkbox"
      checked={!!checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 shrink-0 accent-ok"
    />
  );
}

function Section({ title, children, className = "" }) {
  return (
    <section className={className}>
      <h2 className="mb-1 text-xs font-semibold tracking-wide uppercase opacity-60">{title}</h2>
      {children}
    </section>
  );
}

function DomainList({ label, note, value, onChange, onBlur }) {
  return (
    <label className="block py-2.5 text-[13px]">
      {label}
      <span className="mb-1 block text-[11px] opacity-60">{note}</span>
      <textarea
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        className="mt-1 min-h-16 w-full rounded-lg border border-[color-mix(in_srgb,CanvasText_16%,Canvas)] bg-[Canvas] p-2"
      />
    </label>
  );
}

function OptionsApp() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [excludedText, setExcludedText] = useState("");
  const [blockedText, setBlockedText] = useState("");
  const [policy, setPolicy] = useState({ ready: false, available: false, hidden: false });
  const [bubble, setBubble] = useState({ shown: false, checked: false, disabled: true });
  const [address, setAddress] = useState({ shown: false, checked: false, disabled: true });

  useEffect(() => {
    chrome.storage.local.get(DEFAULTS, (saved) => {
      const next = { ...DEFAULTS, ...saved };
      setSettings(next);
      setExcludedText((next.excludedDomains || []).join("\n"));
      setBlockedText((next.blockedDomains || []).join("\n"));
    });
    sendPolicy("get").then((r) => {
      if (r.error || !r.ok) setPolicy({ ready: true, available: false, hidden: false });
      else setPolicy({ ready: true, available: true, hidden: !!r.hidden });
    });
    readPrivacy("passwordSavingEnabled", setBubble);
    readPrivacy("autofillAddressEnabled", setAddress);
  }, []);

  function persist(partial) {
    const next = { ...settings, ...partial };
    setSettings(next);
    chrome.storage.local.set(partial);
  }

  function check(id, label, note) {
    return (
      <Row key={id} label={label} note={note}>
        <Switch checked={settings[id]} onChange={(on) => persist({ [id]: on })} />
      </Row>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <header className="mb-6 flex items-center gap-2">
        <img src="../icons/icon48.png" alt="" width="28" height="28" />
        <h1 className="text-lg font-semibold">PassBridge</h1>
      </header>
      <Section title="Autofill">
        <Row label="Inline menu">
          <select
            value={settings.inlineMenuVisibility}
            onChange={(e) => persist({ inlineMenuVisibility: e.target.value })}
            className="rounded-lg border border-[color-mix(in_srgb,CanvasText_16%,Canvas)] bg-[Canvas] px-2 py-1"
          >
            <option value="on-focus">Show on field focus</option>
            <option value="on-click">Show when the icon is clicked</option>
            <option value="off">Off</option>
          </select>
        </Row>
        {check("autofillOnPageLoad", "Autofill on page load", "Off by default. A single match can ask for Touch ID or Windows Hello as the page opens.")}
        {check("showAnimations", "Fill animation")}
        {check("showFavicons", "Website icons")}
        <DomainList
          label="Blocked domains"
          note="One hostname per line. No inline menu on these sites."
          value={blockedText}
          onChange={(e) => setBlockedText(e.target.value)}
          onBlur={() => persist({ blockedDomains: lines(blockedText) })}
        />
      </Section>
      <Section title="Saving" className="mt-6">
        {check("askToSave", "Ask to save a new login")}
        {check("askToUpdate", "Ask to update an existing login")}
        <DomainList
          label="Excluded domains"
          note="One hostname per line. PassBridge will not offer to save these."
          value={excludedText}
          onChange={(e) => setExcludedText(e.target.value)}
          onBlur={() => persist({ excludedDomains: lines(excludedText) })}
        />
        {check("copyTotpAfterFill", "Copy verification code after fill")}
        <Row label="Clear clipboard">
          <select
            value={String(settings.clipboardClearMs)}
            onChange={(e) => persist({ clipboardClearMs: Number(e.target.value) })}
            className="rounded-lg border border-[color-mix(in_srgb,CanvasText_16%,Canvas)] bg-[Canvas] px-2 py-1"
          >
            <option value="0">Never</option>
            <option value="10000">10 seconds</option>
            <option value="20000">20 seconds</option>
            <option value="30000">30 seconds</option>
            <option value="60000">1 minute</option>
            <option value="300000">5 minutes</option>
          </select>
        </Row>
      </Section>
      <Section title="Browser" className="mt-6">
        {check("enableContextMenu", "Context menu")}
        {check("enableBadge", "Badge count on the toolbar icon")}
        <p className="py-2">
          <button type="button" className="text-[13px] text-accent" onClick={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}>
            Keyboard shortcuts
          </button>
        </p>
        {bubble.shown && !bubble.disabled && (
          <Row label="Hide Chrome's save-password bubble">
            <Switch checked={bubble.checked} onChange={(on) => setPrivacy("passwordSavingEnabled", on, setBubble, "suppressSaveBubble")} />
          </Row>
        )}
        {policy.ready && policy.available && (
          <Row label="Hide Chrome's password manager">
            <Switch
              checked={policy.hidden}
              onChange={async (on) => {
                const r = await sendPolicy(on ? "set" : "clear");
                if (r.error || !r.ok) setPolicy({ ready: true, available: false, hidden: false });
                else setPolicy({ ready: true, available: true, hidden: !!r.hidden });
              }}
            />
          </Row>
        )}
        {policy.ready && !policy.available && (
          <p className="py-2 text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">
            Install the optional helper to hide Chrome's password manager.
          </p>
        )}
        {address.shown && !address.disabled && (
          <Row label="Hide Chrome's address suggestions">
            <Switch checked={address.checked} onChange={(on) => setPrivacy("autofillAddressEnabled", on, setAddress, "suppressAddressAutofill")} />
          </Row>
        )}
        {check("hidePasskeys", "Hide passkey autofill")}
      </Section>
    </div>
  );
}

function lines(value) {
  return value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

function sendPolicy(action) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.passbridge.policy", { action }, (resp) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(resp || { error: "no reply" });
      });
    } catch (err) {
      resolve({ error: String(err) });
    }
  });
}

function readPrivacy(name, setRow) {
  const pref = chrome.privacy?.services?.[name];
  if (!pref?.get) return;
  pref.get({}, (d) => {
    if (chrome.runtime.lastError || !d) return;
    const controllable = d.levelOfControl === "controllable_by_this_extension" || d.levelOfControl === "controlled_by_this_extension";
    setRow({ shown: true, checked: d.value === false, disabled: !controllable });
  });
}

function setPrivacy(name, on, setRow, storageKey) {
  const pref = chrome.privacy?.services?.[name];
  if (!pref) return;
  chrome.storage.local.set({ [storageKey]: on });
  const done = () => readPrivacy(name, setRow);
  if (on) pref.set({ value: false }, done);
  else pref.clear({}, done);
}

createRoot(document.getElementById("root")).render(<OptionsApp />);
