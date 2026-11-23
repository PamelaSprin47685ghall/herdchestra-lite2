import { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.resolve(WEB_ROOT, "../../deer-flow/frontend/src");
if (!existsSync(SRC)) {
  console.error(
    "deer-flow submodule missing; run: git submodule update --init --recursive",
  );
  process.exit(1);
}
const SHIM = path.join(WEB_ROOT, "shims");
const DIST = path.join(WEB_ROOT, "dist");
mkdirSync(DIST, { recursive: true });
for (const name of readdirSync(DIST)) {
  if (/^chunk-.*\.js$/.test(name)) unlinkSync(path.join(DIST, name));
}

const shimMap = {
  "lib/utils": "lib/utils.ts",
  "lib/ime": "lib/ime.ts",
  "core/clipboard": "core/clipboard.ts",
  "core/streamdown/preprocess": "core/streamdown/preprocess.ts",
  "core/streamdown/plugins": "core/streamdown/plugins.ts",
  "core/uploads": "core/uploads.ts",
};

const resolveSource = (key) => {
  const base = path.join(SRC, key);
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext)) return base + ext;
  }
  return base;
};

const resolver = {
  name: "deerflow-resolver",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      if (p.startsWith("node:")) return { path: p, external: true };
      if (p.startsWith("@herd/deer-flow-ui/")) {
        const key = "components/" + p.slice("@herd/deer-flow-ui/".length);
        return { path: resolveSource(key) };
      }
      if (p.startsWith("@/")) {
        const key = p.slice(2);
        if (shimMap[key]) return { path: path.join(SHIM, shimMap[key]) };
        return { path: resolveSource(key) };
      }
      if (p.startsWith(".") || p.startsWith("/") || p.startsWith("#")) return undefined;
      if (p === "nanoid") return { path: path.join(WEB_ROOT, "node_modules/nanoid/index.browser.js") };
      const resolved = Bun.resolveSync(p, WEB_ROOT);
      return { path: path.isAbsolute(resolved) ? resolved : path.resolve(WEB_ROOT, resolved) };
    });
  },
};

const entry = path.join(WEB_ROOT, "src/main.tsx");
if (existsSync(entry)) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: DIST,
    target: "browser",
    splitting: true,
    publicPath: "/dist/",
    plugins: [resolver],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log("JS build ok");
} else {
  console.log("JS entry missing (web/src/main.tsx); skipped JS build");
}

const cssIn = path.join(WEB_ROOT, "src/styles/app.css");
const cssOut = path.join(DIST, "app.css");
const tailwind = path.join(WEB_ROOT, "node_modules/.bin/tailwindcss");
const css = spawnSync(tailwind, ["-i", cssIn, "-o", cssOut, "--minify"], {
  cwd: WEB_ROOT,
  stdio: "inherit",
});
if (css.status !== 0) process.exit(css.status ?? 1);

copyFileSync(path.join(WEB_ROOT, "src/index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(WEB_ROOT, "src/favicon.ico"), path.join(DIST, "favicon.ico"));
copyFileSync(path.join(WEB_ROOT, "src/deerflow-mark.svg"), path.join(DIST, "deerflow-mark.svg"));
console.log("CSS + html build ok");
