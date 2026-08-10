# Notes for Claude

Context for anyone (human or model) picking this codebase up mid-stream.

## Two providers, not three

`provider` is `"ollama"` or `"lmstudio"`. A third entry, `"bonsai"` —
llama.cpp's `llama-server` on port 8080 — was added and then **removed
entirely**; unlike the Cloud API key provider below, none of its code is
retained. It never needed any: `apiKind()` returned `"openai"` for it, so
it rode the existing OpenAI client and deleting it cost nothing.

The one remnant is a migration in `onload`, which moves anyone stored on
`"bonsai"` to `"lmstudio"` and carries `bonsaiUrl` over into
`lmStudioUrl`. That is behaviour-preserving rather than a redirect —
`llama-server` is OpenAI-compatible, which is the protocol the LM Studio
entry speaks, so an existing server on `:8080` keeps working under a
different label. Do not drop this migration while any `data.json` in the
wild might still say `bonsai`.

Two things learned there that apply to **any** OpenAI-compatible server,
not just LM Studio:

- **Thinking separates for free.** A model that streams its scratchpad in
  `delta.reasoning_content` is handled by `applyDelta()` (`src/lib.ts`),
  which treats it as thinking and keeps it out of the reply. No
  `think: true` is sent — that flag is Ollama-only.
- **Auto context-detection is LM Studio-specific.** `modelInfo()`'s
  OpenAI branch queries `/api/v0/models`, which is LM Studio's own API
  and not part of the OpenAI-compatible surface. Anything else returns
  `none` (via `throw: false`) and the context falls back to the manual
  setting. Not a bug — set the window by hand to match the server.

## Tools the model can call

Six tools, defined as consts near the top of `src/main.ts` and collected
into the `TOOLS` array, which both payload builders (`completeOnce` for
Ollama, `completeOpenAI`) send when `withTools` is on. `chat()` now offers
tools **unconditionally** (`withTools = true`) — the older `!!note` gate is
gone, because most tools do not need an open note. Models that cannot call
tools still work: a capability error containing "tool" flips `withTools`
off and the round retries.

| Tool | Handler | Touches vault? |
| --- | --- | --- |
| `write_to_note` | `toolWriteToNote` | **Yes** — behind `ConfirmWriteModal` |
| `read_active_note` | `toolReadActiveNote` | No |
| `search_vault` | `toolSearchVault` | No (read-only; bounded 500 scanned / 8 hits) |
| `read_note` | `toolReadNote` | No |
| `web_search` | `toolWebSearch` | No |
| `fetch_url` | `toolFetchUrl` | No |

`executeTool()` dispatches by name and wraps every handler in a try/catch,
so a throwing tool returns an error string to the model instead of killing
the reply. The tool loop runs up to **6 rounds** (was 4) to leave room for
chains like `web_search` → `fetch_url` → answer.

**Why only `write_to_note` confirms:** it is the only tool that mutates the
vault, and untrusted text now reaches the model through *more* paths
(`web_search`, `fetch_url`, `read_note`, attachments). The gate is the one
thing standing between an injected "append this to their note" and a real
edit. Do not add a second vault-mutating tool without an equivalent gate,
and do not "streamline" this one away. See also the note below on
`write_to_note`.

The handlers reuse existing plugin capabilities (`writeToNote`,
`webSearch`, `fetchPage`, `vault.cachedRead`) — keep new tools thin
wrappers over real methods rather than reimplementing logic in the loop.

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
npm run lint    # the checks Obsidian's plugin review runs
npm run dev     # unminified, inline sourcemap, rebuild on save
```

**Run `npm run lint` before submitting anything to the plugin directory.**
It runs the same `eslint-plugin-obsidianmd` rules the reviewer does, and
answers in a second what previously took a round trip through their
report. Expect **0 errors and ~30 warnings**; `eslint.config.mjs` ends
with a comment explaining each surviving warning and why it stays. A new
error, or a warning outside those categories, is a real finding.

Two traps worth knowing, both learned the hard way:

- `tsconfig.json` must keep `"types": ["node"]` and `lib`/`target` at
  ES2022. When they drifted to ES2020, `Array.prototype.at()` was typed
  only because `@types/node` pulled the ES2022 lib in behind it — so in
  any environment without those types it degraded to `any` and took ~60
  downstream values with it. The reviewer lints in exactly such an
  environment, which is why its report looked far worse than reality.
- Never swap `this.display()` for `this.update()` in the settings tab on
  the linter's advice alone. `update()` renders from
  `getSettingDefinitions()`, which this imperative tab does not
  implement, so it would render an empty panel.

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
