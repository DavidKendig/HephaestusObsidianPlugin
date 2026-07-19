# Notes for Claude

Context for anyone (human or model) picking this codebase up mid-stream.

## Deferred: the Cloud API key provider

**The code is still here. The UI entry point is deliberately removed.**

A third provider — `provider: "custom"`, labelled "Cloud API key" — was
built out to the point of a settings panel and then pulled from the
dropdown, because nothing behind it works yet. What remains:

| Piece | Location | State |
| --- | --- | --- |
| `Provider` type includes `"custom"` | `src/main.ts` (types) | Live |
| `customUrl`, `customApi` settings | `src/main.ts` (`HephSettings`) | Live, unused |
| `baseUrl()` / `apiKind()` custom branches | `src/main.ts` | Live, unreachable |
| Settings panel: warning + disabled API key field | `src/main.ts` (`display()`) | Live, unreachable |
| `listModels()` throws "cloud providers are not supported yet" | `src/main.ts` | Live, unreachable |
| Dropdown option | `src/main.ts` (`display()`) | **Removed** |
| Migration forcing `custom` → `ollama` on load | `src/main.ts` (`onload`) | Live |

**To re-enable:** restore the `.addOption("custom", "Cloud API key")` line
in the Server dropdown and drop the migration in `onload`. Everything
else is already wired.

**What is actually missing** before it would work: an `Authorization:
Bearer` header on both clients (no setting exists for a key — the field
in the panel is disabled and stores nothing), per-provider base URLs for
hosted APIs, and a decision about where a secret is stored. `data.json`
is plaintext in the vault, which is the wrong place for an API key.

Do not delete the dead branches without checking here first; they are
retained on purpose, not overlooked.

## Deploying

The vault at
`C:\Users\trip1\Documents\GITHUB Projects\Aethernia-Fantasy-RPG-Campaign\.obsidian\plugins\hephaestus`
is a **junction** to this repo, so `npm run build` deploys live — there
is no copy step. Two consequences:

- `data.json` (chat history) and `attachments/` (image files) are written
  by Obsidian **into this repo**. Both are gitignored. Never delete or
  overwrite `data.json` without checking it first.
- Never leave a second folder under `.obsidian/plugins/` with the same
  manifest `id`. Obsidian keys plugins by id, not folder name, and
  silently resolves duplicates to one of them. A stale `hephaestus.bak-*`
  folder once shadowed the junction and reset the history in it.

Obsidian caches plugin code in memory: after any folder surgery, fully
quit and relaunch rather than toggling the plugin.

## Build and test

```bash
npm run build   # tsc --noEmit, then esbuild → main.js (minified in prod)
npm test        # builds src/lib.ts → dist/lib.mjs, runs node --test
npm run dev     # unminified, inline sourcemap, rebuild on save
```

`src/lib.ts` holds the pure logic and is the only tested part.
`src/main.ts` imports from it — keep it that way. Testing a *copy* of the
logic was an earlier mistake: copies drift from the code they claim to
cover.

## Things that look like bugs but are not

- **Token counts are estimates** (~4 chars/token, 800/image). Deliberate:
  a real tokenizer per keystroke is not worth it.
- **Detected context windows are clamped to 131,072** (`clampContext`).
  Some models advertise 262k+, which pegs the gauge at 0% and invites
  requests the GPU cannot serve.
- **Thinking mode is Ollama-only.** There is no OpenAI-compatible
  equivalent of `think: true`.
- **`write_to_note` asks for confirmation every time.** Untrusted text
  reaches the model via web search and attachments; this is the gate.
  Do not "streamline" it away.
