import { createRoot } from "react-dom/client";
import { PopupScreen } from "./popup-screen.jsx";

const noop = () => {};
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
      caps: { newPasswordSheet: true },
    },
  ],
];

function Frame({ title, scheme, props }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[color-mix(in_srgb,CanvasText_15%,Canvas)]" style={{ colorScheme: scheme }} data-screen={title} data-scheme={scheme}>
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
        onOpenApp={noop}
        onLock={noop}
        onRefresh={noop}
        onSettings={noop}
        {...props}
      />
    </section>
  );
}

function Preview() {
  return (
    <div className="flex flex-wrap gap-4 bg-neutral-200 p-4">
      {screens.flatMap(([title, props]) =>
        ["light", "dark"].map((scheme) => <Frame key={`${title}-${scheme}`} title={title} scheme={scheme} props={props} />),
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
