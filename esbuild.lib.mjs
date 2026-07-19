// Builds the pure helpers as an ESM module so `node --test` can import
// them directly. Tests run against the same source main.js bundles.
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/lib.ts"],
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "neutral",
  logLevel: "warning",
  outfile: "dist/lib.mjs",
});
