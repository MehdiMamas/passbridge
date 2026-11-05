// e2e: what the extension does when the helper's approval (Touch ID / Windows Hello) is denied or never answered,
// and when the helper asks to sign in again: it stays usable, asks to unlock, and pairs again with the new code.
// Both platforms, run side by side because the unanswered approval has to outlast the extension's own wait.

import { BASE, clickMenu, main, menuText, ok } from "./lib.ts";
import { PLATFORMS, pairFromMenu, startE2E } from "./e2e-lib.ts";
import { seedVault } from "../fake-apple-helper/helper.ts";

const vault = () => {
  const v = seedVault();
  v.logins.push(
    { username: "deny@pb-e2e.invalid", password: "deny-Pass", sites: ["127.0.0.1"] },
    { username: "slow@pb-e2e.invalid", password: "slow-Pass", sites: ["127.0.0.1"] },
  );
  return v;
};

async function run(platform: "mac" | "win") {
  const t = (n: string) => `${platform}: ${n}`;
  const { ctx, helper } = await startE2E(platform, { vault: vault() });
  const url = `${BASE}/login-standard.html`;
  const fresh = async () => {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.focus('input[name="username"]');
    await page.waitForTimeout(900);
    return page;
  };
  const pw = (page: import("playwright-core").Page) => page.inputValue('input[name="password"]');

  const first = await ctx.newPage();
  await first.goto(url, { waitUntil: "domcontentloaded" });
  ok(t("paired"), await pairFromMenu(first, helper));
  await first.close();

  // denied: nothing is filled, the session stays unlocked, a second try with approval works
  helper.auth = "deny";
  let page = await fresh();
  const asked = helper.authPrompts;
  await clickMenu(page, "deny@pb-e2e.invalid");
  await page.waitForTimeout(1500);
  ok(t("a denied approval fills no password"), (await pw(page)) === "" && helper.authPrompts > asked, `pw="${await pw(page)}" prompts ${asked} -> ${helper.authPrompts}`);
  helper.auth = "approve";
  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
  await clickMenu(page, "deny@pb-e2e.invalid");
  await page.waitForTimeout(1500);
  ok(t("after the denial, an approved try fills"), (await pw(page)) === "deny-Pass", `pw="${await pw(page)}"`);
  await page.close();

  // never answered: the extension gives up on its own and stays usable
  helper.auth = "timeout";
  page = await fresh();
  await clickMenu(page, "slow@pb-e2e.invalid");
  await page.waitForTimeout(125000);
  ok(t("an approval nobody answers fills nothing"), (await pw(page)) === "", `pw="${await pw(page)}"`);
  helper.auth = "approve";
  await page.focus('input[name="username"]');
  await page.waitForTimeout(800);
  await clickMenu(page, "slow@pb-e2e.invalid");
  await page.waitForTimeout(1500);
  ok(t("after the wait ran out, an approved try fills"), (await pw(page)) === "slow-Pass", `pw="${await pw(page)}"`);
  await page.close();

  // the helper asks to sign in again: locked until paired again with the new code
  helper.setState("relogin");
  await new Promise((r) => setTimeout(r, 800));
  page = await fresh();
  ok(t("relogin needed: the menu asks to unlock"), /Unlock to autofill/i.test(await menuText(page)), await menuText(page));
  helper.setState("ok");
  await page.close();
  const again = await ctx.newPage();
  await again.goto(url, { waitUntil: "domcontentloaded" });
  const codes = helper.codesShown.length;
  ok(t("paired again with a new code"), (await pairFromMenu(again, helper)) && helper.codesShown.length > codes, `codes ${codes} -> ${helper.codesShown.length}`);
  await again.focus('input[name="username"]');
  await again.waitForTimeout(800);
  await clickMenu(again, "deny@pb-e2e.invalid");
  await again.waitForTimeout(1500);
  ok(t("and fills again"), (await pw(again)) === "deny-Pass", `pw="${await pw(again)}"`);
}

await main(async () => {
  await Promise.all(PLATFORMS.map(run));
});
