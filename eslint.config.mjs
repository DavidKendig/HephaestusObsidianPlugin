// The checks Obsidian's plugin review runs, runnable locally.
//
// Four rounds of "these warnings are still there" were spent pasting the
// reviewer's report back and forth, twice against line numbers that had
// already moved. `npm run lint` answers the same question in a second,
// against the working tree rather than whatever commit was last scanned.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    // Build output and dependencies: not ours to lint.
    ignores: ["main.js", "dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware rules need a program. Without this the no-unsafe-*
        // rules see `any` everywhere and report the whole codebase —
        // which is exactly what a reviewer running without the project's
        // types would see.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The build scripts are plain Node ESM, outside the tsconfig program.
    files: ["*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);

/* Warnings that are expected to stay, so a clean run is not silence.
 *
 * obsidianmd/ui/sentence-case (18) — every current hit is a false
 *   positive. The rule lowercases everything after the first word, which
 *   turns "LM Studio" into "Lm studio", "DuckDuckGo" into "Duckduckgo",
 *   "http://localhost:11434" into "HTTP://localhost:11434", and the API
 *   key placeholder "sk-…" into "Sk-…" — that last one is not a style
 *   preference, it is wrong, since that prefix is literal. Left enabled
 *   rather than switched off, so a genuine Title Case slip in new UI text
 *   still shows up; check new hits against this list before assuming.
 *
 * no-restricted-globals (2) — the two `fetch` calls are the streaming
 *   paths. requestUrl cannot stream, and the code already falls back to
 *   it for the non-streaming case.
 *
 * prefer-setting-definitions / prefer-update-over-display /
 * no-deprecated (9) — one decision, not nine. Migrating the settings tab
 *   to getSettingDefinitions() would clear all of them and make settings
 *   searchable. Note that swapping display() for update() *alone* would
 *   break the tab: update() renders from getSettingDefinitions(), which
 *   this imperative tab does not implement, so it would render nothing.
 *   The two go together or not at all. */
