const muted = "text-[color-mix(in_srgb,CanvasText_60%,Canvas)]";
const border = "border-[color-mix(in_srgb,CanvasText_12%,Canvas)]";
const primary = "cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50";
const link = "cursor-pointer text-accent";

const STEPS = [
  ["download", "Download"],
  ["verify", "Check the signature"],
  ["write", "Replace the files"],
  ["restart", "Restart PassBridge"],
];

function Steps({ step }) {
  const at = STEPS.findIndex(([id]) => id === step);
  return (
    <ol className="flex flex-col gap-1.5">
      {STEPS.map(([id, label], i) => (
        <li key={id} data-step={id} data-state={i < at ? "done" : i === at ? "active" : "todo"} className={`flex items-center gap-2 ${i > at ? muted : ""}`}>
          <span
            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] text-white ${i < at ? "bg-ok" : i === at ? "bg-accent" : `border ${border}`}`}
            aria-hidden="true"
          >
            {i < at ? "✓" : ""}
          </span>
          <span className={i === at ? "font-semibold" : ""}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function Progress({ value }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,CanvasText_10%,Canvas)]">
      <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function UpdateScreen({ phase, installed, expected, release, folderName, step, progress, error, onUpdate, onChangeFolder, onRetry, onRestore }) {
  const working = phase === "working";
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-8 text-[13px]">
      <header className="flex items-center gap-2">
        <img src="../icons/icon48.png" alt="" width="28" height="28" />
        <h1 className="text-lg font-semibold">Update PassBridge</h1>
      </header>

      <section className={`grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 rounded-xl border ${border} p-4`}>
        <span className={muted}>Installed</span>
        <span data-passbridge="installed" className="font-mono">{installed}</span>
        {release?.version && (
          <>
            <span className={muted}>New version</span>
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span data-passbridge="latest" className="font-mono font-semibold">{release.version}</span>
              <a className={link} href={release.pageUrl} target="_blank" rel="noopener">
                What's new on GitHub ↗
              </a>
            </span>
          </>
        )}
        {(phase === "ready" || working || phase === "failed") && (
          <>
            <span className={muted}>Folder</span>
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span data-passbridge="folder">{folderName || "Not chosen yet"}</span>
              {folderName && !working && (
                <button type="button" className={link} onClick={onChangeFolder}>
                  Change folder
                </button>
              )}
            </span>
          </>
        )}
      </section>

      <section data-passbridge="update-body" data-phase={phase} className="flex flex-col gap-3">
        {phase === "checking" && <p className={muted}>Checking GitHub for a new version…</p>}
        {phase === "current" && <p>PassBridge is up to date.</p>}
        {phase === "done" && <p className="font-semibold text-ok">PassBridge is now {installed}.</p>}
        {phase === "stale" && (
          <>
            <p data-passbridge="update-error" className="text-danger">
              Something went wrong: PassBridge is still {installed}, not {expected}.
            </p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {phase === "network" && (
          <>
            <p>Couldn't reach GitHub.</p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {(phase === "unsigned" || phase === "unsupported") && (
          <>
            <p>
              {phase === "unsigned"
                ? "This release isn't signed, so PassBridge can't install it for you."
                : "This browser can't let PassBridge edit its own folder."}
            </p>
            <a className={`${primary} self-start`} href={release?.pageUrl} target="_blank" rel="noopener">
              Download from the release page
            </a>
          </>
        )}
        {phase === "ready" && (
          <>
            <button type="button" className={`${primary} self-start`} onClick={onUpdate}>
              Update now
            </button>
            <p className={muted}>
              {folderName ? (
                <>
                  If the folder picker opens, press Select and choose <strong>Allow on every visit</strong>. Later updates then take one click.
                </>
              ) : (
                <>
                  You'll choose the PassBridge folder, the one loaded in chrome://extensions, and allow PassBridge to edit it. Choose{" "}
                  <strong>Allow on every visit</strong> when Chrome offers it.
                </>
              )}
            </p>
          </>
        )}
        {working && (
          <>
            <Progress value={progress} />
            <Steps step={step} />
            <p className={muted}>
              <strong>Keep this tab open</strong> until PassBridge restarts.
            </p>
          </>
        )}
        {phase === "failed" && (
          <>
            <p data-passbridge="update-error" className="text-danger">
              {error?.message}
            </p>
            <p className={muted}>{error?.restored ? "Your previous version was restored." : "Nothing was changed."}</p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {phase === "interrupted" && (
          <>
            <p>The last update didn't finish. Restore the previous version, then update again.</p>
            <button type="button" className={`${primary} self-start`} onClick={onRestore}>
              Restore previous version
            </button>
          </>
        )}
      </section>
    </main>
  );
}
