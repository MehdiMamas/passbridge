import { t } from "../i18n/runtime.js";

const muted = "text-[color-mix(in_srgb,CanvasText_60%,Canvas)]";

const border = "border-[color-mix(in_srgb,CanvasText_12%,Canvas)]";
const primary = "cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50";
const link = "cursor-pointer text-accent";

const STEPS = [
  ["download", "stepDownload"],
  ["verify", "stepVerify"],
  ["write", "stepWrite"],
  ["restart", "stepRestart"],
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
          <span className={i === at ? "font-semibold" : ""}>{t(label)}</span>

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

export function UpdateScreen({ phase, installed, expected, release, folderName, step, progress, error, onUpdate, onChangeFolder, onRetry, onRestore, helperUrl, native, onNoHelper }) {
  const working = phase === "working";
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-8 text-[13px]">
      <header className="flex items-center gap-2">
        <img src="../icons/icon48.png" alt="" width="28" height="28" />
        <h1 className="text-lg font-semibold">{t("updTitle")}</h1>

      </header>

      <section className={`grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 rounded-xl border ${border} p-4`}>
        <span className={muted}>{t("installed")}</span>
        <span data-passbridge="installed" className="font-mono">{installed}</span>
        {release?.version && (
          <>
            <span className={muted}>{t("newVersion")}</span>
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span data-passbridge="latest" className="font-mono font-semibold">{release.version}</span>
              <a className={link} href={release.pageUrl} target="_blank" rel="noopener">
                {t("whatsNew")}
              </a>
            </span>
          </>
        )}
        {!native && (phase === "ready" || working || phase === "failed") && (
          <>
            <span className={muted}>{t("folder")}</span>
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span data-passbridge="folder">{folderName || t("folderNone")}</span>
              {folderName && !working && (
                <button type="button" className={link} onClick={onChangeFolder}>
                  {t("changeFolder")}
                </button>
              )}
            </span>
          </>
        )}

      </section>

      <section data-passbridge="update-body" data-phase={phase} className="flex flex-col gap-3">
        {phase === "checking" && <p className={muted}>{t("checkingGithub")}</p>}
        {phase === "current" && <p>{t("upToDateMsg")}</p>}
        {phase === "done" && <p className="font-semibold text-ok">{t("updatedMsg", [installed])}</p>}
        {phase === "stale" && (
          <>
            <p data-passbridge="update-error" className="text-danger">
              {t("staleMsg", [installed, expected])}
            </p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              {t("tryAgain")}
            </button>
          </>
        )}
        {phase === "network" && (
          <>
            <p>{t("networkMsg")}</p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              {t("tryAgain")}
            </button>
          </>
        )}
        {(phase === "unsigned" || phase === "unsupported") && (
          <>
            <p>
              {phase === "unsigned" ? t("unsignedMsg") : t("unsupportedMsg")}
            </p>
            <a className={`${primary} self-start`} href={release?.pageUrl} target="_blank" rel="noopener">
              {t("downloadRelease")}
            </a>
          </>
        )}

        {phase === "helper" && (
          <>
            <p className="font-semibold">{t("helperMsg")}</p>
            <a className={`${primary} self-start`} href={helperUrl} target="_blank" rel="noopener">
              {t("downloadHelper")}
            </a>
            <ol className="ml-5 flex list-decimal flex-col gap-1">
              <li>{t("helperStep1")}</li>
              <li>
                {t("helperStep2Run")} <code className="font-mono">powershell -ExecutionPolicy Bypass -File .\install.ps1</code>
              </li>
              <li>{t("helperStep3")}</li>
              <li>{t("helperStep4")}</li>
            </ol>
            <button type="button" className={`${link} self-start`} onClick={onRetry}>
              {t("checkAgain")}
            </button>
            <p className={muted}>{t("ratherNot")}</p>
            <button type="button" className={`${link} self-start`} onClick={onNoHelper}>
              {t("withoutHelper")}
            </button>
            <p className={muted}>{t("withoutHelperNote")}</p>
          </>
        )}

        {phase === "ready" && (
          <>
            <button type="button" className={`${primary} self-start`} onClick={onUpdate}>
              {t("updateNow")}
            </button>
            <p className={muted}>
              {native ? (
                <>{t("readyNative")}</>
              ) : folderName ? (
                <>
                  {t("readyFolderBefore")} <strong>{t("allowEveryVisit")}</strong> {t("readyFolderAfter")}
                </>
              ) : (
                <>
                  {t("readyPickBefore")} <strong>{t("allowEveryVisit")}</strong> {t("readyPickAfter")}
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
              <strong>{t("keepOpen")}</strong> {t("keepOpenRest")}
            </p>
          </>
        )}
        {phase === "failed" && (
          <>
            <p data-passbridge="update-error" className="text-danger">
              {error?.message}
            </p>
            <p className={muted}>{error?.restored ? t("restored") : t("nothingChanged")}</p>
            <button type="button" className={`${primary} self-start`} onClick={onRetry}>
              {t("tryAgain")}
            </button>
          </>
        )}
        {phase === "interrupted" && (
          <>
            <p>{t("interrupted")}</p>
            <button type="button" className={`${primary} self-start`} onClick={onRestore}>
              {t("restorePrev")}
            </button>
          </>
        )}

      </section>
    </main>
  );
}
