// Adapted from obsidian-sample-plugin (0BSD), which requires no
// attribution — noted here so the provenance is not lost.
import esbuild from "esbuild";
import process from "process";
// Node's own list, rather than the builtin-modules package: same data,
// one fewer dependency, and it cannot fall behind the runtime.
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    ...builtinModules,
    // Bare specifiers are what this codebase imports, but the prefixed
    // form resolves to the same modules and must not be bundled either.
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  // Obsidian ships a modern Electron, so there is no reason to downlevel
  // syntax the runtime already understands.
  target: "es2022",
  // Inline the logo as text. An Obsidian release ships only main.js,
  // manifest.json, and styles.css, so an asset loaded from disk at
  // runtime would simply be missing for anyone installing normally.
  loader: { ".svg": "text" },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // Release builds are minified; dev builds stay readable with an inline
  // sourcemap so stack traces still point at the TypeScript.
  minify: prod,
  legalComments: "none",
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
