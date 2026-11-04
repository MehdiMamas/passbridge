import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { send } from "./chrome.js";
import { applyDocumentLanguage, resolveLocale, t } from "../i18n/runtime.js";
import { useLocale } from "../i18n/use.jsx";

async function helperReady(tries = 3) {
  for (let i = 0; i < tries; i++) {
    if ((await send({ type: "updaterAvailable" }))?.ok) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
import { PopupScreen } from "./popup-screen.jsx";
import { UPDATE_PAGE } from "../update/check.js";
import { followTheme } from "./page-theme.js";

function PopupApp() {
  const locale = useLocale();
  const [state, setState] = useState("connecting");
  const [os, setOs] = useState("mac");
  const [label, setLabel] = useState(null);
  const [site, setSite] = useState("");
  const [logins, setLogins] = useState([]);
  const [codes, setCodes] = useState([]);
  const [caps, setCaps] = useState({});
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("");
  const [pinError, setPinError] = useState("");
  const [showFavicons, setShowFavicons] = useState(true);
  const [lookupUrl, setLookupUrl] = useState(null);
  const [update, setUpdate] = useState(null);
  const [canInstallUpdate, setCanInstallUpdate] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [canCheckUpdate, setCanCheckUpdate] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const lookupGen = useRef(0);
  const lookupTimer = useRef(0);

  function showNote(text, tone) {
    setNote(text || "");
    setNoteTone(tone || "");
  }

  async function loadUnlocked() {
    const gen = ++lookupGen.current;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (gen !== lookupGen.current) return;
    setLookupUrl(null);
    const host = active?.url ? new URL(active.url).hostname : "";
    setSite(host);
    const res = await send({ type: "getLogins", tabId: active?.id, url: active?.url });
    if (gen !== lookupGen.current) return;
    setLogins(res?.ok ? res.logins || [] : []);
    const codeRes = await send({ type: "getOneTimeCodes" });
    if (gen !== lookupGen.current) return;
    setCodes(codeRes?.rows || []);
    return codeRes?.rows?.length || 0;
  }

  async function runLookup(raw) {
    if (!raw) {
      await loadUnlocked();
      return;
    }
    const gen = ++lookupGen.current;
    const res = await send({ type: "lookupLogins", url: raw });
    if (gen !== lookupGen.current) return;
    if (!res?.ok) {
      showNote(res?.error || t("couldntLookup"), "danger");
      return;
    }
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setLookupUrl(url);
    setSite(res.host || raw);
    setLogins(res.logins || []);
    const codeRes = await send({ type: "getOneTimeCodes", url });
    if (gen !== lookupGen.current) return;
    setCodes(codeRes?.rows || []);
  }

  async function applyState(next, nextCaps) {
    setState(next);
    if (nextCaps) setCaps(nextCaps);
    if (next === "unlocked") await loadUnlocked();
  }

  async function bootFrom(res) {
    if (!res) return;
    if (res.os) setOs(res.os);
    if (res.label) setLabel(res.label);
    setShowFavicons(res.settings?.showFavicons !== false);
    setCanCheckUpdate(res.settings?.canCheckForUpdates !== false);
    setUpdate(res.update || null);
    if (res.helperNote) showNote(t("noteOldHelper"), "");
    setCanInstallUpdate(!!res.canInstallUpdate);
    setCaps(res.caps || {});
    let next = res.state || "connecting";
    if (next === "disconnected") next = "connecting";
    if (next === "needs_pin") {
      const ch = await send({ type: "requestChallenge", ifNeeded: true });
      next = ch?.state || next;
    }
    await applyState(next, res.caps);
  }

  useEffect(() => {
    let dead = false;
    (async () => {
      const res = await send({ type: "getState" });
      if (dead || !res) return;
      await bootFrom(res);
    })();
    const onMsg = (msg) => {
      if (msg?.type !== "state" || dead) return;
      if (msg.state === "disconnected") {
        setState("connecting");
        send({ type: "getState" }).then((res) => {
          if (!dead) bootFrom(res);
        });
        return;
      }
      applyState(msg.state);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      dead = true;
      window.clearTimeout(lookupTimer.current);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);

  const labelText = label || t(os === "win" ? "deviceWin" : "deviceMac");

  return (
    <PopupScreen
      state={state}
      os={os}
      label={labelText}
      site={site}
      logins={logins}
      codes={codes}
      caps={caps}
      note={note}
      noteTone={noteTone}
      pinError={pinError}
      showFavicons={showFavicons}
      update={update}
      installingUpdate={installing}
      onVerify={async (pin) => {
        if (pin.length < 4) return false;
        setPinError("");
        const res = await send({ type: "verifyPin", pin });
        if (res?.ok) {
          await applyState(res.state);
          return true;
        }
        setPinError(res?.newCode ? `${res.error || t("verificationFailed")} — ${t("enterNewCode", [labelText])}` : res?.error || t("verificationFailed"));
        return false;
      }}
      onNewCode={async () => {
        setPinError("");
        const res = await send({ type: "requestChallenge" });
        if (!res?.ok) setPinError(res?.error || t("couldntRequestCode"));
        else await applyState(res.state);
      }}
      onFill={async (login) => {
        const res = await send({ type: "fillOnPage", url: lookupUrl || undefined, loginName: login });
        if (res?.ok && res.filled) window.close();
        else showNote(res?.error || t("couldntFillForm"), "danger");
      }}
      onFillCode={async (row) => {
        const res = await send({ type: "fillOneTimeCode", id: row.id });
        if (res?.ok && res.filled) window.close();
        else if (!(res?.ok && res.code)) showNote(res?.error ? t("couldntReadCodeDetail", [res.error]) : t("couldntReadCode"), "danger");
        return res;
      }}
      onCopy={async (field, login) => {
        const res = await send({
          type: "copyField",
          field,
          username: login.username,
          id: login.id,
          url: field === "password" ? lookupUrl || undefined : undefined,
        });
        if (!res?.ok) showNote(res?.error || t("nothingToCopy"), "danger");
        else showNote(t("copied"), "ok");
      }}
      onLookup={(raw) => {
        window.clearTimeout(lookupTimer.current);
        lookupTimer.current = window.setTimeout(() => {
          void runLookup(raw);
        }, 300);
      }}
      onOpenApp={async (mode, query) => {
        const res = await send({ type: "openPasswordsApp", mode, url: mode === "search" ? lookupUrl || undefined : undefined, query });
        if (res?.copied) showNote(t("usernameCopied"), "ok");
        else window.close();
      }}
      onAddLogin={async (login) => {
        const res = await send({ type: "popupAddLogin", ...login });
        if (res?.ok && res.saved) {
          showNote(t("loginSaved"), "ok");
          void (lookupUrl ? runLookup(lookupUrl) : loadUnlocked());
        }
        return res;
      }}
      onTotpScan={() => send({ type: "totpScanTab" })}
      onTotpPaste={(text) => send({ type: "totpPaste", text })}
      onTotpAdd={(username) => send({ type: "totpAdd", username })}
      onTotpCopyKey={() => send({ type: "totpCopyKey" })}
      onCheckCodes={async () => {
        const res = await send({ type: "getOneTimeCodes", listOnly: true });
        if (res?.ok) setCodes(res.rows || []);
        return res?.rows || [];
      }}
      onLock={async () => {
        await send({ type: "disconnect" });
        setState("connecting");
        const res = await send({ type: "getState" });
        await bootFrom(res);
      }}
      onRefresh={async () => {
        if (state === "needs_pin") {
          const res = await send({ type: "requestChallenge" });
          if (res?.ok) await applyState(res.state);
          else setPinError(res?.error || t("couldntRequestCode"));
          return;
        }
        const res = await send({ type: "refreshAndRefill" });
        const count = await loadUnlocked();
        if (res?.refilled) showNote(t("refilled", [res.username]), "ok");
        else if (res?.reason === "none") {
          showNote(count ? t("codesForSite", [String(count)]) : t("nothingToRefill"), "muted");
        }
        else showNote(res?.error || t("couldntRefill"), "danger");
      }}
      onSettings={() => chrome.runtime.openOptionsPage()}
      onReport={async () => {
        showNote(t("collectingPage"), "muted");
        const res = await send({ type: "reportPage" });
        if (res?.ok) window.close();
        else showNote(res?.error || t("couldntReadPage"), "danger");
      }}
      onOpenUpdate={async () => {
        await chrome.tabs.create({ url: update.url });
        window.close();
      }}
      onInstallUpdate={async () => {
        // the helper can be slow when the popup opens: ask again before falling back to the update page,
        // which on Windows only offers the helper and elsewhere swaps the files through a folder the user picks
        if (!canInstallUpdate && !(await helperReady())) {
          await chrome.tabs.create({ url: chrome.runtime.getURL(UPDATE_PAGE) });
          window.close();
          return;
        }
        setInstalling(true);
        const res = await send({ type: "installUpdate" });
        if (!res?.ok) {
          setInstalling(false);
          showNote(res?.error || t("couldntInstallUpdate"), "danger");
        }
      }}
      onDismissUpdate={() => {
        setUpdate(null);
        send({ type: "dismissUpdate" });
      }}
      checkingUpdate={checkingUpdate}
      onCheckUpdate={
        canCheckUpdate
          ? async () => {
              setCheckingUpdate(true);
              const r = await send({ type: "checkUpdateNow" });
              setCheckingUpdate(false);
              if (!r?.ok || !r.reached) showNote(t("couldntReachGithub"), "danger");
              else if (r.available) {
                setUpdate(r.available);
                showNote("", "");
              } else showNote(t("upToDate", [r.current]), "ok");
            }
          : undefined
      }
    />
  );
}

followTheme();
void applyDocumentLanguage(document, "extensionName");
createRoot(document.getElementById("root")).render(<PopupApp />);
