# Notes for Claude

Context for anyone (human or model) picking this codebase up mid-stream.

## The Bonsai provider

`provider: "bonsai"` talks to a local **Bonsai llama-server**, which is
llama.cpp's `llama-server` speaking the **OpenAI-compatible API on
`http://localhost:8080`** (`/v1/models`, `/v1/chat/completions`,
`/health`). It reuses the existing OpenAI client wholesale — `apiKind()`
returns `"openai"` for it, so there is no Bonsai-specific request code.
Default URL lives in `DEFAULT_DATA.settings.bonsaiUrl`.

Things that follow from it being llama.cpp:

- **Tool calling** (the full tool set — see below) and **vision** work
  because the demo 27B server is started with `--jinja` and `--mmproj`.
  Nothing Bonsai-specific in the plugin.
- **Thinking is separated for free.** The model streams its scratchpad in
  `delta.reasoning_content`, which `applyDelta()` (`src/lib.ts`) already
  treats as thinking and keeps out of the reply. No `think: true` flag is
  sent — that is Ollama-only.
- **Auto context-detection does not work.** `modelInfo()`'s OpenAI branch
  queries LM Studio's `/api/v0/models`, which Bonsai lacks; it returns
  `none` (via `throw: false`) and the context falls back to the manual
  setting. Not a bug — set the window by hand to match the server's `-c`.

**Running the server on a small/iGPU:** the stock
`start_llama_server.ps1` launches the 27B with `-ngl 99 -c 0`, and `-c 0`
means the model's full 262k context — the KV cache OOMs on ~16 GB cards.
Pass `-c 16384` (or `32768`/`65536`) to the script; it forwards extra
args after its own, and a later `-c` wins.

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
