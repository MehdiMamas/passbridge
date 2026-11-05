// e2e: the passkey store through the real protocol. A passkey is a login saved for a reserved site in the simulated
// helper; the page's create and get are answered from it through chrome.webAuthenticationProxy. Windows only (the
// proxy is attached there; on macOS Chrome uses iCloud passkeys itself). Skips, and says so, when the browser has no such API.

import { createServer } from "http";
import { BASE, main, ok } from "./lib.mjs";
import { pairFromMenu, startE2E } from "./e2e-lib.mjs";
import { b64u, makeRecord } from "../../src/passkeys/record.ts";

const PAGE = `<!doctype html><meta charset=utf-8><body><pre id=o></pre><script>
const u=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
const timed=(p,ms)=>Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error('TimedOut: no answer')),ms))]);
async function verifyGet(pub,g){
  const ad=new Uint8Array(g.response.authenticatorData),cdj=new Uint8Array(g.response.clientDataJSON);
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',cdj));
  const data=new Uint8Array(ad.length+32);data.set(ad);data.set(h,ad.length);
  const der=new Uint8Array(g.response.signature);let p=2;
  const rd=()=>{p++;const l=der[p++];let x=der.slice(p,p+l);p+=l;while(x.length>32)x=x.slice(1);const o=new Uint8Array(32);o.set(x,32-x.length);return o;};
  const raw=new Uint8Array(64);raw.set(rd());raw.set(rd(),32);
  const cd=JSON.parse(new TextDecoder().decode(cdj));
  return (await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,raw,data))&&cd.type==='webauthn.get'&&cd.origin===location.origin&&(ad[32]&1)===1;
}
window.run=async function(rpId){
  const r={};
  try{
    const c=await timed(navigator.credentials.create({publicKey:{rp:{id:rpId,name:'t'},user:{id:new Uint8Array([1,2,3]),name:'u',displayName:'u'},challenge:crypto.getRandomValues(new Uint8Array(32)),pubKeyCredParams:[{type:'public-key',alg:-7}],attestation:'none'}}),6000);
    r.create='ok';window.lastRaw=c.rawId;
    const cd=JSON.parse(new TextDecoder().decode(c.response.clientDataJSON));
    r.createOrigin=cd.type==='webauthn.create'&&cd.origin===location.origin;
    const pub=await crypto.subtle.importKey('spki',c.response.getPublicKey(),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    r.gets=[];
    for(let i=0;i<2;i++){
      const g=await timed(navigator.credentials.get({publicKey:{rpId,challenge:crypto.getRandomValues(new Uint8Array(32)),allowCredentials:[{type:'public-key',id:c.rawId}]}}),6000);
      r.gets.push(await verifyGet(pub,g));
    }
  }catch(e){r.error=e.name+': '+e.message;}
  return r;
};
window.createExcluding=async function(rpId){
  try{await timed(navigator.credentials.create({publicKey:{rp:{id:rpId,name:'t'},user:{id:new Uint8Array([4,5,6]),name:'u2',displayName:'u2'},challenge:crypto.getRandomValues(new Uint8Array(32)),pubKeyCredParams:[{type:'public-key',alg:-7}],excludeCredentials:[{type:'public-key',id:window.lastRaw}],attestation:'none'}}),6000);return 'UNEXPECTED SUCCESS';}
  catch(e){return e.name;}
};
window.getOnly=async function(rpId){
  try{await timed(navigator.credentials.get({publicKey:{rpId,challenge:crypto.getRandomValues(new Uint8Array(32))}}),6000);return 'UNEXPECTED SUCCESS';}
  catch(e){return e.name;}
};
window.wrongOrigin=async function(){
  try{await timed(navigator.credentials.get({publicKey:{rpId:'example.com',challenge:new Uint8Array(32)}}),6000);return 'UNEXPECTED SUCCESS';}
  catch(e){return e.name;}
};
</script>`;


await main(async () => {
  const web = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise((r) => web.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("net").AddressInfo} */ (web.address()).port;
  try {
    const { ctx: rawCtx, helper  } = await startE2E("win");
    const ctx = /** @type {import("playwright-core").BrowserContext} */ (/** @type {unknown} */ (rawCtx));
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
    if (!(await sw.evaluate(() => typeof chrome.webAuthenticationProxy?.attach === "function"))) {
      ok("passkeys: SKIPPED, this browser has no chrome.webAuthenticationProxy API", true);
      return;
    }
    const login = await ctx.newPage();
    await login.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
    await login.waitForTimeout(300);
    ok("win: paired", await pairFromMenu(login, helper));
    await login.close();

    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const key = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    const seed = makeRecord({ rpId: "seed.localhost", credentialId: b64u(crypto.getRandomValues(new Uint8Array(16))), userHandle: "AQID", userName: "seed", key });

    const options = await ctx.newPage();
    await options.goto(new URL("options.html", sw.url()).href);
    await sw.evaluate(() => chrome.storage.local.set({ passkeyStore: true, passkeysAllSites: false }));
    const before = helper.vault.logins.length;
    const saved = await options.evaluate((record) => chrome.runtime.sendMessage({ type: "passkeySave", record }), seed);
    ok("win: the passkey is saved to the helper", saved?.ok && saved.result === "saved" && helper.vault.logins.length === before + 1, JSON.stringify(saved));
    const row = helper.vault.logins.find((l) => /seed\.localhost/.test(l.username));
    ok("win: it is one login with the record as its password", !!row && row.password.length > 100, row ? "short password" : "no row");

    // Import from a file on the Browser tab (the page is reopened so it reads passkeyStore on load).
    // The Options page shows the Windows rows by the browser's platform, so it reports Windows here.
    const imp = await ctx.newPage();
    await imp.addInitScript(() => Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ platform: "Windows" }) }));
    await imp.goto(new URL("options.html#browser", sw.url()).href);
    const pick = imp.locator("input[type=file]");
    await pick.waitFor({ state: "attached", timeout: 10000 });
    await pick.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("not json") });
    await imp.waitForSelector("[data-passkey-results]", { timeout: 10000 });
    const badRows = await imp.$$eval("[data-passkey-results] li", (els) => els.map((e) => [e.getAttribute("data-status"), e.textContent]));
    ok("win: import of a file that is not JSON shows one failed row with the reason", badRows.length === 1 && badRows[0][0] === "failed" && badRows[0][1].includes("This file is not JSON."), JSON.stringify(badRows));
    const pair2 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const key2 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair2.privateKey)));
    const cxf = { accounts: [{ items: [{ credentials: [{ type: "passkey", credentialId: b64u(crypto.getRandomValues(new Uint8Array(16))), rpId: "import.localhost", username: "imported", userHandle: "AQID", key: key2 }] }] }] };
    const beforeImport = helper.vault.logins.length;
    await pick.setInputFiles({ name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(cxf)) });
    await imp.waitForFunction(() => document.querySelector("[data-passkey-results] li[data-status=saved]"), null, { timeout: 15000 }).catch(() => {});
    const goodRows = await imp.$$eval("[data-passkey-results] li", (els) => els.map((e) => e.getAttribute("data-status")));
    const summary = await imp.$eval("[data-passkey-results] p", (e) => e.textContent).catch(() => "");
    ok("win: import of a valid export saves it (1 of 1) and the helper vault grows by one", goodRows.length === 1 && goodRows[0] === "saved" && /1\D+1/.test(summary) && helper.vault.logins.length === beforeImport + 1, `${JSON.stringify(goodRows)} ${summary} ${beforeImport} -> ${helper.vault.logins.length}`);

    const page = await ctx.newPage();
    await page.goto(`http://seed.localhost:${port}/`);
    await page.bringToFront();
    await page.waitForTimeout(2000);
    const prompts = helper.authPrompts;
    const r = await page.evaluate(() => /** @type {any} */ (window).run("seed.localhost"));
    ok("win: create and two gets answered from the helper", r.create === "ok" && r.createOrigin === true && r.gets?.length === 2 && r.gets.every(Boolean), JSON.stringify(r));
    ok("win: reading the passkey went through the helper's approval", helper.authPrompts > prompts, `${prompts} -> ${helper.authPrompts}`);
    const wrong = await page.evaluate(() => /** @type {any} */ (window).wrongOrigin());
    ok("win: another site's rp id is refused", /SecurityError|NotAllowedError/.test(wrong), wrong);
  } finally {
    web.closeAllConnections?.();
    await new Promise((r) => web.close(r));
  }
});
