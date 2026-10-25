import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { reportFileName, reportIssueUrl, reportText } from "../report-scrub.js";

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
    return <p className="p-6 text-sm">This report has expired. Open the page again and choose Report this page.</p>;
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
      <h1 className="text-lg font-semibold">Report this page</h1>
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
            <span className="font-medium">{f.top ? "Page" : "Iframe"}</span> {f.url}
            <span className={`block ${muted}`}>
              {f.error ? `Error: ${f.error}` : f.blocked ? "Site blocked in settings" : f.safe ? "PassBridge runs here" : "PassBridge stays silent here (frame not trusted)"}
              {" · "}
              {(f.fields || []).filter((x) => x.visible && x.login).length} login field(s),{" "}
              {(f.fields || []).filter((x) => x.visible && x.otp).length} code field(s)
            </span>
          </li>
        ))}
      </ul>
      <label className="flex flex-col gap-1">
        What went wrong?
        <textarea
          className={`min-h-20 rounded border ${border} bg-transparent p-2`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: no PassBridge menu on the password field"
        />
      </label>
      <p className={muted}>
        Removed before saving: typed and hidden field values, script code, link query strings, tokens and email addresses.
        Names or other text shown on the page stay in. The issue and the file you attach are public on GitHub, so look over
        the file below first.
      </p>
      <div className="flex items-center gap-3">
        <button type="button" className="rounded bg-accent px-3 py-1.5 font-medium text-white" onClick={send}>
          Save file and open GitHub issue
        </button>
        {sent && <span className="text-ok">Saved {reportFileName(report)}. Drag it into the GitHub issue, then submit.</span>}
      </div>
      <details>
        <summary className="cursor-pointer">File contents ({Math.round(text.length / 1024)} KB)</summary>
        <pre className={`mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap border ${border} p-2 text-[11px]`}>
          {text.slice(0, 200_000)}
        </pre>
      </details>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<ReportApp />);
