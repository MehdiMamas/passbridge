// apple walks the whole parent chain via webNavigation, so a frame is asked with its tab's url too;
// a site lookup carries its own url only, never the active tab's
export function frameUrlsFor(sender) {
  const urls = [];
  for (const u of [sender.url, sender.tab?.url]) {
    if (u && /^https?:/i.test(u) && !urls.includes(u)) urls.push(u);
  }
  return urls;
}
