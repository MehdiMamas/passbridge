import { BASE, build, launchExtension, main, menuText, ok } from "./lib.mjs";

const ICON = "[data-passbridge-icon]";

// focus the field so its icon appears, then drop focus without the focusout that removes the icon
async function unfocusKeepingIcon(/** @type {import("playwright-core").Page} */ page, /** @type {string} */ sel) {
  await page.goto(`${BASE}/icon-click.html?mode=sticky`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus(sel);
  await page.waitForTimeout(500);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).blur());
  await page.waitForTimeout(100);
}

async function clickIcon(/** @type {import("playwright-core").Page} */ page) {
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator(ICON).boundingBox());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
}

await main(async () => {
  // no logins, unfocused email field: the click says so
  const emptyCtx = await launchExtension(build("empty"));
  let page = await emptyCtx.newPage();
  await unfocusKeepingIcon(page, "#em");
  ok("icon is up with the field unfocused", (await page.locator(ICON).count()) > 0, "no icon");
  ok("field is not focused before the click", (await page.evaluate(() => document.activeElement?.id)) !== "em");
  await clickIcon(page);
  const empty = await menuText(page);
  ok("icon click on an empty vault shows the no-logins row", /No saved logins for this site/.test(empty), empty);

  // logins, unfocused password field: the click opens the list
  const ctx = await launchExtension(build("unlocked"));
  page = await ctx.newPage();
  await unfocusKeepingIcon(page, "#pw");
  await clickIcon(page);
  const list = await menuText(page);
  ok("icon click on an unfocused password field opens the list", /test@example.com/.test(list), list);
  ok("the click focused the field", (await page.evaluate(() => document.activeElement?.id)) === "pw");

  // the page replaces the input after focus: the click still opens the menu, on the new input
  page = await ctx.newPage();
  await page.goto(`${BASE}/icon-click.html?mode=replace`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus("#em");
  await page.waitForTimeout(600);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur?.());
  await page.waitForTimeout(100);
  if ((await page.locator(ICON).count()) === 0) await page.focus("#em");
  await page.waitForTimeout(300);
  ok("the input was replaced", await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("em")).isConnected));
  await clickIcon(page);
  const replaced = await menuText(page);
  ok("icon click after a re-render opens the menu", /test@example.com/.test(replaced), replaced);
  ok("the new input has focus", (await page.evaluate(() => document.activeElement?.id)) === "em");
});
