// Bundle the extension into a single self-contained out/extension.js so all
// runtime dependencies (e.g. `yaml`) are inlined and no node_modules needs to
// ship in the .vsix. `vsce package` runs this via the `vscode:prepublish` script.
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "out/extension.js",
    external: ["vscode"], // provided by the VS Code host at runtime
    platform: "node",
    format: "cjs",
    target: "node18",
    minify: true,
    sourcemap: false,
    logLevel: "info",
  })
  .then(() => console.log("esbuild: bundled out/extension.js"))
  .catch(() => process.exit(1));
