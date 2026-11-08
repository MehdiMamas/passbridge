import { BASE, build, launchExtension, main, ok } from "./lib.ts";

// the save bar: title text is not selectable, the show/hide toggle stays on one line (also in Chinese),
// and dragging the bar's surface moves it without closing it (#234)
await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const sw = ctx.serviceWorkers()[0];
  type Page = import("playwright-core").Page;
  type Frame = import("playwright-core").Frame;
  const barOf = async (page: Page) => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((fr: Frame) => fr.url().includes("overlay/save-bar.html"));
      if (f && (await f.locator("[data-field=password]").count())) return f;
      await page.waitForTimeout(150);
    }
    return null;
  };
  const open = async (page: Page, who: string) => {
    await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("input[name=username]", `${who}@example.org`);
    await page.fill("input[name=password]", `${who}-pw-1234`);
    await page.click("button[type=submit]");
    const bar = await barOf(page);
    if (bar) await bar.locator("[data-action=save]:not([disabled])").waitFor();
    return bar;
  };
  const hostRect = (page: Page) =>
    page.evaluate(() => {
      const r = document.querySelector("[data-passbridge-save]")!.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });

  // small steps with a pause: the bar follows the pointer through a message, and a synthetic pointer
  // is routed by position (a real one is captured), so it must not outrun the bar
  const dragBy = async (page: Page, bar: Frame, dx: number, dy: number) => {
    const b = (await bar.locator("p").boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 8);
    for (let i = 1; i <= n; i++) {
      await page.mouse.move(x + (dx * i) / n, y + (dy * i) / n);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
  };

  for (const lang of ["en", "zh_CN"]) {
    await sw.evaluate((l: string) => (globalThis as any).chrome.storage.sync.set({ uiLanguage: l === "en" ? "" : l }), lang);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const bar = (await open(page, lang === "en" ? "alice" : "carol")) as Frame;
    ok(`[${lang}] save bar appears`, !!bar);
    if (!bar) continue;

    const sel = await bar.locator("p").evaluate((el: Element) => getComputedStyle(el).userSelect);
    ok(`[${lang}] title text is not selectable`, sel === "none", sel);
    const inSel = await bar.locator("[data-field=username]").evaluate((el: Element) => getComputedStyle(el).userSelect);
    ok(`[${lang}] inputs stay selectable`, inSel !== "none", inSel);

    const pw = await bar.locator("[data-field=password]").boundingBox();
    const tg = await bar.locator("[data-action=toggle]").boundingBox();
    ok(`[${lang}] toggle sits on the password input's line`, !!pw && !!tg && Math.abs(pw.y - tg.y) < pw.height, JSON.stringify({ pw, tg }));
    ok(`[${lang}] toggle does not wrap`, !!tg && tg.height < 30, JSON.stringify(tg));
    await bar.locator("[data-action=toggle]").click();
    const tg2 = await bar.locator("[data-action=toggle]").boundingBox();
    ok(`[${lang}] toggle stays on one line after Show`, !!pw && !!tg2 && Math.abs(pw.y - tg2.y) < pw.height && tg2.height < 30, JSON.stringify(tg2));

    const before = await hostRect(page);
    await dragBy(page, bar, -200, 100);
    const after = await hostRect(page);
    ok(`[${lang}] drag moves the bar by the same amount`, Math.abs(after.left - before.left + 200) <= 1 && Math.abs(after.top - before.top - 100) <= 1, JSON.stringify({ before, after }));
    ok(`[${lang}] bar stays open after a drag`, (await page.locator("[data-passbridge-save]").count()) === 1);

    // far outside: stays inside the viewport
    await dragBy(page, bar, -700, -300);
    const clamped = await hostRect(page);
    ok(`[${lang}] bar is kept inside the viewport`, clamped.left >= 0 && clamped.top >= 0, JSON.stringify(clamped));

    // typing in a field does not start a drag; Not now still closes
    const t3 = await hostRect(page);
    await bar.locator("[data-field=site]").click({ force: true });
    await page.waitForTimeout(200);
    const t4 = await hostRect(page);
    ok(`[${lang}] a click in a field does not move the bar`, t3.left === t4.left && t3.top === t4.top, JSON.stringify({ t3, t4 }));
    await bar.locator("button", { hasNot: bar.locator("[data-action]") }).last().click();
    await page.waitForTimeout(400);
    ok(`[${lang}] Not now closes the bar`, (await page.locator("[data-passbridge-save]").count()) === 0);
    await page.close();
  }
});
