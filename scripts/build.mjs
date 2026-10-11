import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, stat } from "fs/promises";
import { execFileSync } from "child_process";
import { dirname, join, relative } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...p) => join(REPO, ...p);

const alias = {
  "@bitwarden/common/vault/enums": at("src/shims/bw-cipher-type.js"),
  "@bitwarden/common/autofill/constants": at("src/shims/bw-autofill-constants.js"),
  "@bitwarden/common/autofill/types": at("src/shims/bw-autofill-types.js"),
};

// Test builds set mockKind; a release build swaps the mock client for a stub so it never ships.
function mockPlugin(kind) {
  return {
    name: "passbridge-mock",
    setup(b) {
      b.onResolve({ filter: /(^|[\\/])mock-kind\.js$/ }, () => ({ path: "mock-kind", namespace: "pb-mock" }));
      b.onLoad({ filter: /^mock-kind$/, namespace: "pb-mock" }, () => ({
        contents: `export const MOCK_KIND = ${JSON.stringify(kind)};\n`,
        loader: "js",
      }));
      if (kind) return;
      b.onResolve({ filter: /(^|[\\/])mock-client\.js$/ }, () => ({ path: "mock-client", namespace: "pb-mock" }));
      b.onLoad({ filter: /^mock-client$/, namespace: "pb-mock" }, () => ({
        contents: `export function createMockClient() { throw new Error("no mock client in this build"); }\n`,
        loader: "js",
      }));
    },
  };
}

// Chrome holds the unpacked-extension root open on Windows, so rmdir(out) is EBUSY
// while the files inside can still be replaced.
async function clean(out) {
  try {
    await rm(out, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "EBUSY" && err?.code !== "EPERM") throw err;
    const entries = await readdir(out).catch(() => []);
    await Promise.all(entries.map((name) => rm(join(out, name), { recursive: true, force: true })));
  }
  await mkdir(out, { recursive: true });
}

async function exists(p) {
  return stat(p).then(() => true, () => false);
}

// every file the manifest and the extension pages load has to be in out/
async function verify(out) {
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  const wanted = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    "src/offscreen.html",
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => c.js || []),
  ]);
  for (const page of [...wanted].filter((p) => p.endsWith(".html"))) {
    const html = await readFile(join(out, page), "utf8");
    for (const [, ref] of html.matchAll(/(?:src|href)="([^":?#]+)"/g)) {
      wanted.add(relative(out, join(out, dirname(page), ref)).replaceAll("\\", "/"));
    }
  }
  for (const page of ["overlay/save-bar.html", "overlay/totp-bar.html"]) wanted.add(page);
  const missing = [];
  for (const p of wanted) if (!(await exists(join(out, p)))) missing.push(p);
  const stray = [];
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|jsx)$/.test(ent.name)) stray.push(relative(out, p));
    }
  };
  await walk(out);
  if (missing.length || stray.length) {
    throw new Error(`build check failed. missing: ${missing.join(", ") || "-"}; source files in output: ${stray.join(", ") || "-"}`);
  }
}

export async function buildExtension({ out = at("dist"), mockKind = "", preview = false, quiet = false } = {}) {
  await clean(out);
  const dst = (...p) => join(out, ...p);

  // fonts/ includes OFL.txt, which has to ship beside the woff2 files.
  for (const item of ["manifest.json", "icons", "fonts", "overlay"]) {
    await cp(at(item), dst(item), { recursive: true });
  }
  for (const page of ["popup.html", "options.html", "offscreen.html"]) {
    await cp(at("src", page), dst("src", page));
  }
  if (preview) await cp(at("src/ui/preview.html"), dst("src/preview.html"));

  const logLevel = quiet ? "error" : "warning";
  const common = { bundle: true, legalComments: "none", logLevel, absWorkingDir: REPO };

  await build({
    ...common,
    entryPoints: [at("src/background.js")],
    format: "esm",
    outfile: dst("src/background.js"),
    plugins: [mockPlugin(mockKind)],
  });

  await build({
    ...common,
    entryPoints: {
      content: at("src/content.js"),
      offscreen: at("src/offscreen.js"),
      "passkey-bridge": at("src/passkey-bridge.js"),
      "passkey-guard": at("src/passkey-guard.js"),
    },
    format: "iife",
    outdir: dst("src"),
    alias,
  });

  const react = {
    ...common,
    format: "esm",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": "\"production\"" },
  };
  await build({
    ...react,
    entryPoints: {
      popup: at("src/ui/popup.jsx"),
      options: at("src/ui/options.jsx"),
      ...(preview ? { preview: at("src/ui/preview.jsx") } : {}),
    },
    outdir: dst("src"),
  });
  // overlay/save-bar.html loads this bundle; there is no committed save-bar.js
  await build({ ...react, entryPoints: [at("src/ui/save-prompt.jsx")], outfile: dst("overlay/save-bar.js") });

  execFileSync(
    process.execPath,
    [at("node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", at("src/ui/theme.css"), "-o", dst("src/ui.css"), "--minify"],
    { stdio: quiet ? "ignore" : "inherit" },
  );

  await verify(out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildExtension({ preview: process.env.PB_PREVIEW === "1" });
  console.log("built dist/  (load this folder unpacked)");
}
