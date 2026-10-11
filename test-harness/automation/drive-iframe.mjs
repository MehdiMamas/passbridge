import { BASE, build, launchExtension, main, ok } from "./lib.mjs";

await main(async () => {
  const ctx = await launchExtension(build("unlocked"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/tricky.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const frame = page.frames().find((f) => f.url().includes("iframe-login"));
  if (!ok("iframe-login frame loaded", !!frame, "frame not found")) return;
  await frame.locator('input[autocomplete="username"], input[name="username"], input[type="text"]').first().focus().catch(() => {});
  await page.waitForTimeout(700);
  const ddInFrame = await frame.locator('[data-passbridge="suggestions"]').count();
  ok("same-origin iframe login: dropdown shows inside the frame", ddInFrame > 0, "no dropdown");
});
