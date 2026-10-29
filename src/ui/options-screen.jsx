import { useId } from "react";
import { OPTION_TABS } from "./options-model.js";

const muted = "text-[color-mix(in_srgb,CanvasText_62%,Canvas)]";
const hairline = "border-[color-mix(in_srgb,CanvasText_10%,Canvas)]";
const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const field = `rounded-lg border border-[color-mix(in_srgb,CanvasText_16%,Canvas)] bg-[Canvas] text-[13px] text-[CanvasText] transition-colors duration-150 enabled:hover:border-[color-mix(in_srgb,CanvasText_32%,Canvas)] enabled:active:bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] disabled:cursor-not-allowed ${focusRing}`;
const secondaryButton = `cursor-pointer rounded-lg border border-[color-mix(in_srgb,CanvasText_16%,Canvas)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 hover:bg-[color-mix(in_srgb,CanvasText_6%,Canvas)] active:bg-[color-mix(in_srgb,CanvasText_10%,Canvas)] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

const ACTIVITY_COLUMNS = [
  ["Time", "w-32"],
  ["Request", "w-20"],
  ["Site", ""],
  ["Username", ""],
  ["Result", "w-26"],
];
const activityCell = "truncate px-2.5 py-1.5";
const SHORT_TIME = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

const CLEAR_OPTIONS = [
  ["10000", "10 seconds"],
  ["20000", "20 seconds"],
  ["30000", "30 seconds"],
  ["60000", "1 minute"],
  ["300000", "5 minutes"],
];

function Icon({ children }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

const TAB_ICONS = {
  autofill: (
    <Icon>
      <rect x="1.75" y="4.25" width="12.5" height="7.5" rx="2" />
      <circle cx="5" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="11" cy="8" r=".6" fill="currentColor" />
    </Icon>
  ),
  appearance: (
    <Icon>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" stroke="none" />
    </Icon>
  ),
  browser: (
    <Icon>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M1.75 6h12.5" />
    </Icon>
  ),
  agents: (
    <Icon>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" />
    </Icon>
  ),
  updates: (
    <Icon>
      <path d="M8 2.25v7.5M5 6.75l3 3 3-3M2.75 10.75v1.5c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1v-1.5" />
    </Icon>
  ),
};

function Switch({ ids, checked, disabled, onChange }) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0">
      <input
        id={ids.control}
        type="checkbox"
        role="switch"
        aria-labelledby={ids.label}
        aria-describedby={ids.describedBy}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={`peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,CanvasText_45%,Canvas)] transition-colors duration-150 checked:bg-ok enabled:hover:bg-[color-mix(in_srgb,CanvasText_58%,Canvas)] checked:enabled:hover:bg-[color-mix(in_srgb,var(--color-ok)_82%,CanvasText)] disabled:cursor-not-allowed ${focusRing}`}
      />
      <span aria-hidden="true" className="pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform duration-150 peer-checked:translate-x-4 peer-active:scale-90" />
    </span>
  );
}

function Select({ ids, value, disabled, options, onChange }) {
  return (
    <select
      id={ids.control}
      aria-labelledby={ids.label}
      aria-describedby={ids.describedBy}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${field} cursor-pointer px-2.5 py-1.5`}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

function Row({ label, help, note, state = "ready", isWide = false, isLabel = true, children }) {
  const base = useId();
  const helpId = help ? `${base}h` : undefined;
  const noteId = note ? `${base}n` : undefined;
  const ids = { control: `${base}c`, label: `${base}l`, help: helpId, note: noteId, describedBy: [helpId, noteId].filter(Boolean).join(" ") || undefined };
  const isDisabled = state !== "ready";
  const Outer = isLabel ? "label" : "div";
  const text = (
    <div className="min-w-0">
      <span id={ids.label} className="block text-sm font-medium">
        {label}
      </span>
      {help && (
        <p id={ids.help} data-help className={`mt-1 text-[13px] leading-snug text-pretty ${muted}`}>
          {help}
        </p>
      )}
      {note && (
        <p id={ids.note} className="mt-1.5 text-[13px] leading-snug font-medium">
          {note}
        </p>
      )}
    </div>
  );
  const control = children(ids, isDisabled);
  return (
    <Outer
      htmlFor={isLabel ? ids.control : undefined}
      data-row={label}
      className={`block border-t py-4 first:border-t-0 ${hairline} ${state === "locked" ? "cursor-not-allowed opacity-50" : ""} ${isLabel && !isDisabled ? "cursor-pointer" : ""}`}
    >
      {isWide ? (
        <>
          {text}
          <div className="mt-3">{control}</div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
          <div className="min-w-0 flex-1 basis-64">{text}</div>
          <div className="shrink-0">{control}</div>
        </div>
      )}
    </Outer>
  );
}

function ButtonRow({ label, help, button, onClick }) {
  return (
    <Row label={label} help={help} isLabel={false}>
      {(ids) => (
        <button
          id={ids.control}
          type="button"
          aria-labelledby={`${ids.label} ${ids.control}`}
          aria-describedby={ids.describedBy}
          className={secondaryButton}
          onClick={onClick}
        >
          {button}
        </button>
      )}
    </Row>
  );
}

function SwitchRow({ label, help, note, state, isLabel, checked, onChange }) {
  return (
    <Row label={label} help={help} note={note} state={state} isLabel={isLabel}>
      {(ids, isDisabled) => <Switch ids={ids} checked={checked} disabled={isDisabled} onChange={onChange} />}
    </Row>
  );
}

function ListRow({ label, help, state, value, onChange, onBlur }) {
  return (
    <Row label={label} help={help} state={state} isWide>
      {(ids, isDisabled) => (
        <textarea
          id={ids.control}
          aria-labelledby={ids.label}
          aria-describedby={ids.describedBy}
          value={value}
          disabled={isDisabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          rows={3}
          spellCheck={false}
          className={`${field} block max-h-60 min-h-20 w-full resize-y px-3 py-2 leading-relaxed caret-accent [field-sizing:content]`}
        />
      )}
    </Row>
  );
}

function Notice({ notice }) {
  return (
    <div role="note" className="mt-5 flex items-start gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_28%,Canvas)] bg-[color-mix(in_srgb,var(--color-accent)_8%,Canvas)] px-4 py-3 text-[13px] leading-snug">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-px shrink-0 text-accent">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="5" r=".85" fill="currentColor" />
      </svg>
      <p>
        {notice.text}
        {notice.href && (
          <>
            {" "}
            <a href={notice.href} target="_blank" rel="noreferrer" className={`font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}>
              How to install
            </a>
          </>
        )}
      </p>
    </div>
  );
}

function ActivityTable({ log }) {
  if (!log.length) return <p className={`text-[13px] ${muted}`}>No requests yet.</p>;
  return (
    <div role="region" aria-label="Agent activity" tabIndex={0} className={`max-h-80 overflow-auto rounded-lg border ${hairline} ${focusRing}`}>
      <table className="w-full min-w-[32rem] table-fixed text-left text-[12px]">
        <thead className={`sticky top-0 bg-[Canvas] shadow-[0_1px_0_color-mix(in_srgb,CanvasText_10%,Canvas)] ${muted}`}>
          <tr>
            {ACTIVITY_COLUMNS.map(([h, width]) => (
              <th key={h} className={`${activityCell} font-medium ${width}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...log]
            .reverse()
            .slice(0, 50)
            .map((r, i) => {
              const time = new Date(r.t);
              return (
                <tr key={i} className={`border-t first:border-t-0 ${hairline}`}>
                  <td className={`${activityCell} tabular-nums`} title={time.toLocaleString()}>
                    {time.toLocaleString(undefined, SHORT_TIME)}
                  </td>
                  <td className={activityCell}>{r.op}</td>
                  <td className={activityCell} title={r.host}>
                    {r.host}
                  </td>
                  <td className={activityCell} title={r.username}>
                    {r.username}
                  </td>
                  <td className={activityCell} title={r.result}>
                    {r.result}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

const toggleProps = (settings, onChange, key) => ({ checked: settings[key], onChange: (on) => onChange({ [key]: on }) });

function AutofillTab({ settings, onChange, lists, onListChange, onListBlur }) {
  const list = (key) => ({ value: lists[key], onChange: (text) => onListChange(key, text), onBlur: () => onListBlur(key) });
  const toggle = (key) => toggleProps(settings, onChange, key);
  return (
    <>
      <Row label="Inline menu" help="When the saved-login menu opens on a login field.">
        {(ids, isDisabled) => (
          <Select
            ids={ids}
            value={settings.inlineMenuVisibility}
            disabled={isDisabled}
            options={[
              ["on-focus", "Show on field focus"],
              ["on-click", "Show when the icon is clicked"],
              ["off", "Off"],
            ]}
            onChange={(v) => onChange({ inlineMenuVisibility: v })}
          />
        )}
      </Row>
      <ListRow label="Sites without the inline menu" help="One site per line. Subdomains are included." {...list("blockedDomains")} />
      <SwitchRow
        label="Autofill on page load"
        help="Fills the login as the page opens when exactly one saved login matches. Can ask for Touch ID or Windows Hello right away."
        {...toggle("autofillOnPageLoad")}
      />
      <SwitchRow label="Fill and save on HTTP pages" help="HTTP pages are unencrypted and can be spoofed. Keep this off unless you need it." {...toggle("canFillOnHttp")} />
      <SwitchRow label="Ask to save new logins" help="Offers to save a login PassBridge doesn't have yet, after you sign in." {...toggle("askToSave")} />
      <SwitchRow label="Ask to update changed passwords" help="Offers to update a saved login when you sign in with a new password." {...toggle("askToUpdate")} />
      <ListRow label="Never-save sites" help="One site per line. PassBridge never offers to save on these sites." {...list("excludedDomains")} />
      <SwitchRow label="Copy codes after filling" help="Also copies a verification code to the clipboard when PassBridge fills it." {...toggle("copyTotpAfterFill")} />
      <Row
        label="Clear clipboard after"
        help="Clears anything PassBridge copies (passwords, usernames, codes) after this time. Windows clipboard history and clipboard apps keep their own copy."
      >
        {(ids, isDisabled) => (
          <Select ids={ids} value={String(settings.clipboardClearMs)} disabled={isDisabled} options={CLEAR_OPTIONS} onChange={(v) => onChange({ clipboardClearMs: Number(v) })} />
        )}
      </Row>
    </>
  );
}

function AppearanceTab({ settings, onChange }) {
  const toggle = (key) => toggleProps(settings, onChange, key);
  return (
    <>
      <SwitchRow label="Fill animation" help="Briefly highlights each field as it is filled." {...toggle("showAnimations")} />
      <SwitchRow label="Website icons" help="Shows site icons in the popup. Icons load from DuckDuckGo." {...toggle("showFavicons")} />
      <SwitchRow label="Login count on the toolbar icon" help="Shows how many saved logins match the current site." {...toggle("enableBadge")} />
    </>
  );
}

function BrowserTab({ settings, onChange, view, policy, onPolicy, privacy, onPrivacy, onShortcuts, onPasswordSettings }) {
  const isShown = (p) => p.shown && !p.disabled;
  const toggle = (key) => toggleProps(settings, onChange, key);
  return (
    <>
      <SwitchRow label="Right-click menu" help="Adds PassBridge fill options to the page's right-click menu." {...toggle("enableContextMenu")} />
      <ButtonRow label="Keyboard shortcuts" help="Set the keys that show your logins, fill a login, or lock PassBridge." button="Change" onClick={onShortcuts} />
      <SwitchRow
        label="Hide passkey suggestions"
        help="Hides the passkey option in a login field's menu. Passkey sign-in buttons still work."
        {...toggle("hidePasskeys")}
      />
      {isShown(privacy.address) && (
        <SwitchRow
          label="Hide the browser's address suggestions"
          help="Turns off the browser's own address autofill on forms."
          checked={privacy.address.checked}
          onChange={(on) => onPrivacy("address", on)}
        />
      )}
      {isShown(privacy.bubble) && (
        <SwitchRow label="Hide the browser's save-password prompt" help="Only PassBridge offers to save logins." checked={privacy.bubble.checked} onChange={(on) => onPrivacy("bubble", on)} />
      )}
      <SwitchRow
        label="Hide the browser's password manager"
        help="Locks the browser's offer to save passwords off with a policy, so it can't be turned back on. Passwords the browser already saved still fill. Quit and reopen the browser to apply."
        note={policy.message || undefined}
        state={view.rows.policy}
        isLabel={false}
        checked={policy.hidden}
        onChange={onPolicy}
      />
      {onPasswordSettings && (
        <ButtonRow
          label="The browser's saved passwords"
          help={`The browser still suggests passwords it saved before. Turn off "Sign in automatically", then move those passwords to iCloud Passwords and delete them in the browser.`}
          button="Open password settings"
          onClick={onPasswordSettings}
        />
      )}
    </>
  );
}

function AgentsTab({ settings, onChange, view, lists, onListChange, onListBlur, agentLog }) {
  const state = view.rows.agents;
  return (
    <>
      <SwitchRow
        label="Allow agent sign-in"
        help="A local program, such as an AI agent, can ask PassBridge to sign in on the sites below. It sees the site and username, never the password or code."
        state={state}
        {...toggleProps(settings, onChange, "agentSignIn")}
      />
      <ListRow
        label="Allowed sites"
        help="One site per line. Subdomains are included."
        state={state}
        value={lists.agentAllowlist}
        onChange={(text) => onListChange("agentAllowlist", text)}
        onBlur={() => onListBlur("agentAllowlist")}
      />
      <Row label="Activity" help="The last 50 agent requests." state={state} isWide isLabel={false}>
        {() => <ActivityTable log={agentLog} />}
      </Row>
    </>
  );
}

function UpdatesTab({ settings, onChange, view, onCheckNow }) {
  const checkNoteId = useId();
  const toggle = (key) => toggleProps(settings, onChange, key);
  return (
    <>
      <SwitchRow label="Check for updates" help="Looks for a new PassBridge release on GitHub." {...toggle("canCheckForUpdates")} />
      {settings.canCheckForUpdates && (
        <>
          <SwitchRow
            label="Install updates automatically with the helper"
            help="Installs a new signed release without asking."
            state={view.rows.autoInstall}
            {...toggle("autoInstallUpdates")}
          />
          <div data-row="Check now" className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-4 ${hairline}`}>
            <button type="button" aria-describedby={checkNoteId} className={secondaryButton} onClick={onCheckNow}>
              Check now
            </button>
            <p id={checkNoteId} className={`text-[13px] ${muted}`}>
              Opens the update page in a new tab.
            </p>
          </div>
        </>
      )}
    </>
  );
}

const TAB_BODIES = { autofill: AutofillTab, appearance: AppearanceTab, browser: BrowserTab, agents: AgentsTab, updates: UpdatesTab };

export function OptionsScreen(props) {
  const { tab, view, isSettled } = props;
  const current = OPTION_TABS.find((t) => t.id === tab) || OPTION_TABS[0];
  const Body = TAB_BODIES[current.id];
  const notice = view.notices[current.id];
  return (
    <div
      className={`@container mx-auto w-full max-w-4xl px-4 py-6 @2xl:py-12 selection:bg-[color-mix(in_srgb,var(--color-accent)_28%,Canvas)] ${isSettled ? "" : "**:duration-0!"}`}
    >
      <div className={`flex flex-col overflow-clip rounded-2xl border bg-[Canvas] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.18)] @2xl:flex-row ${hairline}`}>
        <aside className={`shrink-0 border-b bg-[color-mix(in_srgb,CanvasText_3.5%,Canvas)] @2xl:w-60 @2xl:border-r @2xl:border-b-0 ${hairline}`}>
          <div className="@2xl:sticky @2xl:top-0">
            <div className="flex items-center gap-2.5 px-5 pt-5 pb-3 @2xl:pb-5">
              <img src="../icons/icon48.png" alt="" width="24" height="24" />
              <span className="text-[15px] font-semibold">PassBridge</span>
            </div>
            <nav aria-label="Settings">
              <ul className="flex flex-wrap gap-1 px-3 pb-3 @2xl:flex-col">
                {OPTION_TABS.map((t) => {
                  const isCurrent = t.id === current.id;
                  return (
                    <li key={t.id} className="shrink-0">
                      <a
                        href={`#${t.id}`}
                        aria-current={isCurrent ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors duration-150 ${focusRing} ${
                          isCurrent
                            ? "border-[color-mix(in_srgb,CanvasText_10%,Canvas)] bg-[color-mix(in_srgb,CanvasText_7%,Canvas)] font-medium text-[CanvasText]"
                            : `border-transparent ${muted} hover:bg-[color-mix(in_srgb,CanvasText_5%,Canvas)] hover:text-[CanvasText]`
                        }`}
                      >
                        {TAB_ICONS[t.id]}
                        {t.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-5 py-6 @2xl:px-10 @2xl:py-8">
          <div className="max-w-2xl">
            <h1 className="text-xl font-semibold tracking-tight">{current.label}</h1>
            {notice && <Notice notice={notice} />}
            <div className="mt-4">
              <Body {...props} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
