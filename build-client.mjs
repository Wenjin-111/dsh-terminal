import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

mkdirSync(resolve(root, "lib"), { recursive: true });

const banner = 'window.__ModuleLoader__.load({ id: "dsh-terminal", factory: function (require) { var module = { exports: {} }; var exports = module.exports;';
const footer = "; return module.exports; } });";

const options = {
  entryPoints: [resolve(root, "src/client.jsx")],
  bundle: true,
  outfile: resolve(root, "lib/client.js"),
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
  loader: { ".css": "text" },
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  banner: { js: banner },
  footer: { js: footer },
  logLevel: "info",
};

try {
  await build(options);
} catch (error) {
  const isEperm = error != null && (error.code === "EPERM" || String(error?.message ?? "").includes("EPERM"));
  if (!isEperm) throw error;
  // Sandboxed environments cannot spawn the esbuild service process (named
  // pipes are blocked). The esbuild.exe CLI binary is self-contained: run it
  // directly with exact argv — no shell, so no quote mangling.
  const pkgPath = require.resolve("@esbuild/win32-x64/package.json");
  const binary = resolve(dirname(pkgPath), "esbuild.exe");
  const args = [
    resolve(root, "src/client.jsx"),
    "--bundle",
    `--outfile=${resolve(root, "lib/client.js")}`,
    "--format=cjs",
    "--platform=browser",
    "--target=es2020",
    "--external:react",
    "--external:react/jsx-runtime",
    "--external:@deepseek-ai/dsh-client-ui-primitives",
    "--loader:.css=text",
    "--jsx=automatic",
    "--minify",
    "--legal-comments=none",
    `--banner:js=${banner}`,
    `--footer:js=${footer}`,
  ];
  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.error != null) throw result.error;
  if (result.status !== 0) throw new Error(`esbuild.exe exited with status ${result.status}`);
}

console.log("client bundle built: lib/client.js");
