import { BASE, build, launchExtension, main, ok, pierced } from "./lib.mjs";

const attrs = (node) => {
  const a = {};
  const list = node.attributes || [];
  for (let i = 0; i < list.length; i += 2) a[list[i]] = list[i + 1];
  return a;
};

async function openMany(page) {
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
}

await main(async () => {
  const manyCtx = await launchExtension(build("many"));
  const page = await manyCtx.newPage();
  await openMany(page);

  let view = await pierced(page);
  const opened = view.textOf(view.host);
  ok("long list offers a username search", !!view.find((n) => attrs(n).placeholder === "Search usernames"), opened.slice(0, 180));
  const listNode = view.find((n) => attrs(n)["data-passbridge-login-list"]);
  const metrics = listNode
    ? await view.call(listNode, "function(){return {clientHeight:this.clientHeight,scrollHeight:this.scrollHeight,overflowY:getComputedStyle(this).overflowY}}")
    : null;
  ok(
    "list scrolls inside a 6-row cap",
    metrics && metrics.scrollHeight > metrics.clientHeight && metrics.clientHeight > 0 && metrics.clientHeight <= 280 && metrics.overflowY === "auto",
    JSON.stringify(metrics),
  );
  ok("later usernames stay in the list", /jake@example.com/.test(opened), opened.slice(0, 240));

  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  view = await pierced(page);
  const scrolled = await view.call(
    view.find((n) => attrs(n)["data-passbridge-login-list"]),
    "function(){return this.scrollTop}",
  );
  ok("arrow down scrolls the list", scrolled > 0, String(scrolled));

  await page.fill('input[name="username"]', "mehdi");
  await page.waitForTimeout(150);
  view = await pierced(page);
  const filtered = view.textOf(view.host);
  const searchValue = await view.call(
    view.find((n) => attrs(n).placeholder === "Search usernames"),
    "function(){return this.value}",
  );
  ok(
    "page username filters to mehdi only",
    /mehdi\.one@example\.com/.test(filtered) && /mehdi\.two@example\.com/.test(filtered) && !/alice@example.com/.test(filtered) && !/jake@example.com/.test(filtered),
    filtered,
  );
  ok("search box follows the username field", searchValue === "mehdi", searchValue);

  const searchNode = view.find((n) => attrs(n).placeholder === "Search usernames");
  await view.client.send("DOM.focus", { nodeId: searchNode.nodeId });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("riot");
  await page.waitForTimeout(150);
  view = await pierced(page);
  const siteMiss = view.textOf(view.host);
  ok("search matches username only", /No matching usernames/.test(siteMiss) && !/alice@example.com/.test(siteMiss), siteMiss);

  await view.client.send("DOM.focus", { nodeId: view.find((n) => attrs(n).placeholder === "Search usernames").nodeId });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("mehdi.one");
  await page.waitForTimeout(150);
  view = await pierced(page);
  const nameNode = view.nodes.find((n) => (n.children || []).some((c) => c.nodeValue?.trim() === "mehdi.one@example.com"));
  await view.click(nameNode);
  await page.waitForTimeout(400);
  ok(
    "filtered row fills the username",
    (await page.inputValue('input[name="username"]')) === "mehdi.one@example.com",
    await page.inputValue('input[name="username"]'),
  );

  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="password"]');
  await page.waitForTimeout(600);
  await page.fill('input[name="password"]', "alice");
  await page.waitForTimeout(200);
  view = await pierced(page);
  const pwText = view.textOf(view.host);
  ok("password text is not a username query", /alice@example.com/.test(pwText) && /jake@example.com/.test(pwText), pwText.slice(0, 240));

  await view.client.send("DOM.focus", { nodeId: view.find((n) => attrs(n).placeholder === "Search usernames").nodeId });
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  const fromSearch = await pierced(page);
  const searchScrolled = await fromSearch.call(
    fromSearch.find((n) => attrs(n)["data-passbridge-login-list"]),
    "function(){return this.scrollTop}",
  );
  ok("arrow keys scroll while the search field is focused", searchScrolled > 0, String(searchScrolled));
  await page.keyboard.press("Escape");
  ok(
    "escape returns to the page field",
    await page.evaluate(() => document.activeElement?.id === "password"),
    await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName),
  );

  await page.goto(`${BASE}/signup.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus("#new-password");
  await page.waitForTimeout(600);
  view = await pierced(page);
  const signup = view.textOf(view.host);
  const signupList = view.find((n) => attrs(n)["data-passbridge-login-list"]);
  const signupMetrics = await view.call(
    signupList,
    "function(){return {clientHeight:this.clientHeight,scrollHeight:this.scrollHeight}}",
  );
  ok(
    "generator stays under the capped list",
    /Strong Password/.test(signup) && /Without Special Characters/.test(signup) && signupMetrics.scrollHeight > signupMetrics.clientHeight,
    signup.slice(0, 240) + " " + JSON.stringify(signupMetrics),
  );
  await manyCtx.close();

  const multiCtx = await launchExtension(build("multi", "OP_MULTI"));
  const multi = await multiCtx.newPage();
  await multi.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await multi.waitForTimeout(300);
  await multi.focus('input[name="username"]');
  await multi.waitForTimeout(600);
  const multiView = await pierced(multi);
  const multiText = multiView.textOf(multiView.host);
  const multiList = multiView.find((n) => attrs(n)["data-passbridge-login-list"]);
  const multiMetrics = multiList
    ? await multiView.call(multiList, "function(){return {scrollHeight:this.scrollHeight,clientHeight:this.clientHeight,overflowY:getComputedStyle(this).overflowY}}")
    : null;
  ok(
    "two logins stay a short list without search",
    /alice@example.com/.test(multiText) &&
      /bob@work.com/.test(multiText) &&
      !multiView.find((n) => attrs(n).placeholder === "Search usernames") &&
      multiMetrics &&
      multiMetrics.scrollHeight <= multiMetrics.clientHeight + 1 &&
      multiMetrics.overflowY !== "auto",
    multiText + " " + JSON.stringify(multiMetrics),
  );
  await multiCtx.close();
});
