import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { reportFileName, reportIssueUrl, reportText } from "../report-scrub.js";
import { applyDocumentLanguage, t } from "../i18n/runtime.js";
import { followTheme } from "./page-theme.js";


const muted = "text-[color-mix(in_srgb,CanvasText_60%,Canvas)]";
const border = "border-[color-mix(in_srgb,CanvasText_12%,Canvas)]";

function ReportApp() {
  const id = new URLSearchParams(location.search).get("id") || "";
  const [report, setReport] = useState(undefined);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    chrome.storage.session.get(`report:${id}`).then((r) => setReport(r[`report:${id}`] || null), () => setReport(null));
  }, [id]);

  const text = useMemo(() => (report ? reportText(report) : ""), [report]);

  if (report === undefined) return null;
  if (report === null) {
    return <p className="p-6 text-sm">{t("reportExpired")}</p>;
  }


  function send() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = reportFileName(report);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    window.open(reportIssueUrl(report, note), "_blank", "noopener");
    setSent(true);
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6 text-[13px]">
      <h1 className="text-lg font-semibold">{t("reportTitle")}</h1>

      <p>
        <span className="font-medium">{report.url}</span>
        <br />
        <span className={muted}>
          PassBridge {report.version} · {report.frames.length} frame{report.frames.length === 1 ? "" : "s"} captured
        </span>
      </p>
      {!report.frames.length && (
        <p className="text-danger">No frame answered. Reload the page and try again.</p>
      )}
      <ul className={`flex flex-col gap-1 border-y ${border} py-2`}>
        {report.frames.map((f, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            <span className="font-medium">{f.top ? t("framePage") : t("frameIframe")}</span> {f.url}
            <span className={`block ${muted}`}>
              {f.error
                ? t("frameError", [f.error])
                : f.blocked
                ? t("frameBlocked")
                : f.safe
                ? t("frameSafe")
                : t("frameUntrusted")}
              {" · "}
              {t(
                "fieldsSummary",
                [
                  (f.fields || []).filter((x) => x.visible && x.login).length === 1
                    ? t("loginFieldOne", [1])
                    : t("loginFieldMany", [(f.fields || []).filter((x) => x.visible && x.login).length]),
                  (f.fields || []).filter((x) => x.visible && x.otp).length === 1
                    ? t("codeFieldOne", [1])
                    : t("codeFieldMany", [(f.fields || []).filter((x) => x.visible && x.otp).length]),
                ],
              )}
            </span>
          </li>
        ))}
      </ul>

      <label className="flex flex-col gap-1">
        {t("whatWentWrong")}
        <textarea

          className={`min-h-20 rounded border ${border} bg-transparent p-2`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("reportExample")}

        />
      </label>
      <p className={muted}>{t("scrubNote")}</p>

      <div className="flex items-center gap-3">
        <button type="button" className="rounded bg-accent px-3 py-1.5 font-medium text-white" onClick={send}>
          {t("saveAndOpen")}
        </button>
        {sent && <span className="text-ok">{t("savedFile", [reportFileName(report)])}</span>}

      </div>
      <details>
        <summary className="cursor-pointer">{t("fileContents", [Math.round(text.length / 1024)])}</summary>

        <pre className={`mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap border ${border} p-2 text-[11px]`}>
          {text.slice(0, 200_000)}
        </pre>
      </details>
    </main>
  );
}

followTheme();
void applyDocumentLanguage(document, "reportTitle");
createRoot(document.getElementById("root")).render(<ReportApp />);

