import { BASE, build, launchExtension, main, ok } from "./lib.mjs";

// popup Add login: a username the site already shows opens the Passwords new-login sheet (no save);
// a new username is saved as before
await main(async () => {
  const ctx = await launchExtension(build("newsheet"));
  const sw = ctx.serviceWorkers()[0];
  const site = await ctx.newPage();
  await site.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });

  const popup = await ctx.newPage();
  await popup.goto(new URL("popup.html", sw.url()).href);
  const form = popup.locator("[data-passbridge=add-login]");
  const submit = async (user, pass) => {
    if (!(await popup.locator("[data-field=new-username]").count())) await form.getByRole("button").first().click();
    await popup.fill("[data-field=new-site]", "127.0.0.1");
    await popup.fill("[data-field=new-username]", user);
    await popup.fill("[data-field=new-password]", pass);
    await popup.click("[data-action=add-login]");
  };
  const state = () => sw.evaluate(() => ({ saved: globalThis.__mockSaved || [], launched: globalThis.__mockLaunched || [] }));
  await form.waitFor();

  await submit("test@example.com", "Sheet-pw-1");
  await popup.waitForTimeout(800);
  let s = await state();
  ok("matching username opens the new-login sheet once", s.launched.length === 1, JSON.stringify(s));
  ok("matching username is not saved", s.saved.length === 0, JSON.stringify(s));
  ok("form stays open with the note", (await popup.locator("[data-field=new-password]").count()) === 1 && /Passwords app/.test(await form.innerText()), await form.innerText());

  await submit("new@example.com", "Plain-pw-2");
  await popup.waitForTimeout(800);
  s = await state();
  ok("new username is saved", s.saved.length === 1 && s.saved[0].username === "new@example.com", JSON.stringify(s));
  ok("new username does not open the sheet", s.launched.length === 1, JSON.stringify(s));
  ok("form closes after the save", (await popup.locator("[data-field=new-password]").count()) === 0);
});
