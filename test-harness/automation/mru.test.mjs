let failed = 0;
function ok(name, cond) {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
}

const data = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (data.has(k) ? { [k]: structuredClone(data.get(k)) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) data.set(k, structuredClone(v)); },
      remove: async (k) => { data.delete(k); },
    },
  },
};

const path = "../../src/session/mru.js";
const { recordUse, orderByUse } = await import(path);
const names = (l) => l.map((x) => x.username).join(",");
const logins = ["ann", "Bob", "cy"].map((username) => ({ username }));

ok("empty state keeps helper order", names(await orderByUse("a.com", logins)) === "ann,Bob,cy");
await recordUse("a.com", "cy");
await recordUse("www.a.com", "bob");
ok("last used first, case-insensitive", names(await orderByUse("a.com", logins)) === "Bob,cy,ann");
ok("subdomains share the order", names(await orderByUse("login.a.com", logins)) === "Bob,cy,ann");
ok("other site unaffected", names(await orderByUse("b.com", logins)) === "ann,Bob,cy");

const reloaded = await import(path + "?reload");
ok("survives a reload of the module", names(await reloaded.orderByUse("a.com", logins)) === "Bob,cy,ann");

const dump = JSON.stringify([...data.entries()]);
ok("no plain host or username stored", !/a\.com|bob|cy|ann/i.test(dump));

data.delete("mru:v1");
ok("clearing resets the order", names(await orderByUse("a.com", logins)) === "ann,Bob,cy");

for (let i = 0; i < 25; i++) await recordUse("c.com", "u" + i);
const many = Array.from({ length: 25 }, (_, i) => ({ username: "u" + i }));
const ordered = await orderByUse("c.com", many);
ok("cap drops the oldest user", names(ordered.slice(0, 20)) === many.slice().reverse().slice(0, 20).map((x) => x.username).join(",") && names(ordered.slice(20)) === "u0,u1,u2,u3,u4");
for (let i = 0; i < 510; i++) await recordUse(`s${i}.com`, "x");
ok("site cap", data.get("mru:v1").length === 500);

data.clear();
const fresh = await import(path + "?fresh");
await Promise.all([fresh.recordUse("d.com", "p"), fresh.recordUse("d.com", "q"), fresh.recordUse("e.com", "r")]);
const other = await import(path + "?other");
ok("concurrent first use yields one key and keeps both", names(await other.orderByUse("d.com", [{ username: "p" }, { username: "q" }])) === "q,p");

const broken = { storage: { local: { get: async () => { throw new Error("x"); } } } };
const saved = globalThis.chrome;
globalThis.chrome = broken;
const b = await import(path + "?broken");
ok("storage error falls back", names(await b.orderByUse("a.com", logins)) === "ann,Bob,cy");
globalThis.chrome = saved;

process.exit(failed ? 1 : 0);
