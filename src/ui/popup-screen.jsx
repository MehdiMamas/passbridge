import { Fragment, useEffect, useState } from "react";
import { t } from "../i18n/runtime.js";
import { generateApplePassword } from "../password-generate.js";
import { TOTP_WATCH_EVERY_MS, watchState } from "./totp-watch.js";
import { codesForLogins, filterByUsername } from "./username-filter.js";

/**
 * One row from the code list or the login list. Parsed background replies, so extra fields stay open.
 * @typedef {{ id?: string, source?: string, domain?: string, username?: string, [key: string]: any }} PopupRow
 * @typedef {{ username: string, [key: string]: any }} PopupLogin
 */

/** @param {{ state: string }} props */
function StatusDot({ state }) {
  const color =
    state === "unlocked" ? "bg-ok" : state === "needs_pin" ? "bg-warn" : state === "no_helper" ? "bg-danger" : "bg-current opacity-30";
  const label =
    state === "unlocked" ? t("statusUnlocked") : state === "needs_pin" ? t("statusNeedsPin") : state === "no_helper" ? t("statusNoHelper") : t("statusConnecting");
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={label} />;
}

/** @param {{ label: string, onClick: () => void, children?: any }} props */
function IconButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,Canvas)]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.5" r="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 13.25c.6-2.1 2.3-3.25 4.5-3.25s3.9 1.15 4.5 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8h5.25M11.5 8v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** @param {{ row: PopupRow, site: string, grouped: boolean, onCopy: (field: string, row: PopupRow) => any, onFillCode: (row: PopupRow) => any }} props */
function CodeRow({ row, site, grouped, onCopy, onFillCode }) {
  const [shown, setShown] = useState("");
  const [busy, setBusy] = useState(false);
  const isTotp = row.source === "totp";
  const domainDiffers = isTotp && !!row.domain && row.domain !== site && !String(site || "").endsWith("." + row.domain);
  const carriesOwnName = !grouped && isTotp && !!row.username;
  return (
    <li className={grouped ? "ml-5" : ""}>
      <div className="overflow-hidden rounded-xl bg-[color-mix(in_srgb,CanvasText_6%,Canvas)]">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 text-[13px]">
            {isTotp ? (
              t("codeTotp")
            ) : (
              <span className="italic opacity-60">{t("codeSms")}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {shown ? (
              <span className="font-mono text-sm tracking-widest">{shown}</span>
            ) : (
              <IconButton label={t("copyCode")} onClick={() => onCopy("otp", row)}>
                <LockIcon />
              </IconButton>
            )}
            {!shown && (
              <button
                type="button"
                disabled={busy}
                className="rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                onClick={async () => {
                  setBusy(true);
                  const res = await onFillCode(row);
                  if (res?.ok && res.filled) return;
                  if (res?.ok && res.code) {
                    setShown(res.code);
                    return;
                  }
                  setBusy(false);
                }}
              >
                {t("fill")}
              </button>
            )}
          </span>
        </div>
        {carriesOwnName && (
          <div data-passbridge="code-name" className="px-2 pb-1 text-[12px] opacity-70 [overflow-wrap:anywhere]">
            {row.username}
          </div>
        )}
        {domainDiffers && (
          <div data-passbridge="code-domain" className="truncate border-t border-[color-mix(in_srgb,CanvasText_10%,Canvas)] px-2 py-0.5 text-[11px] opacity-70">
            ↳ {row.domain}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Replies and values below come from the background worker as parsed messages, so those stay `any`.
 * @param {{
 *   state: string, os: string, label?: string, site: string,
 *   logins: PopupLogin[], codes: PopupRow[], caps?: any, note?: string, noteTone?: string,
 *   nudge?: any, syncSteps: string[], onSyncAll: () => any, pinError?: string, showFavicons?: boolean,
 *   update?: any, installingUpdate?: boolean, checkingUpdate?: boolean,
 *   onVerify: (pin: string) => Promise<boolean>, onNewCode: () => any,
 *   onFill: (loginName: string) => any, onFillCode: (row: PopupRow) => any,
 *   onCopy: (field: string, row: PopupRow) => any, onLookup: (value: string) => any,
 *   onOpenApp: (page: string, query?: string) => any,
 *   onAddLogin?: (login: { site: string, username: string, password: string }) => Promise<any>,
 *   onTotpScan?: () => Promise<any>, onTotpPaste: (text: string) => Promise<any>,
 *   onTotpAdd: (target: string) => Promise<any>, onTotpCopyKey: () => Promise<any>,
 *   onCheckCodes: () => Promise<PopupRow[]>, onLock: () => any, onRefresh: () => any, onSettings: () => any,
 *   onReport: () => any, onOpenUpdate: () => any, onInstallUpdate: () => any, onDismissUpdate: () => any,
 *   onCheckUpdate?: () => any,
 * }} props
 */
export function PopupScreen({
  state,
  os,
  label,
  site,
  logins,
  codes,
  caps,
  note,
  noteTone,
  nudge,
  syncSteps,
  onSyncAll,
  pinError,
  showFavicons,
  update,
  installingUpdate,
  checkingUpdate,
  onVerify,
  onNewCode,
  onFill,
  onFillCode,
  onCopy,
  onLookup,
  onOpenApp,
  onAddLogin,
  onTotpScan,
  onTotpPaste,
  onTotpAdd,
  onTotpCopyKey,
  onCheckCodes,
  onLock,
  onRefresh,
  onSettings,
  onReport,
  onOpenUpdate,
  onInstallUpdate,
  onDismissUpdate,
  onCheckUpdate,
}) {
  const [pin, setPin] = useState("");
  const [query, setQuery] = useState("");
  const [agentOn, setAgentOn] = useState(false);
  const [agentAll, setAgentAll] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [held, setHeld] = useState(null);
  const [target, setTarget] = useState("");
  const [addMsg, setAddMsg] = useState("");
  const [added, setAdded] = useState(false);
  const [watch, setWatch] = useState("waiting");

  // after the hand-off, re-check the code list while the popup is open (list only, no code reads)
  useEffect(() => {
    if (!added) return undefined;
    let dead = false;
    const startedAt = Date.now();
    setWatch("waiting");
    const timer = setInterval(async () => {
      /** @type {PopupRow[]} */
      let rows = [];
      try {
        rows = await onCheckCodes();
      } catch (_) {}
      if (dead) return;
      const next = watchState(rows, { target, elapsedMs: Date.now() - startedAt, windows: os === "win" });
      setWatch(next);
      if (next !== "waiting") clearInterval(timer);
    }, TOTP_WATCH_EVERY_MS);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [added]);
  const [loginOpen, setLoginOpen] = useState(false);
  const [newSite, setNewSite] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newShown, setNewShown] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const win = os === "win";
  const unlocked = state === "unlocked";

  useEffect(() => {
    try {
      chrome.storage.sync.get({ agentSignIn: false, agentAllowAll: false }, (o) => {
        setAgentOn(o?.agentSignIn === true);
        setAgentAll(o?.agentAllowAll === true);
      });
    } catch {}
  }, []);

  /** @param {string | undefined} a @param {string | undefined} b */
  const isSameUser = (a, b) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
  const shownLogins = filterByUsername(logins, userQuery);
  const shownCodes = codesForLogins(codes, shownLogins, userQuery);
  const groups = shownLogins.map((login) => ({
    login,
    codes: shownCodes.filter((row) => row.username && isSameUser(row.username, login.username)),
  }));
  const groupedCodes = new Set(groups.flatMap((g) => g.codes));
  const ungroupedCodes = shownCodes.filter((row) => !groupedCodes.has(row));
  const noMatch = logins.length > 0 && !!userQuery.trim() && shownLogins.length === 0;

  /** @param {string} value */
  async function submitPin(value) {
    const ok = await onVerify(value);
    if (!ok) setPin("");
  }

  /** @param {string} value */
  function onPinChange(value) {
    const next = value.replace(/\D/g, "").slice(0, 6);
    setPin(next);
    if (next.length === 6) submitPin(next);
  }

  return (
    <div className={`flex w-[340px] flex-col overflow-hidden bg-[Canvas] text-[CanvasText] ${unlocked ? "max-h-[480px]" : "min-h-[240px]"}`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,CanvasText_12%,Canvas)] px-3 py-2.5">
        <img src="../icons/icon48.png" alt="" width="20" height="20" />
        <h1 className="flex-1 text-sm font-semibold tracking-tight">PassBridge</h1>
        {(unlocked || state === "needs_pin") && (
          <button
            type="button"
            className="rounded-lg border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] px-2 py-0.5 text-base"
            aria-label={t("refreshPasswords")}
            onClick={() => {
              if (state === "needs_pin") setPin("");
              onRefresh();
            }}
          >
            ↻
          </button>
        )}
        <StatusDot state={state} />
      </header>
      {agentOn && (
        <p className="shrink-0 px-3 pt-1.5 text-[11px] text-[color-mix(in_srgb,CanvasText_55%,Canvas)]">{agentAll ? t("agentOnAll") : t("agentOn")}</p>
      )}
      {update && (
        <div
          data-passbridge="update"
          className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,var(--color-accent)_10%,Canvas)] py-1.5 pr-1.5 pl-3 text-[12px]"
        >
          <span className="min-w-0 flex-1 truncate">{t("updateAvailable", [`v${update.version}`])}</span>
          <button
            type="button"
            disabled={installingUpdate}
            className="shrink-0 cursor-pointer font-semibold text-accent disabled:opacity-60"
            onClick={onInstallUpdate}
          >
            {installingUpdate ? t("updating") : t("updateNow")}
          </button>
          <button type="button" className="shrink-0 cursor-pointer font-semibold text-accent" onClick={onOpenUpdate}>
            {t("viewRelease")}
          </button>
          <button
            type="button"
            aria-label="Dismiss update notice"
            title={t("dismiss")}
            className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-lg text-sm opacity-60 hover:bg-[color-mix(in_srgb,CanvasText_8%,Canvas)] hover:opacity-100"
            onClick={onDismissUpdate}
          >
            ×
          </button>
        </div>
      )}
      {unlocked && (
        <div className="shrink-0 px-3 pt-2">
          <input
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              onLookup(next.trim());
            }}
            placeholder={t("lookupPlaceholder")}
            aria-label={t("lookupPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-2 py-1.5 text-[13px]"
          />
          <input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder={t("lookupUserPlaceholder")}
            aria-label={t("lookupUserPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 w-full rounded-lg border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-2 py-1.5 text-[13px]"
          />
          {site && <p className="mt-2 truncate text-[13px] font-semibold">{site}</p>}
        </div>
      )}
      <main className={`flex flex-col gap-2 px-3 py-2 ${unlocked ? "min-h-0 flex-1 overflow-y-auto" : "flex-1"}`}>
        {state === "no_helper" && (
          <p className="text-[13px] leading-snug text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">
            {win ? t("noHelperWin") : t("noHelperMac")}
          </p>
        )}
        {state === "connecting" && <p className="text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">{t("connectingApple")}</p>}
        {state === "needs_pin" && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitPin(pin.trim());
            }}
          >
            <p className="text-[13px] leading-snug text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">
              {win ? t("pinSentWin") : t("pinSentMac", [label || t("deviceMac")])}
            </p>
            <input
              value={pin}
              onChange={(e) => onPinChange(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t("pinPlaceholder")}
              className="rounded-xl border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-3 py-2 text-center text-xl tracking-[0.4em]"
            />
            <button type="submit" className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white">
              {t("unlock")}
            </button>
            <button
              type="button"
              className="text-left text-[13px] text-accent"
              onClick={() => {
                setPin("");
                onNewCode();
              }}
            >
              {t("requestNewCode")}
            </button>
            {pinError && <p className="text-[13px] text-danger">{pinError}</p>}
          </form>
        )}
        {unlocked && (
          <>
            {logins.length === 0 && <p className="text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">{t("noSavedPasswords")}</p>}
            {noMatch && <p className="text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">{t("noLoginMatch", [userQuery.trim(), site])}</p>}
            {userQuery.trim() && (logins.length === 0 || noMatch) && (
              <button type="button" className="self-start py-1 text-xs text-accent" onClick={() => onOpenApp("search", userQuery.trim())}>
                {t("searchUserInPasswords")}
              </button>
            )}
            <ul className="flex flex-col gap-1">
              {groups.map(({ login, codes: ownCodes }) => (
                <Fragment key={login.username}>
                  <li className="flex items-center gap-1.5 rounded-xl border border-[color-mix(in_srgb,CanvasText_10%,Canvas)] bg-[Canvas] px-2 py-1">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {showFavicons && site && (
                        <img alt="" width="16" height="16" className="h-4 w-4 shrink-0 rounded" src={`https://icons.duckduckgo.com/ip3/${site}.ico`} />
                      )}
                      <span className="truncate text-[13px] font-medium">{login.username || t("noUsername")}</span>
                    </span>
                    <IconButton label={t("copyUsername")} onClick={() => onCopy("username", login)}>
                      <UserIcon />
                    </IconButton>
                    <IconButton label={t("copyPassword")} onClick={() => onCopy("password", login)}>
                      <KeyIcon />
                    </IconButton>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white"
                      onClick={() => onFill(login)}
                    >
                      {t("fill")}
                    </button>
                  </li>
                  {ownCodes.map((row) => (
                    <CodeRow key={row.id} row={row} site={site} grouped onCopy={onCopy} onFillCode={onFillCode} />
                  ))}
                </Fragment>
              ))}
              {ungroupedCodes.map((row) => (
                <CodeRow key={row.id} row={row} site={site} grouped={false} onCopy={onCopy} onFillCode={onFillCode} />
              ))}
            </ul>
            {onAddLogin && (
              <div data-passbridge="add-login" className="flex flex-col gap-1.5">
                {!loginOpen ? (
                  <button
                    type="button"
                    className="self-start text-xs font-semibold text-accent"
                    onClick={() => { setNewSite(site || ""); setNewUser(""); setNewPass(""); setLoginMsg(""); setLoginOpen(true); }}
                  >
                    {t("addLogin")}
                  </button>
                ) : (
                  <form
                    className="flex flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,CanvasText_10%,Canvas)] p-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setLoginBusy(true);
                      setLoginMsg("");
                      const res = await onAddLogin({ site: newSite.trim(), username: newUser.trim(), password: newPass });
                      setLoginBusy(false);
                      if (res?.sheet) setLoginMsg(res.note || "");
                      else if (res?.ok) { setLoginOpen(false); setNewPass(""); }
                      else setLoginMsg(res?.error || t("errSaveLogin"));
                    }}
                  >
                    <input value={newSite} onChange={(e) => setNewSite(e.target.value)} placeholder={t("website")} aria-label={t("website")} data-field="new-site" autoComplete="off" spellCheck={false} className="rounded-lg border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] px-2 py-1 text-xs" />
                    <input value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder={t("usernameOrEmail")} aria-label={t("usernameOrEmail")} data-field="new-username" autoComplete="off" spellCheck={false} className="rounded-lg border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] px-2 py-1 text-xs" />
                    <span className="flex gap-1.5">
                      <input type={newShown ? "text" : "password"} value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder={t("password")} aria-label={t("password")} data-field="new-password" autoComplete="new-password" className="min-w-0 flex-1 rounded-lg border border-[color-mix(in_srgb,CanvasText_20%,Canvas)] bg-[Canvas] px-2 py-1 text-xs" />
                      <button type="button" className="text-xs opacity-80" onClick={() => { setNewPass(generateApplePassword()); setNewShown(true); }}>{t("generate")}</button>
                      <button type="button" className="text-xs opacity-80" onClick={() => setNewShown(!newShown)}>{newShown ? t("hide") : t("show")}</button>
                    </span>
                    {loginMsg && <p className="text-xs text-danger">{loginMsg}</p>}
                    <span className="flex justify-end gap-2">
                      <button type="button" className="text-xs opacity-80" onClick={() => setLoginOpen(false)}>{t("cancel")}</button>
                      <button type="submit" data-action="add-login" disabled={loginBusy || !newSite.trim() || !newPass} className="rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">
                        {loginBusy ? t("savingLogin") : t("saveLoginBtn")}
                      </button>
                    </span>
                  </form>
                )}
              </div>
            )}
            {caps?.setUpTotp && onTotpScan && (
              <div data-passbridge="add-totp" className="flex flex-col gap-1.5">
                {!addOpen ? (
                  <button type="button" className="self-start text-xs font-semibold text-accent" onClick={() => setAddOpen(true)}>
                    {t("addCode")}
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5 rounded-xl border border-[color-mix(in_srgb,CanvasText_10%,Canvas)] p-2">
                    {!held && (
                      <>
                        <button
                          type="button"
                          className="rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white"
                          onClick={async () => {
                            setAddMsg(t("scanningPage"));
                            const res = await onTotpScan();
                            if (res?.ok) { setHeld(res); setAddMsg(""); } else setAddMsg(res?.error || t("qrUnreadable"));
                          }}
                        >
                          Scan the visible page
                        </button>
                        <input
                          value={pasted}
                          onChange={(e) => setPasted(e.target.value)}
                          placeholder={t("pasteKey")}
                          aria-label={t("setupKey")}
                          autoComplete="off"
                          spellCheck={false}
                          className="w-full rounded-lg border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-2 py-1 text-[13px]"
                        />
                        <button
                          type="button"
                          disabled={!pasted.trim()}
                          className="self-start rounded-lg border border-accent px-2 py-1 text-xs font-semibold text-accent disabled:opacity-50"
                          onClick={async () => {
                            const res = await onTotpPaste(pasted);
                            setPasted("");
                            if (res?.ok) { setHeld(res); setAddMsg(""); } else setAddMsg(res?.error || t("badSetupKey"));
                          }}
                        >
                          Use this key
                        </button>
                      </>
                    )}
                    {held && !added && (
                      <>
                        <p className="text-[12px]">{t("codeForLogin")}</p>
                        {logins.length === 0 && <p className="text-[12px] opacity-70">{t("noLoginHere")}</p>}
                        {logins.map((login) => (
                          <label key={login.username} className="flex items-center gap-2 text-[13px]">
                            <input type="radio" name="totp-login" checked={target === login.username} onChange={() => setTarget(login.username)} />
                            <span className="truncate">{login.username || t("noUsername")}</span>
                          </label>
                        ))}
                        <button
                          type="button"
                          disabled={logins.length > 0 && !target}
                          className="self-start rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                          onClick={async () => {
                            const res = await onTotpAdd(target);
                            if (res?.ok && res.launched) { setAdded(true); setAddMsg(""); } else setAddMsg(res?.error || res?.detail || t("couldntOpenPasswords"));
                          }}
                        >
                          {t("addToPasswords")}
                        </button>
                      </>
                    )}
                    {added && (
                      <>
                        <p className="text-[12px]">
                          {watch === "saved"
                            ? t("totpSavedCheck")
                            : watch === "timeout"
                              ? t("totpNotSavedYet")
                              : watch === "check"
                                ? t("totpCheckRefresh")
                                : target
                                  ? t("passwordsOpenNoteWith", [target])
                                  : t("passwordsOpenNote")}
                        </p>
                        <button type="button" className="self-start text-xs text-accent" onClick={async () => { const r = await onTotpCopyKey(); setAddMsg(r?.copied ? t("setupKeyCopied") : r?.error || ""); }}>
                          {t("copySetupKey")}
                        </button>
                      </>
                    )}
                    {addMsg && <p className="text-xs opacity-80">{addMsg}</p>}
                  </div>
                )}
              </div>
            )}
            {note && (
              <p className={`text-xs ${noteTone === "danger" ? "text-danger" : noteTone === "ok" ? "text-ok" : "opacity-70"}`}>{note}</p>
            )}
            {nudge && (
              <div data-passkey-nudge className="text-xs">
                <p className="opacity-80">{t("passkeyNudge")}</p>
                <button type="button" className="py-1 text-accent" onClick={onSyncAll}>
                  {t("syncAllLink")}
                </button>
                {syncSteps.length > 0 && (
                  <ol data-sync-steps className="list-decimal pl-4 opacity-80">
                    {syncSteps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <footer className="flex shrink-0 flex-col border-t border-[color-mix(in_srgb,CanvasText_12%,Canvas)] px-3 py-2">
        {unlocked && (
          <div className="flex flex-col items-start pb-1">
            <button type="button" className="py-1 text-xs text-accent" onClick={() => onOpenApp("search", userQuery.trim() || undefined)}>
              {t("openInPasswords")}
            </button>
            {caps?.newPasswordSheet && (
              <button type="button" className="py-1 text-xs text-accent" onClick={() => onOpenApp("new")}>
                {t("newLoginInPasswords")}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center justify-between">
          {unlocked ? (
            <button type="button" className="text-xs text-accent" onClick={onLock}>
              {t("lock")}
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-3">
            <button type="button" className="text-xs text-accent" onClick={onReport}>
              {t("reportThisPage")}
            </button>
            {onCheckUpdate && (
              <button type="button" disabled={checkingUpdate} className="text-xs text-accent disabled:opacity-60" onClick={onCheckUpdate}>
                {checkingUpdate ? t("checking") : t("checkForUpdates")}
              </button>
            )}
            <button type="button" className="text-xs text-accent" onClick={onSettings}>
              {t("settings")}
            </button>
          </span>
        </div>
      </footer>
    </div>
  );
}
