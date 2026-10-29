// the real options page of a mock build: tabs, help lines, saving, and the helper notices with no native hosts
import { OPTION_TABS } from "../../src/ui/options-model.js";
import { build, launchExtension, main, ok } from "./lib.mjs";

const AUTOFILL_ROWS = [
  "Inline menu",
  "Sites without the inline menu",
  "Autofill on page load",
  "Fill and save on HTTP pages",
  "Ask to save new logins",
  "Ask to update changed passwords",
  "Never-save sites",
  "Copy codes after filling",
  "Clear clipboard after",
];
const HELPER_NOTICE = "Greyed-out settings need the PassBridge helper.";

function hasHoverRule(el) {
  const matches = (rule) => {
    const isOwnMatch = !!rule.selectorText?.includes(":hover") && rule.selectorText.split(/(?<!\\),/).some((sel) => {
      try {
        return el.matches(sel.replace(/(?<!\\):hover/g, ""));
      } catch {
        return false;
      }
    });
    return isOwnMatch || [...(rule.cssRules || [])].some(matches);
  };
  return [...document.styleSheets].some((sheet) => [...sheet.cssRules].some(matches));
}

function contrastWithBackground(el) {
  const rgb = (c) => {
    const n = c.match(/[\d.]+/g).map(Number);
    return c.startsWith("color(") ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3);
  };
  const lum = (c) => {
    const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  let parent = el.parentElement;
  let bg = getComputedStyle(parent).backgroundColor;
  while (parent && /^rgba\(0, 0, 0, 0\)$|transparent/.test(bg)) {
    parent = parent.parentElement;
    bg = parent ? getComputedStyle(parent).backgroundColor : "rgb(255, 255, 255)";
  }
  const [hi, lo] = [lum(getComputedStyle(el).backgroundColor), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
  const optionsUrl = new URL("options.html", sw.url()).href;
  await sw.evaluate(() => chrome.storage.sync.set({ agentSignIn: true }));

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 700 });
  const row = (label) => page.locator(`[data-row="${label}"]`);
  const showsHeading = (p, text) => p.locator("main h1", { hasText: text }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.goto(optionsUrl);
  await page.locator("main h1").waitFor();

  const tabs = (await page.locator("nav a").allInnerTexts()).map((t) => t.trim());
  ok("options: sidebar lists the five tabs in order", tabs.join() === "Autofill,Appearance,Browser,Agents,Updates", tabs.join());
  ok("options: no hash opens Autofill as the current tab", (await showsHeading(page, "Autofill")) && (await page.locator('nav a[aria-current="page"]').innerText()).trim() === "Autofill");
  const rows = await page.locator("[data-row]").evaluateAll((els) => els.map((e) => e.dataset.row));
  ok("options: autofill rows in spec order", rows.join("|") === AUTOFILL_ROWS.join("|"), rows.join("|"));
  const helps = await page.locator("[data-row] [data-help]").allInnerTexts();
  ok("options: every autofill row has a help line", helps.length === AUTOFILL_ROWS.length && helps.every((t) => t.trim()), `helps=${helps.length}`);

  const box = await page.evaluate(() => {
    const left = document.querySelector("aside").getBoundingClientRect().left;
    const right = document.querySelector("main").getBoundingClientRect().right;
    return { left, right: document.documentElement.clientWidth - right, width: right - left };
  });
  ok("options: the page is a centered card, not full width", Math.abs(box.left - box.right) <= 2 && box.width <= 960, JSON.stringify(box));
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const navTop = await page.locator("nav").evaluate((n) => n.getBoundingClientRect().top);
  ok("options: the tabs stay in view at the bottom of a long tab", navTop >= 0 && navTop < 200, `nav top ${navTop}`);
  await page.evaluate(() => scrollTo(0, 0));

  const offSwitch = row("Autofill on page load").locator('[role="switch"]');
  const contrast = await offSwitch.evaluate(contrastWithBackground);
  ok("options: an off switch stands out from its row (3:1)", contrast >= 3, contrast.toFixed(2));
  ok("options: switches animate once the page has settled", (await row("Autofill on page load").locator('[role="switch"] + span').evaluate((k) => getComputedStyle(k).transitionDuration)) !== "0s");
  ok("options: a switch has a hover style", await offSwitch.evaluate(hasHoverRule));
  if (await page.evaluate(() => matchMedia("(hover: hover)").matches)) {
    const idle = await offSwitch.evaluate((s) => getComputedStyle(s).backgroundColor);
    await offSwitch.hover();
    await page.waitForTimeout(250);
    const hovered = await offSwitch.evaluate((s) => getComputedStyle(s).backgroundColor);
    ok("options: a switch reacts to hover", idle !== hovered, `${idle} -> ${hovered}`);
    await page.mouse.move(0, 0);
  }

  await row("Never-save sites").locator("textarea").fill("Bank.example");
  await page.locator("nav a", { hasText: "Appearance" }).click();
  ok("options: a tab link moves the hash", (await showsHeading(page, "Appearance")) && new URL(page.url()).hash === "#appearance", page.url());
  await row("Fill animation").locator('[role="switch"]').click();
  await page.waitForTimeout(900);
  const saved = await sw.evaluate(() => chrome.storage.sync.get(["showAnimations", "excludedDomains"]));
  ok("options: a switch saves to sync", saved.showAnimations === false, JSON.stringify(saved));
  ok("options: a list saves its cleaned domains to sync", (saved.excludedDomains || []).join() === "bank.example", JSON.stringify(saved));
  await page.goBack();
  ok("options: back returns to the previous tab", await showsHeading(page, "Autofill"));
  ok("options: typed list text survives a tab switch", (await row("Never-save sites").locator("textarea").inputValue()).includes("bank.example"));

  await page.goto(`${optionsUrl}#browser`);
  const note = page.locator('[role="note"]');
  await note.waitFor();
  ok("options: no policy host shows one notice with the setup link", (await note.count()) === 1 && (await note.innerText()).includes(HELPER_NOTICE) && (await note.locator('a[href*="/SETUP.md#"]').count()) === 1);
  ok("options: no policy host greys the password manager", await row("Hide the browser's password manager").locator('[role="switch"]').isDisabled());
  const browserRows = await page.locator("[data-row]").evaluateAll((els) => els.map((e) => e.dataset.row));
  const savePromptAt = browserRows.indexOf("Hide the browser's save-password prompt");
  ok("options: the save-password prompt sits above the password manager", savePromptAt !== -1 && savePromptAt < browserRows.indexOf("Hide the browser's password manager"), browserRows.join("|"));
  ok("options: a locked row shows the not-allowed cursor", (await row("Hide the browser's password manager").evaluate((e) => getComputedStyle(e).cursor)) === "not-allowed");
  ok("options: the shortcuts button names what it changes", (await page.getByRole("button", { name: /Keyboard shortcuts/ }).count()) === 1);

  await page.goto(`${optionsUrl}#agents`);
  await note.waitFor();
  const agentSwitch = row("Allow agent sign-in").locator('[role="switch"]');
  ok("options: a locked agent switch keeps its synced value", (await agentSwitch.isChecked()) && (await agentSwitch.isDisabled()));
  ok("options: an empty activity log says so", (await row("Activity").innerText()).includes("No requests yet."));

  const longHost = "very-long-subdomain.internal-dashboard.example-company.co.uk";
  await sw.evaluate((host) => {
    const users = ["ada@example.com", "grace.hopper.with.a.long.address@example-enterprise.com", ""];
    const results = ["ok", "not_allowed", "rate_limited", "choose_login"];
    const agentLog = Array.from({ length: 60 }, (_, i) => ({ t: Date.UTC(2026, 9, 28, 9, i), op: i % 3 ? "sign_in" : "logins", host: i % 2 ? host : "github.com", username: users[i % 3], result: results[i % 4] }));
    return chrome.storage.local.set({ agentLog });
  }, longHost);
  await page.locator('[data-row="Activity"] table').waitFor();
  const activity = await row("Activity").evaluate((el, host) => {
    const box = el.querySelector("table").parentElement;
    const resultHead = [...el.querySelectorAll("th")].pop();
    const rows = [...el.querySelectorAll("tbody tr")];
    return {
      rows: rows.length,
      boxHeight: box.clientHeight,
      isBoxScrolling: box.scrollHeight > box.clientHeight,
      isHeadSticky: getComputedStyle(resultHead).position === "sticky" || getComputedStyle(resultHead.parentElement.parentElement).position === "sticky",
      isResultInView: resultHead.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1,
      tallestRow: Math.max(...rows.map((r) => r.getBoundingClientRect().height)),
      firstTime: rows[0].cells[0].textContent,
      hasHostTitle: [...el.querySelectorAll("td")].some((td) => td.title === host),
      cutHeads: [...el.querySelectorAll("th")].filter((th) => th.scrollWidth > th.clientWidth).map((th) => th.textContent),
    };
  }, longHost);
  ok("options: no activity column title is cut off", activity.cutHeads.length === 0, activity.cutHeads.join());
  ok("options: the activity log keeps the last 50", activity.rows === 50, `rows=${activity.rows}`);
  ok("options: a long activity log scrolls in its own box", activity.isBoxScrolling && activity.boxHeight <= 400, JSON.stringify(activity));
  ok("options: the activity header stays on top while it scrolls", activity.isHeadSticky);
  ok("options: the result column stays in view", activity.isResultInView);
  ok("options: every activity row stays on one line", activity.tallestRow <= 34, `tallest=${activity.tallestRow}`);
  ok("options: activity times are short", !activity.firstTime.includes("2026") && activity.firstTime.length <= 18, activity.firstTime);
  ok("options: a cut-off site shows in full on hover", activity.hasHostTitle);
  await sw.evaluate(() => chrome.storage.local.remove("agentLog"));

  await page.goto(`${optionsUrl}#updates`);
  await note.waitFor();
  const autoSwitch = row("Install updates automatically with the helper").locator('[role="switch"]');
  ok("options: no updater locks auto-install with its synced value", (await autoSwitch.isChecked()) && (await autoSwitch.isDisabled()));
  ok("options: no updater keeps Check now usable", await page.locator("button", { hasText: "Check now" }).isEnabled());
  const [updatePage] = await Promise.all([ctx.waitForEvent("page"), page.locator("button", { hasText: "Check now" }).click()]);
  await updatePage.waitForLoadState("domcontentloaded");
  ok("options: Check now opens the update page in a new tab", new URL(updatePage.url()).pathname === "/src/update.html" && page.url().includes("#updates"), updatePage.url());
  await updatePage.close();

  const fresh = await ctx.newPage();
  await fresh.goto(`${optionsUrl}#updates`);
  ok("options: a fresh page opens the tab in its hash", await showsHeading(fresh, "Updates"));
  await fresh.close();

  const pending = await ctx.newPage();
  await pending.addInitScript(() => {
    const send = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    chrome.runtime.sendNativeMessage = (host, msg, cb) => (host === "com.passbridge.policy" ? undefined : send(host, msg, cb));
  });
  await pending.goto(optionsUrl);
  await pending.locator("main h1").waitFor();
  const pendingKnob = pending.locator('[data-row="Autofill on page load"] [role="switch"] + span');
  ok("options: switches do not slide while the page is still loading", (await pendingKnob.evaluate((k) => getComputedStyle(k).transitionDuration)) === "0s");
  await pending.close();

  await page.setViewportSize({ width: 480, height: 800 });
  for (const { id } of OPTION_TABS) {
    await page.goto(`${optionsUrl}#${id}`);
    await page.locator("main h1").waitFor();
    const narrow = await page.evaluate(() => ({
      isFlat: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      navDir: getComputedStyle(document.querySelector("nav ul")).flexDirection,
    }));
    ok(`options: narrow ${id} keeps the tabs on top with no sideways scroll`, narrow.isFlat && narrow.navDir === "row", JSON.stringify(narrow));
  }

  const helped = await ctx.newPage();
  await helped.addInitScript(() => {
    const send = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    chrome.runtime.sendNativeMessage = (host, msg, cb) => {
      if (host !== "com.passbridge.policy") return send(host, msg, cb);
      setTimeout(() => cb(msg.action === "get" ? { ok: true, hidden: false } : { ok: true, hidden: false, needsApproval: true }), 0);
    };
  });
  const helpedRow = (label) => helped.locator(`[data-row="${label}"]`);
  const allowedSites = () => helpedRow("Allowed sites").locator("textarea");
  const savedAllowlist = () => sw.evaluate(() => chrome.storage.sync.get("agentAllowlist").then((o) => (o.agentAllowlist || []).join()));

  await helped.goto(`${optionsUrl}#browser`);
  const policyRow = helpedRow("Hide the browser's password manager");
  await policyRow.locator('[role="switch"]:not([disabled])').waitFor();
  ok("options: the password-manager row is not one big click target", (await policyRow.evaluate((e) => e.tagName)) !== "LABEL");
  await policyRow.locator('[role="switch"]').click();
  await helped.waitForTimeout(300);
  ok("options: a toggle with no helper note still shows the restart line", (await policyRow.innerText()).includes("Fully quit and reopen the browser to apply this."), await policyRow.innerText());

  await helped.goto(`${optionsUrl}#agents`);
  await allowedSites().fill("github.com\nexample.org");
  await helped.evaluate(() => (location.hash = "updates"));
  await helped.waitForTimeout(900);
  ok("options: allowed sites save when the tab changes without a blur", (await savedAllowlist()).includes("example.org"), await savedAllowlist());

  await helped.evaluate(() => (location.hash = "agents"));
  await allowedSites().fill("github.com\nexample.net");
  await helped.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  ok("options: allowed sites save when the page closes without a blur", (await savedAllowlist()).includes("example.net"), await savedAllowlist());
});
