/** Pure helpers, deliberately free of any Obsidian import so they can be
 *  bundled and run under `node --test`. Anything with real logic worth
 *  getting right belongs here rather than in the view. */

export interface Attachment {
  name: string;
  kind: "image" | "file";
  /** Text attachments keep their contents inline. */
  text?: string;
  /** Image attachments keep a vault-relative path; the bytes live on
   *  disk so conversation history stays small. */
  path?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Legacy: base64 images stored inline by versions before 0.2.0.
   *  Still read so old conversations keep working, never written. */
  images?: string[];
  attachments?: Attachment[];
}

export interface WireMsg {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: Record<string, unknown> };
}

// ------------------------------------------------------------- encoding

/** Bytes to base64, chunked — a spread over a multi-megabyte image
 *  would overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** True when a decoded buffer is not text — a NUL byte early on means
 *  PDF, zip, or similar, which we cannot attach as text. */
export function isBinary(text: string): boolean {
  return text.slice(0, 1000).includes("\0");
}

/** Conversation titles are the first message, clipped. */
export function titleFrom(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.slice(0, 48) + (clean.length > 48 ? "…" : "");
}

// -------------------------------------------------------------- tokens

/** Rough token count. Real tokenizers vary by model; ~4 characters per
 *  token is close enough to drive a usage gauge and trimming, and it is
 *  free — running a real tokenizer per keystroke is not. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Images cost far more than their name suggests. Vision models tile an
 *  image into patches; this is a deliberately conservative flat estimate
 *  so the gauge errs toward warning early. */
export const IMAGE_TOKENS = 800;

/** Estimated tokens for one message, attachments included. */
export function messageTokens(m: {
  content: string;
  images?: string[];
  attachments?: Attachment[];
}): number {
  let n = estimateTokens(m.content) + 4; // + role/framing overhead
  for (const a of m.attachments ?? []) {
    if (a.kind === "image") n += IMAGE_TOKENS;
    else if (a.text) n += estimateTokens(a.text);
  }
  n += (m.images?.length ?? 0) * IMAGE_TOKENS;
  return n;
}

/** Estimated tokens for a whole thread. */
export function conversationTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

/** Split of what is filling the context window, for the gauge tooltip. */
export interface Usage {
  system: number;
  note: number;
  messages: number;
  draft: number;
  total: number;
  limit: number;
  /** 0–1+, where >1 means the request will not fit. */
  ratio: number;
}

/** Total context usage broken down by contributor, for the gauge. */
export function usage(parts: {
  system: string;
  note: string;
  messages: ChatMessage[];
  draft: string;
  limit: number;
}): Usage {
  const system = estimateTokens(parts.system);
  const note = estimateTokens(parts.note);
  const messages = conversationTokens(parts.messages);
  const draft = estimateTokens(parts.draft);
  const total = system + note + messages + draft;
  const limit = Math.max(1, parts.limit);
  return { system, note, messages, draft, total, limit, ratio: total / limit };
}

/** Gauge colour thresholds: green under 50%, yellow under 75%, red at
 *  75% and above — red is the "this may not fit" band, not just full. */
export function usageLevel(ratio: number): "ok" | "warn" | "danger" {
  if (ratio < 0.5) return "ok";
  if (ratio < 0.75) return "warn";
  return "danger";
}

/** Drop the oldest messages until the thread fits `budget`, always
 *  keeping the final user turn — trimming the question being asked
 *  would be worse than sending nothing. Returns how many were dropped
 *  so the UI can say so out loud rather than silently forgetting. */
export function trimToBudget(
  messages: ChatMessage[],
  budget: number,
): { messages: ChatMessage[]; trimmed: number } {
  if (messages.length <= 1) return { messages, trimmed: 0 };
  const kept = [...messages];
  let total = conversationTokens(kept);
  let trimmed = 0;
  while (total > budget && kept.length > 1) {
    const dropped = kept.shift();
    if (!dropped) break;
    total -= messageTokens(dropped);
    trimmed++;
  }
  return { messages: kept, trimmed };
}

// ----------------------------------------------------------- search

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

/** Which search backend to use. DuckDuckGo needs no configuration but
 *  is scraped from HTML and so is the most fragile; the other two
 *  return JSON. */
export type SearchProvider = "duckduckgo" | "searxng" | "brave";

/** Keep only results we can actually cite and fetch. */
function usableSources(raw: SearchSource[], limit = 6): SearchSource[] {
  const seen = new Set<string>();
  const out: SearchSource[] = [];
  for (const s of raw) {
    if (!s.url || !/^https?:\/\//i.test(s.url)) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({
      title: s.title?.trim() || s.url,
      url: s.url,
      snippet: (s.snippet ?? "").trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** SearXNG's JSON API: `?q=…&format=json`. Note that public instances
 *  usually disable the JSON format, so this mostly serves self-hosted
 *  instances. */
export function parseSearxng(body: unknown): SearchSource[] {
  const results = (body as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return usableSources(
    results.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        title: String(x.title ?? ""),
        url: String(x.url ?? ""),
        snippet: String(x.content ?? ""),
      };
    }),
  );
}

/** Brave Search API: results live under web.results. */
export function parseBrave(body: unknown): SearchSource[] {
  const results = (body as { web?: { results?: unknown[] } })?.web?.results;
  if (!Array.isArray(results)) return [];
  return usableSources(
    results.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        title: String(x.title ?? ""),
        url: String(x.url ?? ""),
        // Brave marks query terms with <strong> in descriptions.
        snippet: String(x.description ?? "").replace(/<[^>]+>/g, ""),
      };
    }),
  );
}

/** Accept what someone is likely to paste — bare hosts included — and
 *  reject anything that is not http(s). Returns null when unusable. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A short, human label for a fetched page, for the attachment chip. */
export function pageLabel(url: string, title?: string): string {
  const clean = (title ?? "").trim().replace(/\s+/g, " ");
  if (clean) return clean.slice(0, 60);
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

// ------------------------------------------------------- model info

/** What a backend can tell us about a loaded model. Every field is
 *  optional: servers vary in how much they report. */
export interface ModelInfo {
  contextLength: number | null;
  parameterSize: string | null;
  quantization: string | null;
}

/** Pull the context length out of Ollama's /api/show response.
 *
 *  The key is namespaced by architecture — `llama.context_length`,
 *  `gemma4.context_length`, `qwen3moe.context_length` — so it has to be
 *  found by suffix rather than looked up by a fixed name. */
export function parseOllamaShow(body: unknown): ModelInfo {
  const j = (body ?? {}) as {
    model_info?: Record<string, unknown>;
    details?: { parameter_size?: string; quantization_level?: string };
  };
  let contextLength: number | null = null;
  for (const [key, value] of Object.entries(j.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      contextLength = value;
      break;
    }
  }
  return {
    contextLength,
    parameterSize: j.details?.parameter_size ?? null,
    quantization: j.details?.quantization_level ?? null,
  };
}

/** LM Studio's native REST API (/api/v0/models) reports context length;
 *  its OpenAI-compatible /v1/models does not. */
export function parseLmStudioModels(
  body: unknown,
  model: string,
): ModelInfo {
  const list = (body as { data?: unknown[] })?.data;
  const empty: ModelInfo = {
    contextLength: null,
    parameterSize: null,
    quantization: null,
  };
  if (!Array.isArray(list)) return empty;
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    if (m.id !== model) continue;
    const ctx = m.max_context_length ?? m.loaded_context_length;
    return {
      contextLength: typeof ctx === "number" ? ctx : null,
      parameterSize:
        typeof m.arch === "string" ? (m.arch as string) : null,
      quantization:
        typeof m.quantization === "string" ? (m.quantization as string) : null,
    };
  }
  return empty;
}

/** Clamp a detected context length to something sane. Some models
 *  advertise enormous windows the machine cannot actually serve, and a
 *  gauge scaled to 1M tokens would read 0% forever. */
export function clampContext(detected: number, cap = 131_072): number {
  if (!Number.isFinite(detected) || detected <= 0) return 0;
  return Math.min(Math.floor(detected), cap);
}

// ----------------------------------------------------------- hardware

export interface Hardware {
  cpu: string;
  cores: number;
  ramTotal: number;
  ramFree: number;
  gpu: string | null;
  /** Bytes of dedicated video memory, when it can be determined. */
  vram: number | null;
  /** Apple silicon and most integrated GPUs share system RAM rather than
   *  having dedicated VRAM, which changes what "fits" means entirely. */
  unified: boolean;
  platform: string;
}

/** Human-readable byte size. Returns an em dash for unknown values. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`.
 *  Returns the largest card, which is the one a model would land on. */
export function parseNvidiaSmi(
  stdout: string,
): { name: string; vram: number } | null {
  let best: { name: string; vram: number } | null = null;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(.+?),\s*([\d.]+)\s*(MiB|GiB|MB|GB)\s*$/i);
    if (!m) continue;
    const value = Number.parseFloat(m[2]);
    if (!Number.isFinite(value)) continue;
    const unit = m[3].toLowerCase();
    const bytes =
      unit === "mib" || unit === "mb"
        ? value * 1024 * 1024
        : value * 1024 * 1024 * 1024;
    if (!best || bytes > best.vram) best = { name: m[1].trim(), vram: bytes };
  }
  return best;
}

/** Parse a size string as reported by system tools: "8 GB", "12227 MiB". */
export function parseSizeString(text: string): number | null {
  const m = String(text).match(/([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/i);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return value * (scale[unit] ?? 1);
}

/** Parse `system_profiler SPDisplaysDataType -json` on macOS.
 *
 *  Intel Macs with a discrete card report `spdisplays_vram`. Apple
 *  silicon reports no VRAM at all, because the GPU shares system memory
 *  — that is not a detection failure, it is a different architecture,
 *  so it is reported as unified rather than unknown. */
export function parseSystemProfiler(
  jsonText: string,
): { name: string; vram: number | null; unified: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const list = (parsed as { SPDisplaysDataType?: unknown[] })
    ?.SPDisplaysDataType;
  if (!Array.isArray(list) || list.length === 0) return null;

  let best: { name: string; vram: number | null; unified: boolean } | null =
    null;
  for (const raw of list) {
    const g = raw as Record<string, unknown>;
    const name = String(
      g.sppci_model ?? g._name ?? "",
    ).trim();
    if (!name) continue;
    const vramText = g.spdisplays_vram ?? g.spdisplays_vram_shared;
    const vram = vramText ? parseSizeString(String(vramText)) : null;
    // Apple's own GPUs share system memory; so does anything reporting
    // only "shared" VRAM.
    const unified =
      String(g.spdisplays_vendor ?? "").includes("Apple") ||
      /Apple\s+M\d/i.test(name) ||
      (!g.spdisplays_vram && !!g.spdisplays_vram_shared);
    const candidate = { name, vram, unified };
    if (!best || (vram ?? 0) > (best.vram ?? 0)) best = candidate;
  }
  return best;
}

/** Pull a GPU name out of `lspci` output on Linux. */
export function parseLspci(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    // "01:00.0 VGA compatible controller: NVIDIA Corporation GA104 ..."
    const m = line.match(
      /(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i,
    );
    if (m) {
      return m[1]
        .replace(/\s*\(rev [^)]*\)\s*$/i, "")
        .replace(/\s*\[[^\]]*\]\s*$/, "")
        .trim();
    }
  }
  return null;
}

export type FitLevel = "ok" | "warn" | "danger" | "unknown";

/** Rough "will this run well" verdict, in the spirit of llmfit but far
 *  simpler: weights plus a flat overhead allowance, compared against
 *  video memory first and system memory second. Deliberately coarse —
 *  real fit depends on quantization, layer count, and KV cache growth
 *  with context, so this is a traffic light, not a guarantee. */
export function fitVerdict(
  modelBytes: number,
  vram: number | null,
  ram: number,
  unified = false,
): { level: FitLevel; text: string } {
  if (!modelBytes || modelBytes <= 0) {
    return { level: "unknown", text: "Model size unknown" };
  }
  // Runtime needs more than the weights: KV cache, activations, and the
  // server's own overhead.
  const needed = modelBytes * 1.2;

  // Unified memory (Apple silicon): the GPU can address system RAM, so
  // there is no "spills to RAM and gets slow" middle ground — it either
  // fits in the shared pool or it does not. macOS caps GPU allocation
  // well below total RAM, hence the 75% allowance.
  if (unified) {
    const usable = ram * 0.75;
    if (needed <= usable) {
      return {
        level: "ok",
        text:
          `Fits in unified memory (~${formatBytes(needed)} of ` +
          `${formatBytes(usable)} usable)`,
      };
    }
    return {
      level: "danger",
      text:
        `Needs ~${formatBytes(needed)}, beyond the ~${formatBytes(usable)}` +
        " the GPU can address",
    };
  }

  if (vram && needed <= vram) {
    return {
      level: "ok",
      text: `Fits in VRAM (~${formatBytes(needed)} of ${formatBytes(vram)})`,
    };
  }
  // Leave headroom for the OS rather than counting every byte of RAM.
  if (needed <= ram * 0.8) {
    return {
      level: "warn",
      text: vram
        ? `Too big for VRAM — will spill to RAM and run slower`
        : `Fits in RAM (~${formatBytes(needed)} of ${formatBytes(ram)})`,
    };
  }
  return {
    level: "danger",
    text: `Needs ~${formatBytes(needed)}, more than available memory`,
  };
}

// --------------------------------------------------------- attachments

/** Inline attached file text into what the model sees, leaving the
 *  saved message showing only what the user typed. */
export function withAttachments(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const files = (m.attachments ?? []).filter(
      (a) => a.kind === "file" && a.text,
    );
    if (files.length === 0) return m;
    const blocks = files
      .map((f) => `--- Attached file: ${f.name} ---\n${f.text}`)
      .join("\n\n");
    return { ...m, content: `${blocks}\n\n${m.content}` };
  });
}

// ------------------------------------------------- openai translation

/** Translate Ollama-shaped messages into OpenAI chat format. Images
 *  ride inside a content-parts array as data URIs rather than a sibling
 *  `images` field, and tool arguments are JSON strings, not objects. */
export function toOpenAI(raw: WireMsg[]): unknown[] {
  return raw.map((m) => {
    const base: Record<string, unknown> = { role: m.role };
    if (m.role === "tool") {
      base.content = m.content;
      // Servers reject a tool result with no call to attach it to.
      base.tool_call_id = m.tool_call_id ?? "call_0";
      return base;
    }
    if (m.images?.length) {
      base.content = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...m.images.map((b64) => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${b64}` },
        })),
      ];
    } else {
      base.content = m.content;
    }
    if (m.tool_calls?.length) {
      base.tool_calls = m.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: "function",
        function: {
          name: tc.function?.name ?? "",
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        },
      }));
    }
    return base;
  });
}

export interface ToolCallFragment {
  id?: string;
  name: string;
  args: string;
}

/** Streamed tool calls arrive as fragments keyed by index — the name in
 *  one chunk, arguments spread across many. */
export function parseToolCalls(
  acc: Map<number, ToolCallFragment>,
): ToolCall[] {
  const out: ToolCall[] = [];
  for (const [, tc] of acc) {
    if (!tc.name) continue;
    let args: Record<string, unknown> = {};
    try {
      args = tc.args ? JSON.parse(tc.args) : {};
    } catch {
      // A model can emit malformed JSON; treat it as no arguments
      // rather than failing the whole reply.
      args = {};
    }
    out.push({ id: tc.id, function: { name: tc.name, arguments: args } });
  }
  return out;
}

/** Fold one streamed OpenAI delta into the running accumulators. Split
 *  out from the network loop so chunk-boundary behaviour is testable. */
export function applyDelta(
  delta: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  },
  acc: Map<number, ToolCallFragment>,
): { text: string; thinking: boolean } {
  const thinking = !!(delta.reasoning_content || delta.reasoning);
  for (const tc of delta.tool_calls ?? []) {
    const i = tc.index ?? 0;
    const cur = acc.get(i) ?? { name: "", args: "" };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    acc.set(i, cur);
  }
  return { text: delta.content ?? "", thinking };
}

/** Pull complete lines out of a streaming buffer, returning the
 *  remainder. Shared by both clients so a chunk boundary landing
 *  mid-line cannot corrupt either one. */
export function takeLines(buffer: string): {
  lines: string[];
  rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

/** Decode one SSE line. Returns null for keep-alives, comments, and the
 *  terminating [DONE] sentinel. */
export function parseSSELine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const body = trimmed.slice(5).trim();
  if (!body || body === "[DONE]") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
