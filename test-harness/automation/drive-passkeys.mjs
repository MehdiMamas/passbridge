// Passkey store end to end: the extension answers create and get through chrome.webAuthenticationProxy.
// The page checks every signature itself. Skips (and says so) only when the browser has no such API.

import { createServer } from "http";
import { build, launchExtension, main, ok } from "./lib.mjs";
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

// every browser call is bounded and named, so a stuck step fails with its name instead of hanging the job
const within = (label, promise, ms = 20000) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`passkeys: stuck at "${label}" after ${ms} ms`)), ms);
  });
  console.log(`step: ${label}`);
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

await main(async () => {
  const web = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const port = web.address().port;
  try {
    const ctx = /** @type {import("playwright-core").BrowserContext} */ (/** @type {unknown} */ (await within("launch", launchExtension(build("passkeys")), 60000)));
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
    if (!(await within("api check", sw.evaluate(() => typeof chrome.webAuthenticationProxy?.attach === "function")))) {
      ok("passkeys: SKIPPED, this browser has no chrome.webAuthenticationProxy API", true);
      return;
    }

    // a fresh synthetic key stored for seed.localhost (*.localhost is a secure origin in Chrome), so the proxy attaches there
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const key = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    const seed = makeRecord({ rpId: "seed.localhost", credentialId: b64u(crypto.getRandomValues(new Uint8Array(16))), userHandle: "AQID", userName: "seed", key });

    const options = await within("open options page", ctx.newPage());
    await within("load options page", options.goto(new URL("options.html", sw.url()).href));
    // all sites off first: the old rule, attached only where a passkey is stored
    await within("turn the setting on", sw.evaluate(() => chrome.storage.local.set({ passkeyStore: true, passkeysAllSites: false })));
    const saved = await within("store a passkey", options.evaluate((record) => chrome.runtime.sendMessage({ type: "passkeySave", record }), seed), 40000);
    ok("passkeys: the options page can store a passkey in the vault", saved?.ok && saved.result === "saved", JSON.stringify(saved));

    // a site with nothing stored: the proxy must stay detached, so the request is not answered by PassBridge
    const other = await within("open site without a passkey", ctx.newPage());
    await within("load site without a passkey", other.goto(`http://new.localhost:${port}/`));
    await other.bringToFront();
    await other.waitForTimeout(1500);
    const idle = await within("request on site without a passkey", other.evaluate(() => window.run("new.localhost")), 40000);
    ok("passkeys: no stored passkey for the site, PassBridge does not answer", idle.create !== "ok" && /Error/.test(idle.error || "") && !/TypeError/.test(idle.error || ""), JSON.stringify(idle));

    // all sites on: the same site now gets the create, and the next sign-in uses it
    await within("turn all sites on", sw.evaluate(() => chrome.storage.local.set({ passkeysAllSites: true })));
    await other.bringToFront();
    await other.reload();
    await other.waitForTimeout(1500);
    const fresh = await within("create and two gets on a site with no passkey", other.evaluate(() => window.run("new.localhost")), 60000);
    ok("passkeys: all sites on, a create on a site with no passkey is stored and its gets verify", fresh.create === "ok" && fresh.createOrigin === true && fresh.gets?.length === 2 && fresh.gets.every(Boolean), JSON.stringify(fresh));
    const dup = await within("create with a matching excludeCredentials", other.evaluate(() => window.createExcluding("new.localhost")), 20000);
    ok("passkeys: a create whose excludeCredentials matches a stored passkey is InvalidStateError", dup === "InvalidStateError", dup);
    await within("close that tab", other.close());

    // a get on a site with no passkey leaves the nudge for the popup
    const bare = await within("open site the vault has nothing for", ctx.newPage());
    await within("load that site", bare.goto(`http://nopk.localhost:${port}/`));
    await bare.bringToFront();
    await bare.waitForTimeout(1500);
    const none = await within("get on a site with no passkey", bare.evaluate(() => window.getOnly("nopk.localhost")), 20000);
    const nudge = await within("read the nudge", sw.evaluate(() => chrome.storage.session.get("passkeyNudge")));
    ok("passkeys: a get on a site with no passkey ends with a normal error and saves the nudge", /NotAllowedError/.test(none) && nudge.passkeyNudge?.rpId === "nopk.localhost", `${none} ${JSON.stringify(nudge)}`);
    await within("close that tab", bare.close());

    const page = await within("open site with a passkey", ctx.newPage());
    await within("load site with a passkey", page.goto(`http://seed.localhost:${port}/`));
    await page.bringToFront();
    await page.waitForTimeout(2000);
    const r = await within("create and two gets", page.evaluate(() => window.run("seed.localhost")), 60000);
    ok("passkeys: create is answered with the page's origin in clientDataJSON", r.create === "ok" && r.createOrigin === true, JSON.stringify(r));
    ok("passkeys: two gets return signatures that verify with the public key from create", r.gets?.length === 2 && r.gets.every(Boolean), JSON.stringify(r));
    const wrong = await within("other site rp id", page.evaluate(() => window.wrongOrigin()), 20000);
    ok("passkeys: a request for another site's rp id is refused", /SecurityError|NotAllowedError/.test(wrong), wrong);
  } finally {
    web.closeAllConnections?.();
    await new Promise((r) => web.close(r));
  }
});
