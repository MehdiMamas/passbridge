// the MAIN-world guard cant read chrome.storage, so relay hidePasskeys via a window event
(() => {
  const push = (on) =>
    dispatchEvent(new Event(on ? "passbridge:hide-passkeys-on" : "passbridge:hide-passkeys-off"));
  chrome.storage?.sync?.get({ hidePasskeys: false }, (d) => push(!!d.hidePasskeys));
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "sync" && changes.hidePasskeys) push(!!changes.hidePasskeys.newValue);
  });
})();
