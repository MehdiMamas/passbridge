import { BASE, build, launchExtension, main, menuText, menuShown, ok } from "./lib.ts";

// click the field icon with a real mouse; the icon sits in a closed shadow, so use its host box
async function clickIcon(page: import("playwright-core").Page) {
  const box = await page.locator("[data-passbridge-icon]").first().boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  return true;
}

async function open(kind: string) {
  const ctx = await launchExtension(build(kind));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-email-password.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  return { ctx, page };
}

await main(async () => {
  // no saved login: focusing stays quiet, an icon click says why
  {
    const { ctx, page } = await open("empty");
    for (const sel of ["#email", "#password"]) {
      await page.focus(sel);
      await page.waitForTimeout(500);
      ok(`empty ${sel}: focus alone shows nothing`, !(await menuShown(page)));
      ok(`empty ${sel}: icon is up`, (await page.locator("[data-passbridge-icon]").count()) > 0);
      ok(`empty ${sel}: icon click found the icon`, await clickIcon(page));
      const text = await menuText(page);
      ok(`empty ${sel}: icon click shows the no-login row`, /No saved logins? for this site/.test(text), text);
    }
    await ctx.close();
  }

  // helper not reachable
  {
    const { ctx, page } = await open("nohelper");
    await page.focus("#email");
    await page.waitForTimeout(500);
    ok("nohelper: focus alone shows nothing", !(await menuShown(page)));
    await clickIcon(page);
    const text = await menuText(page);
    ok("nohelper: icon click shows the helper-not-reachable row", /helper not reachable/.test(text), text);
    await ctx.close();
  }

  // logins exist: icon click still opens the list
  {
    const { ctx, page } = await open("unlocked");
    await page.focus("#password");
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await clickIcon(page);
    const text = await menuText(page);
    ok("unlocked: icon click shows the login list", /test@example.com/.test(text), text);
    await ctx.close();
  }
});
