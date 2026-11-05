/** @param {any} msg any extension message; the reply is whatever the background sends */
export function send(msg) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "no extension" });
      return;
    }
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}
