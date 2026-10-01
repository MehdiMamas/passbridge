import { useState } from "react";

function StatusDot({ state }) {
  const color =
    state === "unlocked" ? "bg-ok" : state === "needs_pin" ? "bg-warn" : state === "no_helper" ? "bg-danger" : "bg-current opacity-30";
  const label =
    state === "unlocked" ? "Unlocked" : state === "needs_pin" ? "Needs the verification code" : state === "no_helper" ? "Password helper unavailable" : "Connecting";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={label} />;
}

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

function CodeRow({ row, onCopy, onFillCode }) {
  const [shown, setShown] = useState("");
  const [busy, setBusy] = useState(false);
  const label = row.source === "totp" ? `Verification code for ${row.domain || "this site"}` : "Code from Messages";
  return (
    <li className="flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,CanvasText_10%,Canvas)] px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {label}
        {row.username && <span className="opacity-60"> · {row.username}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {shown ? (
          <span className="font-mono text-sm tracking-widest">{shown}</span>
        ) : (
          <IconButton label="Copy verification code" onClick={() => onCopy("otp", row)}>
            <KeyIcon />
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
            Fill
          </button>
        )}
      </span>
    </li>
  );
}

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
  pinError,
  showFavicons,
  onVerify,
  onNewCode,
  onFill,
  onFillCode,
  onCopy,
  onLookup,
  onOpenApp,
  onLock,
  onRefresh,
  onSettings,
}) {
  const [pin, setPin] = useState("");
  const [query, setQuery] = useState("");
  const win = os === "win";
  const unlocked = state === "unlocked";

  async function submitPin(value) {
    const ok = await onVerify(value);
    if (!ok) setPin("");
  }

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
            aria-label="Refresh passwords"
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
      {unlocked && (
        <div className="shrink-0 px-3 pt-2">
          <input
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              onLookup(next.trim());
            }}
            placeholder="Look up another site"
            aria-label="Look up another site"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-2 py-1.5 text-[13px]"
          />
          {site && <p className="mt-2 truncate text-[13px] font-semibold">{site}</p>}
        </div>
      )}
      <main className={`flex flex-col gap-2 px-3 py-2 ${unlocked ? "min-h-0 flex-1 overflow-y-auto" : "flex-1"}`}>
        {state === "no_helper" && (
          <p className="text-[13px] leading-snug text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">
            {win
              ? "Couldn't reach Apple's password helper. Install iCloud for Windows, turn on Passwords, run native/windows/install.ps1, and fully quit the browser."
              : "Couldn't reach Apple's password helper. This needs macOS 14+ with the Passwords app, and the extension must run with Apple's accepted ID."}
          </p>
        )}
        {state === "connecting" && <p className="text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">Connecting to Apple Passwords…</p>}
        {state === "needs_pin" && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitPin(pin.trim());
            }}
          >
            <p className="text-[13px] leading-snug text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">
              {win
                ? "A verification code was sent by iCloud for Windows. Enter it to grant access."
                : `A verification code was generated on ${label || "your Mac"}. Enter it to grant access.`}
            </p>
            <input
              value={pin}
              onChange={(e) => onPinChange(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              className="rounded-xl border border-[color-mix(in_srgb,CanvasText_12%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-3 py-2 text-center text-xl tracking-[0.4em]"
            />
            <button type="submit" className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white">
              Unlock
            </button>
            <button
              type="button"
              className="text-left text-[13px] text-accent"
              onClick={() => {
                setPin("");
                onNewCode();
              }}
            >
              Request a new code
            </button>
            {pinError && <p className="text-[13px] text-danger">{pinError}</p>}
          </form>
        )}
        {unlocked && (
          <>
            {logins.length === 0 && <p className="text-[13px] text-[color-mix(in_srgb,CanvasText_60%,Canvas)]">No saved passwords for this site.</p>}
            <ul className="flex flex-col gap-1">
              {logins.map((login) => (
                <li
                  key={login.username}
                  className="flex items-center gap-1.5 rounded-xl border border-[color-mix(in_srgb,CanvasText_10%,Canvas)] bg-[color-mix(in_srgb,CanvasText_4%,Canvas)] px-2 py-1"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {showFavicons && site && (
                      <img alt="" width="16" height="16" className="h-4 w-4 shrink-0 rounded" src={`https://icons.duckduckgo.com/ip3/${site}.ico`} />
                    )}
                    <span className="truncate text-[13px] font-medium">{login.username || "(no username)"}</span>
                  </span>
                  <IconButton label="Copy username" onClick={() => onCopy("username", login)}>
                    <UserIcon />
                  </IconButton>
                  <IconButton label="Copy password" onClick={() => onCopy("password", login)}>
                    <KeyIcon />
                  </IconButton>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white"
                    onClick={() => onFill(login)}
                  >
                    Fill
                  </button>
                </li>
              ))}
            </ul>
            {codes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {codes.map((row) => (
                  <CodeRow key={row.id} row={row} onCopy={onCopy} onFillCode={onFillCode} />
                ))}
              </ul>
            )}
            {note && (
              <p className={`text-xs ${noteTone === "danger" ? "text-danger" : noteTone === "ok" ? "text-ok" : "opacity-70"}`}>{note}</p>
            )}
          </>
        )}
      </main>
      <footer className="flex shrink-0 flex-col border-t border-[color-mix(in_srgb,CanvasText_12%,Canvas)] px-3 py-2">
        {unlocked && (
          <div className="flex flex-col items-start pb-1">
            <button type="button" className="py-1 text-xs text-accent" onClick={() => onOpenApp("search")}>
              Open in Passwords app
            </button>
            {caps?.newPasswordSheet && (
              <button type="button" className="py-1 text-xs text-accent" onClick={() => onOpenApp("new")}>
                New login in Passwords app…
              </button>
            )}
          </div>
        )}
        <div className="flex items-center justify-between">
          {unlocked ? (
            <button type="button" className="text-xs text-accent" onClick={onLock}>
              Lock
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="text-xs text-accent" onClick={onSettings}>
            Settings
          </button>
        </div>
      </footer>
    </div>
  );
}
