import { createRoot } from "react-dom/client";
import { PopupScreen } from "./popup-screen.jsx";
import { UpdateScreen } from "./update-screen.jsx";

const noop = () => {};
const slow = () => new Promise((resolve) => setTimeout(resolve, 800));
/** @type {[string, any][]} demo props are partial, merged into the screen */
const screens = [
  ["no_helper", { state: "no_helper", os: "win" }],
  ["needs_pin", { state: "needs_pin", os: "mac", label: "your Mac" }],
  ["connecting", { state: "connecting" }],
  [
    "unlocked",
    {
      state: "unlocked",
      site: "accounts.example",
      showFavicons: false,
      logins: [
        { username: "ada@example.com" },
        { username: "grace@example.com" },
        { username: "ada.lovelace@example.com" },
        { username: "grace.hopper@example.com" },
        { username: "radia@example.com" },
        { username: "katherine@example.com" },
      ],
      codes: [{ id: 0, source: "totp", domain: "accounts.example", username: "ada@example.com" }],
      caps: { newPasswordSheet: true, setUpTotp: true },
    },
  ],
  [
    "grouped_codes",
    {
      state: "unlocked",
      site: "cloudflare.com",
      showFavicons: false,
      logins: [{ username: "alice@cf.com" }, { username: "Bob@CF.com" }],
      codes: [
        { id: 0, source: "totp", username: "alice@cf.com", domain: "cloudflare.com" },
        { id: 1, source: "totp", username: "alice@cf.com", domain: "api.cloudflare.com" },
        { id: 2, source: "totp", username: "bob@cf.com", domain: "Instagram" },
        { id: 3, source: "totp", username: "carol@elsewhere.com", domain: "cloudflare.com" },
        { id: 5, source: "totp", username: "dave@elsewhere.com", domain: "instagram.example" },
        { id: 4, source: "sms", username: "", domain: "" },
      ],
      caps: { newPasswordSheet: true },
    },
  ],
  [
    "update_available",
    {
      state: "unlocked",
      site: "accounts.example",
      showFavicons: false,
      logins: [{ username: "ada@example.com" }, { username: "grace@example.com" }],
      update: { version: "1.4.0", url: "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.0" },
    },
  ],
];

/** @param {{ title: string, scheme: string, props: any }} args props are partial demo data merged into the screen */
function Frame({ title, scheme, props }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[color-mix(in_srgb,CanvasText_15%,Canvas)] bg-[Canvas] text-[CanvasText]" style={{ colorScheme: scheme }} data-screen={title} data-scheme={scheme}>
      <p className="px-3 py-1 text-[11px] uppercase tracking-wide opacity-50">
        {title} · {scheme}
      </p>
      <PopupScreen
        logins={[]}
        codes={[]}
        caps={{}}
        onVerify={noop}
        onNewCode={noop}
        onFill={noop}
        onFillCode={noop}
        onCopy={noop}
        onLookup={noop}
        onOpenApp={(mode) => {
          document.body.dataset.openedApp = mode;
        }}
        onAddLogin={async () => ({})}
        onTotpScan={async () => ({})}
        onLock={noop}
        onRefresh={slow}
        onSettings={noop}
        onReport={slow}
        onOpenUpdate={noop}
        onDismissUpdate={noop}
        {...props}
      />
    </section>
  );
}

const release = { version: "1.4.2", pageUrl: "https://github.com/MehdiMamas/passbridge/releases/tag/v1.4.2" };
/** @type {[string, Record<string, unknown>, string[]][]} */
/** @type {[string, any, string[]][]} */
const updateScreens = [
  ["ready_first", { phase: "ready", release }, ["light"]],
  ["ready", { phase: "ready", release, folderName: "passbridge" }, ["light"]],
  ["working", { phase: "working", release, folderName: "passbridge", step: "write", progress: 0.72 }, ["light", "dark"]],
  ["failed", { phase: "failed", release, folderName: "passbridge", error: { message: "Couldn't write the new files.", restored: true } }, ["light"]],
  ["unsigned", { phase: "unsigned", release }, ["light"]],
  ["interrupted", { phase: "interrupted" }, ["light"]],
  ["done", { phase: "done", installed: "1.4.2" }, ["light"]],
  ["stale", { phase: "stale", expected: "1.4.2" }, ["light"]],
];

/** @param {{ title: string, scheme: string, props: any }} args props are partial demo data merged into the screen */
function UpdateFrame({ title, scheme, props }) {
  return (
    <section className="w-[600px] overflow-hidden rounded-2xl border border-[color-mix(in_srgb,CanvasText_15%,Canvas)] bg-[Canvas] text-[CanvasText]" style={{ colorScheme: scheme }} data-update-screen={title} data-scheme={scheme}>
      <p className="px-3 py-1 text-[11px] uppercase tracking-wide opacity-50">
        update page · {title} · {scheme}
      </p>
      <UpdateScreen installed="1.4.1" onUpdate={noop} onChangeFolder={noop} onRetry={noop} onRestore={noop} {...props} />
    </section>
  );
}

function Preview() {
  return (
    <div className="flex flex-wrap gap-4 bg-neutral-200 p-4">
      {screens.flatMap(([title, props]) =>
        ["light", "dark"].map((scheme) => <Frame key={`${title}-${scheme}`} title={title} scheme={scheme} props={props} />),
      )}
      {updateScreens.flatMap(([title, props, schemes]) =>
        schemes.map((scheme) => <UpdateFrame key={`update-${title}-${scheme}`} title={title} scheme={scheme} props={props} />),
      )}
    </div>
  );
}

createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(<Preview />);
