import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";
import { execFile } from "child_process";
import * as os from "os";
import { readFile } from "fs/promises";
import {
  Attachment,
  ChatMessage,
  Hardware,
  ModelInfo,
  SearchProvider,
  SearchSource,
  ToolCall,
  WireMsg,
  applyDelta,
  clampContext,
  fitVerdict,
  formatBytes,
  docxTextFromXml,
  docxTextParts,
  findZipEntry,
  listZipEntries,
  inflateRaw,
  isBinary,
  normalizeUrl,
  pageLabel,
  parseBrave,
  parseLmStudioModels,
  parseLspci,
  parseNvidiaSmi,
  parseOllamaShow,
  parseSearxng,
  pdfTextFromContent,
  parseSystemProfiler,
  parseSSELine,
  parseToolCalls,
  takeLines,
  titleFrom,
  toBase64,
  toOpenAI,
  trimToBudget,
  usage,
  usageLevel,
  withAttachments,
} from "./lib";
import logoSvg from "../assets/hephaestus_logo.svg";

// ---------------------------------------------------------------- types

/** Which backend to talk to. Ollama and LM Studio speak different
 *  protocols — Ollama has /api/chat, LM Studio is OpenAI-compatible on
 *  /v1/chat/completions — so the provider picks an API, not just a URL. */
type Provider = "ollama" | "lmstudio" | "custom";
type ApiKind = "ollama" | "openai";

interface HephSettings {
  provider: Provider;
  ollamaUrl: string;
  lmStudioUrl: string;
  customUrl: string;
  customApi: ApiKind;
  model: string;
  webSearch: boolean;
  think: boolean;
  readNote: boolean;
  /** Ask before the model writes into a note. */
  confirmWrites: boolean;
  /** Context window in tokens, used for the usage gauge and trimming. */
  contextTokens: number;
  /** Read the context window from the model instead of the setting. */
  autoContext: boolean;
  /** Which web-search backend to use. */
  searchProvider: SearchProvider;
  /** Base URL of a self-hosted SearXNG instance. */
  searxngUrl: string;
  /** Brave Search API key. Stored in plain text in the vault. */
  braveKey: string;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  messages: ChatMessage[];
}

interface HephData {
  settings: HephSettings;
  conversations: Conversation[];
}

const DEFAULT_DATA: HephData = {
  settings: {
    provider: "ollama",
    ollamaUrl: "http://localhost:11434",
    lmStudioUrl: "http://localhost:1234",
    customUrl: "",
    customApi: "ollama",
    model: "",
    webSearch: false,
    think: false,
    readNote: false,
    confirmWrites: true,
    contextTokens: 8192,
    autoContext: true,
    searchProvider: "duckduckgo",
    searxngUrl: "",
    braveKey: "",
  },
  conversations: [],
};

const VIEW_TYPE = "hephaestus-chat";
const SYSTEM_PROMPT =
  "You are Hephaestus, a helpful AI assistant running inside the user's" +
  " Obsidian vault via a local Ollama model. Answer clearly and use" +
  " Markdown formatting where it helps.";
const SEARCH_PROMPT =
  "Web search results for the user's request are below. Use them to give" +
  " an accurate, up-to-date answer and cite sources inline with bracketed" +
  " numbers like [1] matching the result numbers.";

const WRITE_TOOL = {
  type: "function",
  function: {
    name: "write_to_note",
    description:
      "Append markdown text to the note the user currently has open in" +
      " Obsidian. Use only when the user asks you to write, insert, add," +
      " or save content into their note.",
    parameters: {
      type: "object",
      required: ["content"],
      properties: {
        content: {
          type: "string",
          description: "The markdown to append to the note",
        },
      },
    },
  },
};

// --------------------------------------------------------------- plugin

export default class HephaestusPlugin extends Plugin {
  data: HephData = structuredClone(DEFAULT_DATA);
  private lastMdFile: TFile | null = null;

  /** Load saved data, register the view, ribbon icon, command, and
   *  settings tab. */
  async onload() {
    const stored = (await this.loadData()) as Partial<HephData> | null;
    this.data = {
      settings: { ...DEFAULT_DATA.settings, ...(stored?.settings ?? {}) },
      conversations: stored?.conversations ?? [],
    };

    // "custom" is the unreleased cloud provider. It is no longer
    // selectable, so anyone left on it from an earlier build would have
    // a server they cannot reach and no way back — move them to Ollama.
    if (this.data.settings.provider === "custom") {
      this.data.settings.provider = "ollama";
      await this.persist();
    }

    // Track the note the user last had focused, so "the active note"
    // still means their note while the chat pane itself has focus.
    const noteChanged = () => {
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension === "md") this.lastMdFile = f;
    };
    noteChanged();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", noteChanged),
    );

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("flame", "Open Hephaestus chat", () =>
      this.activateView(),
    );
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });
    this.addSettingTab(new HephSettingTab(this.app, this));
  }

  async onunload() {
    await this.persist();
  }

  /** Write settings and conversations back to disk. Images live in
   *  their own files, so this stays small and cheap to rewrite. */
  async persist() {
    await this.saveData(this.data);
  }

  /** Reveal the chat pane, creating it in the right sidebar if it is
   *  not open yet. */
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ---------------------------------------------------- active note io

  /** The markdown note the user most recently had open, if it still
   *  exists in the vault. */
  activeNote(): TFile | null {
    const f = this.lastMdFile;
    if (!f) return null;
    const still = this.app.vault.getAbstractFileByPath(f.path);
    return still instanceof TFile ? still : null;
  }

  /** Write markdown into the active note: at the cursor when its editor
   *  is open (and atCursor is requested), otherwise appended. */
  async writeToNote(
    content: string,
    atCursor: boolean,
  ): Promise<{ ok: boolean; detail: string }> {
    const file = this.activeNote();
    if (!file) {
      return { ok: false, detail: "No markdown note is open" };
    }
    if (atCursor) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (
          view instanceof MarkdownView &&
          view.file?.path === file.path
        ) {
          view.editor.replaceSelection(content);
          return {
            ok: true,
            detail: `Inserted into ${file.basename} at the cursor`,
          };
        }
      }
    }
    await this.app.vault.append(file, `\n${content}\n`);
    return { ok: true, detail: `Appended to ${file.basename}` };
  }

  // -------------------------------------------------------- hardware

  private hardwareCache: Hardware | null = null;

  /** Inspect the machine, in the spirit of llmfit: what CPU, how much
   *  RAM, which GPU and how much video memory. Cached because the GPU
   *  probe shells out. */
  async hardware(refresh = false): Promise<Hardware> {
    if (this.hardwareCache && !refresh) return this.hardwareCache;
    const cpus = os.cpus();
    const hw: Hardware = {
      cpu: cpus[0]?.model?.trim() || "Unknown CPU",
      cores: cpus.length,
      ramTotal: os.totalmem(),
      ramFree: os.freemem(),
      gpu: null,
      vram: null,
      unified: false,
      platform: process.platform,
    };

    // macOS: system_profiler is authoritative and also tells us whether
    // the GPU shares system memory (Apple silicon) or has its own.
    if (process.platform === "darwin") {
      const mac = await this.runSystemProfiler();
      if (mac) {
        hw.gpu = mac.name;
        hw.vram = mac.vram;
        hw.unified = mac.unified;
      }
    }

    // NVIDIA on Windows and Linux: nvidia-smi reports real VRAM.
    if (!hw.gpu) {
      const smi = await this.runNvidiaSmi();
      if (smi) {
        hw.gpu = smi.name;
        hw.vram = smi.vram;
      }
    }

    // Linux AMD: the kernel exposes VRAM through sysfs, no tool needed.
    if (!hw.vram && process.platform === "linux") {
      const amd = await this.readAmdSysfs();
      if (amd) hw.vram = amd;
      if (!hw.gpu) hw.gpu = await this.runLspci();
    }

    // Last resort everywhere: the renderer string names the card but
    // never its memory, so VRAM stays unknown rather than guessed.
    if (!hw.gpu) hw.gpu = this.webglRenderer();

    // An integrated GPU with no dedicated memory is effectively unified
    // too — treat it that way so the fit verdict is not nonsense.
    if (!hw.vram && hw.gpu && /Apple M\d|Radeon \d{3}M|Iris|UHD Graphics/i.test(hw.gpu)) {
      hw.unified = true;
    }

    this.hardwareCache = hw;
    return hw;
  }

  /** macOS GPU probe. Absent elsewhere, so ENOENT is expected. */
  private runSystemProfiler(): Promise<{
    name: string;
    vram: number | null;
    unified: boolean;
  } | null> {
    return new Promise((resolve) => {
      try {
        execFile(
          "system_profiler",
          ["SPDisplaysDataType", "-json"],
          { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => {
            resolve(err ? null : parseSystemProfiler(String(stdout)));
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  /** Linux GPU name probe, for cards nvidia-smi does not cover. */
  private runLspci(): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        execFile("lspci", [], { timeout: 3000 }, (err, stdout) => {
          resolve(err ? null : parseLspci(String(stdout)));
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** AMD cards on Linux publish total VRAM in bytes through sysfs. */
  private async readAmdSysfs(): Promise<number | null> {
    for (let card = 0; card < 4; card++) {
      try {
        const raw = await readFile(
          `/sys/class/drm/card${card}/device/mem_info_vram_total`,
          "utf8",
        );
        const bytes = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(bytes) && bytes > 0) return bytes;
      } catch {
        // No such card, or not an AMD driver — try the next one.
      }
    }
    return null;
  }

  /** NVIDIA probe for Windows and Linux; the only source that reports
   *  real VRAM on those platforms. */
  private runNvidiaSmi(): Promise<{ name: string; vram: number } | null> {
    return new Promise((resolve) => {
      try {
        // execFile, not exec: fixed argument list, no shell involved.
        execFile(
          "nvidia-smi",
          ["--query-gpu=name,memory.total", "--format=csv,noheader"],
          { timeout: 3000, windowsHide: true },
          (err, stdout) => {
            resolve(err ? null : parseNvidiaSmi(String(stdout)));
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  /** GPU name via WebGL's unmasked renderer string. */
  private webglRenderer(): string | null {
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl") ??
        canvas.getContext(
          "experimental-webgl",
        )) as WebGLRenderingContext | null;
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const name = ext
        ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
        : (gl.getParameter(gl.RENDERER) as string);
      return name ? String(name).trim() : null;
    } catch {
      return null;
    }
  }

  /** Model sizes, when the backend reports them. Ollama's /api/tags
   *  includes byte sizes; OpenAI-compatible /v1/models does not. */
  async modelSizes(): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (this.apiKind() !== "ollama") return sizes;
    try {
      const resp = await requestUrl({ url: `${this.baseUrl()}/api/tags` });
      for (const m of resp.json.models ?? []) {
        if (m?.name && typeof m.size === "number") sizes.set(m.name, m.size);
      }
    } catch {
      // No sizes just means no fit verdict.
    }
    return sizes;
  }

  // -------------------------------------------------- image attachments

  /** Where attached image bytes live. Keeping them out of data.json is
   *  what stops history from ballooning: that file is rewritten whole on
   *  every save, so a few inline screenshots would mean rewriting
   *  megabytes per message — and a crash mid-write would take the entire
   *  conversation history with it. */
  private attachmentDir(): string {
    return `${this.manifest.dir}/attachments`;
  }

  /** Persist image bytes, returning the vault-relative path to store on
   *  the message. */
  async saveImage(bytes: Uint8Array, name: string): Promise<string> {
    const dir = this.attachmentDir();
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const safe = name.replace(/[^\w.\-]+/g, "_").slice(-40);
    const path = `${dir}/${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}-${safe}`;
    await this.app.vault.adapter.writeBinary(
      path,
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    return path;
  }

  /** Read a stored image back as base64 for sending. Returns null when
   *  the file is missing, so a deleted attachment degrades to a message
   *  without its image instead of failing the whole request. */
  async loadImage(path: string): Promise<string | null> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const buf = await this.app.vault.adapter.readBinary(path);
      return toBase64(new Uint8Array(buf));
    } catch {
      return null;
    }
  }

  /** Remove a stored image. Failures are swallowed: a leftover file is
   *  harmless, but breaking the delete that triggered it is not. */
  async deleteImage(path: string) {
    try {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    } catch {
      // A leftover file is harmless; failing a delete must not break
      // the UI action that triggered it.
    }
  }

  /** Expand stored image paths into base64 for the wire. Legacy inline
   *  images (written before 0.2.0) are passed through as they are. */
  async withImages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];
    for (const m of messages) {
      const paths = (m.attachments ?? [])
        .filter((a) => a.kind === "image" && a.path)
        .map((a) => a.path as string);
      if (paths.length === 0) {
        out.push(m);
        continue;
      }
      const loaded: string[] = [];
      for (const p of paths) {
        const b64 = await this.loadImage(p);
        if (b64) loaded.push(b64);
      }
      out.push({ ...m, images: [...(m.images ?? []), ...loaded] });
    }
    return out;
  }

  // ------------------------------------------------------ ollama client

  /** Base URL of the selected backend, without a trailing slash. */
  baseUrl(): string {
    const s = this.data.settings;
    const url =
      s.provider === "ollama"
        ? s.ollamaUrl
        : s.provider === "lmstudio"
          ? s.lmStudioUrl
          : s.customUrl;
    return (url || "").trim().replace(/\/+$/, "");
  }

  /** Which protocol that backend speaks. */
  apiKind(): ApiKind {
    const s = this.data.settings;
    if (s.provider === "ollama") return "ollama";
    if (s.provider === "lmstudio") return "openai";
    return s.customApi;
  }

  /** Human label for error messages. */
  providerName(): string {
    const s = this.data.settings;
    return s.provider === "ollama"
      ? "Ollama"
      : s.provider === "lmstudio"
        ? "LM Studio"
        : "the cloud provider";
  }

  /** Model names from the active backend. Ollama reports them under
   *  /api/tags, OpenAI-compatible servers under /v1/models. */
  async listModels(): Promise<string[]> {
    if (this.data.settings.provider === "custom") {
      throw new Error("cloud providers are not supported yet");
    }
    const base = this.baseUrl();
    if (!base) throw new Error("No server URL is configured");
    if (this.apiKind() === "openai") {
      // OpenAI-compatible: { data: [{ id: "model-name" }, …] }
      const resp = await requestUrl({ url: `${base}/v1/models` });
      return (resp.json.data ?? [])
        .map((m: { id: string }) => m.id)
        .filter(Boolean);
    }
    const resp = await requestUrl({ url: `${base}/api/tags` });
    return (resp.json.models ?? []).map((m: { name: string }) => m.name);
  }

  /** Ask the backend what it knows about a model: context length above
   *  all, since the gauge and trimming are meaningless without it.
   *  Returns nulls rather than throwing — this is best-effort. */
  async modelInfo(model: string): Promise<ModelInfo> {
    const none: ModelInfo = {
      contextLength: null,
      parameterSize: null,
      quantization: null,
    };
    const base = this.baseUrl();
    if (!model || !base) return none;
    try {
      if (this.apiKind() === "ollama") {
        const resp = await requestUrl({
          url: `${base}/api/show`,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({ model }),
          throw: false,
        });
        if (resp.status >= 400) return none;
        return parseOllamaShow(resp.json);
      }
      // LM Studio's own REST API reports context length; the
      // OpenAI-compatible surface does not. Absent on other servers,
      // which simply means no detection.
      const resp = await requestUrl({
        url: `${base}/api/v0/models`,
        throw: false,
      });
      if (resp.status >= 400) return none;
      return parseLmStudioModels(resp.json, model);
    } catch {
      return none;
    }
  }

  /** Detect and apply the model's context window, unless the user has
   *  taken manual control. Returns what it detected, for the UI. */
  async syncContextLength(model: string): Promise<ModelInfo> {
    const info = await this.modelInfo(model);
    if (!this.data.settings.autoContext || !info.contextLength) return info;
    const next = clampContext(info.contextLength);
    if (next > 0 && next !== this.data.settings.contextTokens) {
      this.data.settings.contextTokens = next;
      await this.persist();
    }
    return info;
  }

  /** Reload the model dropdown in any open chat pane — the server may
   *  have changed under it. */
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ChatView) void view.loadModels();
    }
  }

  /** Chat with tool support: loops model -> write_to_note -> model until
   *  a plain-text answer. Falls back to non-streaming requestUrl when
   *  fetch is blocked by CORS, and drops think/tools flags for models
   *  that do not support them. */
  async chat(
    model: string,
    messages: ChatMessage[],
    think: boolean,
    onToken: (t: string) => void,
    onThinking: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const note = this.activeNote();
    let system = SYSTEM_PROMPT;
    if (note) {
      system +=
        ` The user's currently open note is "${note.basename}". You can` +
        " call write_to_note to append markdown to it — but only when the" +
        " user asks you to write, insert, add, or save something into" +
        " their note.";
    }
    const raw: WireMsg[] = [
      { role: "system", content: system },
    ];
    if (note && this.data.settings.readNote) {
      let text = await this.app.vault.cachedRead(note);
      if (text.length > 12_000) {
        text = text.slice(0, 12_000) + "\n… [note truncated]";
      }
      raw.push({
        role: "system",
        content:
          `Content of the user's open note "${note.basename}":` +
          `\n\n${text}`,
      });
    }
    raw.push(...messages);
    let withTools = !!note;
    let withThink = think;

    for (let round = 0; round < 4; round++) {
      let res: { content: string; toolCalls: ToolCall[] };
      for (;;) {
        try {
          res = await this.completeOnce(
            model, raw, withThink, withTools, onToken, onThinking, signal,
          );
          break;
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          const msg = String((err as Error).message ?? "").toLowerCase();
          if (withTools && msg.includes("tool")) {
            withTools = false; // model can't call tools; chat still works
            continue;
          }
          if (withThink && msg.includes("think")) {
            withThink = false;
            new Notice("Hephaestus: this model does not support thinking");
            continue;
          }
          throw err;
        }
      }

      if (res.toolCalls.length === 0) return;
      raw.push({
        role: "assistant",
        content: res.content,
        tool_calls: res.toolCalls,
      });
      for (const tc of res.toolCalls) {
        let outcome: string;
        if (tc.function?.name === "write_to_note") {
          const content = String(tc.function.arguments?.content ?? "");
          if (content.trim()) {
            const target = this.activeNote();
            const approved =
              !this.data.settings.confirmWrites ||
              (await new ConfirmWriteModal(
                this.app,
                content,
                target?.basename ?? "your note",
              ).ask());
            if (!approved) {
              // Tell the model plainly, so it reports the refusal
              // instead of silently retrying the same write.
              outcome = "The user declined this write. Do not retry it.";
              new Notice("Hephaestus: write declined");
            } else {
              const r = await this.writeToNote(content, false);
              outcome = r.ok ? r.detail : `Error: ${r.detail}`;
              new Notice(`Hephaestus: ${r.detail}`);
            }
          } else {
            outcome = "Error: content was empty";
          }
        } else {
          outcome = `Error: unknown tool ${tc.function?.name ?? "?"}`;
        }
        raw.push({
          role: "tool",
          content: outcome,
          ...(tc.id ? { tool_call_id: tc.id } : {}),
        });
      }
    }
  }

  /** One round-trip to the model. Streams over fetch when CORS allows,
   *  and falls back to a single non-streaming requestUrl when it does
   *  not. Dispatches to the OpenAI client when that API is selected. */
  private async completeOnce(
    model: string,
    raw: WireMsg[],
    think: boolean,
    withTools: boolean,
    onToken: (t: string) => void,
    onThinking: () => void,
    signal: AbortSignal,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    if (this.apiKind() === "openai") {
      return this.completeOpenAI(
        model, raw, withTools, onToken, onThinking, signal,
      );
    }
    const url = `${this.baseUrl()}/api/chat`;
    const payload = (stream: boolean) =>
      JSON.stringify({
        model,
        stream,
        ...(think ? { think: true } : {}),
        ...(withTools ? { tools: [WRITE_TOOL] } : {}),
        messages: raw,
      });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload(true),
        signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(
          (await resp.text().catch(() => "")) || `HTTP ${resp.status}`,
        );
      }
      let content = "";
      const toolCalls: ToolCall[] = [];
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const taken = takeLines(buffer);
        buffer = taken.rest;
        for (const line of taken.lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line);
          if (chunk.message?.thinking) onThinking();
          const token = chunk.message?.content ?? "";
          if (token) {
            content += token;
            onToken(token);
          }
          for (const tc of chunk.message?.tool_calls ?? []) {
            toolCalls.push(tc);
          }
        }
      }
      return { content, toolCalls };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      const msg = String((err as Error).message ?? "").toLowerCase();
      // Capability errors bubble up so chat() can retry without the flag.
      if (msg.includes("tool") || msg.includes("think")) throw err;
      // CORS or network-layer failure: retry without streaming.
      const resp = await requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: payload(false),
        throw: false,
      });
      if (resp.status >= 400) {
        throw new Error(resp.text || `HTTP ${resp.status}`);
      }
      const message = resp.json.message ?? {};
      const text = message.content ?? "";
      if (text) onToken(text);
      return { content: text, toolCalls: message.tool_calls ?? [] };
    }
  }

  // ------------------------------------------- openai-compatible client

  private async completeOpenAI(
    model: string,
    raw: WireMsg[],
    withTools: boolean,
    onToken: (t: string) => void,
    onThinking: () => void,
    signal: AbortSignal,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const url = `${this.baseUrl()}/v1/chat/completions`;
    const payload = (stream: boolean) =>
      JSON.stringify({
        model,
        stream,
        ...(withTools ? { tools: [WRITE_TOOL] } : {}),
        messages: toOpenAI(raw),
      });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload(true),
        signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(
          (await resp.text().catch(() => "")) || `HTTP ${resp.status}`,
        );
      }
      let content = "";
      const acc = new Map<
        number,
        { id?: string; name: string; args: string }
      >();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const taken = takeLines(buffer);
        buffer = taken.rest;
        for (const line of taken.lines) {
          // Server-sent events: "data: {...}", ending with "data: [DONE]".
          const chunk = parseSSELine(line) as {
            choices?: { delta?: Parameters<typeof applyDelta>[0] }[];
          } | null;
          if (!chunk) continue;
          // Reasoning models stream their scratchpad separately; show
          // the thinking indicator but keep it out of the reply.
          const r = applyDelta(chunk.choices?.[0]?.delta ?? {}, acc);
          if (r.thinking) onThinking();
          if (r.text) {
            content += r.text;
            onToken(r.text);
          }
        }
      }
      return { content, toolCalls: parseToolCalls(acc) };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      const msg = String((err as Error).message ?? "").toLowerCase();
      if (msg.includes("tool")) throw err;
      // CORS or network failure: retry without streaming.
      const resp = await requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: payload(false),
        throw: false,
      });
      if (resp.status >= 400) {
        throw new Error(resp.text || `HTTP ${resp.status}`);
      }
      const message = resp.json.choices?.[0]?.message ?? {};
      const text = message.content ?? "";
      if (text) onToken(text);
      const acc = new Map<
        number,
        { id?: string; name: string; args: string }
      >();
      (message.tool_calls ?? []).forEach(
        (
          tc: {
            id?: string;
            function?: { name?: string; arguments?: string };
          },
          i: number,
        ) =>
          acc.set(i, {
            id: tc.id,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          }),
      );
      return { content: text, toolCalls: parseToolCalls(acc) };
    }
  }

  // -------------------------------------------------------- web search

  /** Fetch a page and reduce it to readable text. Shared by web search
   *  and the "attach a web page" action. Returns null when unreachable. */
  async fetchPage(
    url: string,
    limit = 3000,
  ): Promise<{ title: string; text: string } | null> {
    try {
      const resp = await requestUrl({
        url,
        headers: { "User-Agent": "Mozilla/5.0" },
        throw: false,
      });
      if (resp.status >= 400) return null;
      const doc = new DOMParser().parseFromString(resp.text, "text/html");
      const title = doc.querySelector("title")?.textContent ?? "";
      // Strip chrome so the model sees prose, not navigation.
      doc
        .querySelectorAll("script,style,nav,header,footer,aside,noscript")
        .forEach((el) => el.remove());
      const root = doc.querySelector("main, article") ?? doc.body;
      const text = (root?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
      return { title: title.trim(), text };
    } catch {
      return null;
    }
  }

  /** Run the query against whichever backend is configured. Returns null
   *  when the search itself is unreachable, as opposed to an empty array
   *  for "no results". */
  private async searchSources(query: string): Promise<SearchSource[] | null> {
    const s = this.data.settings;
    const q = query.slice(0, 400);
    try {
      if (s.searchProvider === "searxng") {
        const base = s.searxngUrl.trim().replace(/\/+$/, "");
        if (!base) return null;
        // Requires `formats: [html, json]` in the instance's settings.yml,
        // which most public instances leave disabled.
        const resp = await requestUrl({
          url: `${base}/search?q=${encodeURIComponent(q)}&format=json`,
          headers: { "User-Agent": "Mozilla/5.0" },
          throw: false,
        });
        if (resp.status >= 400) return null;
        return parseSearxng(resp.json);
      }
      if (s.searchProvider === "brave") {
        if (!s.braveKey.trim()) return null;
        const resp = await requestUrl({
          url:
            "https://api.search.brave.com/res/v1/web/search?count=6&q=" +
            encodeURIComponent(q),
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": s.braveKey.trim(),
          },
          throw: false,
        });
        if (resp.status >= 400) return null;
        return parseBrave(resp.json);
      }
      return await this.searchDuckDuckGo(q);
    } catch {
      return null;
    }
  }

  /** DuckDuckGo has no free API, so this scrapes their HTML endpoint —
   *  the fragile default that needs no configuration. */
  private async searchDuckDuckGo(
    query: string,
  ): Promise<SearchSource[] | null> {
    let html: string;
    try {
      const resp = await requestUrl({
        url:
          "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      html = resp.text;
    } catch {
      return null;
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    const sources: SearchSource[] = [];
    const anchors = Array.from(doc.querySelectorAll("a.result__a"));
    const snippets = Array.from(
      doc.querySelectorAll(".result__snippet"),
    );
    for (let i = 0; i < anchors.length && sources.length < 6; i++) {
      const a = anchors[i] as HTMLAnchorElement;
      let target = a.getAttribute("href") ?? "";
      // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<url>
      const m = target.match(/[?&]uddg=([^&]+)/);
      if (m) target = decodeURIComponent(m[1]);
      if (!target.startsWith("http")) continue;
      sources.push({
        title: a.textContent?.trim() ?? target,
        url: target,
        snippet: snippets[i]?.textContent?.trim() ?? "",
      });
    }
    return sources;
  }

  /** Search, then read the top pages, producing numbered context the
   *  model can cite. Returns null when search itself failed. */
  async webSearch(
    query: string,
  ): Promise<{ sources: SearchSource[]; context: string } | null> {
    const sources = await this.searchSources(query);
    if (sources === null) return null;
    if (sources.length === 0) return { sources: [], context: "" };

    // Only the first few are worth the round-trip; the rest still get
    // cited from their snippets.
    const pages = await Promise.all(
      sources.slice(0, 3).map((s) => this.fetchPage(s.url)),
    );

    const context = sources
      .map((s, i) => {
        const body = pages[i]?.text || s.snippet;
        return `[${i + 1}] ${s.title}\nURL: ${s.url}\nContent: ${body}`;
      })
      .join("\n\n");
    return { sources, context };
  }
}

/** What the context gauge shows when clicked: where every token is
 *  going, so a full window is diagnosable rather than just alarming. */
class ContextModal extends Modal {
  private info: {
    usage: ReturnType<typeof usage>;
    messages: number;
    images: number;
    noteName: string | null;
  };

  constructor(app: App, info: ContextModal["info"]) {
    super(app);
    this.info = info;
  }

  onOpen() {
    const { usage: u, messages, images, noteName } = this.info;
    this.titleEl.setText("Context window");

    const pct = Math.round(u.ratio * 100);
    const level = usageLevel(u.ratio);
    const head = this.contentEl.createDiv({ cls: `heph-ctx-head ${level}` });
    head.createDiv({ cls: "heph-ctx-pct", text: `${pct}%` });
    head.createDiv({
      cls: "heph-ctx-sub",
      text:
        `~${u.total.toLocaleString()} of ${u.limit.toLocaleString()} tokens`,
    });

    const bar = this.contentEl.createDiv({ cls: `heph-ctx-bar ${level}` });
    bar.createDiv({ cls: "heph-ctx-fill" }).style.width =
      `${Math.min(pct, 100)}%`;

    const rows: [string, number, string][] = [
      ["System prompt", u.system, ""],
      [
        "Open note",
        u.note,
        noteName
          ? noteName
          : "not sent — enable “read the active note” in settings",
      ],
      [
        "Conversation",
        u.messages,
        `${messages} message${messages === 1 ? "" : "s"}` +
          (images ? `, ${images} image${images === 1 ? "" : "s"}` : ""),
      ],
      ["Unsent draft", u.draft, ""],
    ];
    const table = this.contentEl.createEl("table", { cls: "heph-ctx-table" });
    for (const [label, tokens, hint] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: label });
      tr.createEl("td", {
        cls: "heph-ctx-num",
        text: `~${tokens.toLocaleString()}`,
      });
      tr.createEl("td", { cls: "heph-ctx-hint", text: hint });
    }

    if (u.ratio >= 0.7) {
      this.contentEl.createEl("p", {
        cls: "heph-ctx-note",
        text:
          "Requests are trimmed at 70% to leave room for the reply, so" +
          " the oldest messages will be left out. Start a new chat, delete" +
          " old messages, or raise the context window to keep them.",
      });
    }

    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Counts are estimates (~4 characters per token, 800 per image)," +
        " not your model's exact tokenizer. The limit is read from the" +
        " model where the server reports it; change it under Settings →" +
        " Community plugins → Hephaestus.",
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Single-field prompt. Used for renaming a conversation and for asking
 *  for a URL to attach. */
class RenameModal extends Modal {
  private value: string;
  private onSubmit: (value: string) => void;
  private opts: { title: string; placeholder: string; cta: string };

  constructor(
    app: App,
    current: string,
    onSubmit: (value: string) => void,
    opts?: Partial<{ title: string; placeholder: string; cta: string }>,
  ) {
    super(app);
    this.value = current;
    this.onSubmit = onSubmit;
    this.opts = {
      title: opts?.title ?? "Rename conversation",
      placeholder: opts?.placeholder ?? "Conversation name",
      cta: opts?.cta ?? "Rename",
    };
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl("input", {
      cls: "heph-rename-input",
      attr: { type: "text", placeholder: this.opts.placeholder },
    });
    input.value = this.value;

    const commit = () => {
      const next = input.value.trim();
      if (!next) {
        new Notice("Hephaestus: this cannot be empty");
        return;
      }
      this.onSubmit(next);
      this.close();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.opts.cta).setCta().onClick(commit))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

    input.focus();
    input.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Confirmation for a model-initiated note write.
 *
 *  This exists because untrusted text reaches the model: web search
 *  pulls in arbitrary pages, and attachments carry arbitrary files.
 *  Either can contain instructions aimed at the model ("append this to
 *  the user's note"), and write_to_note edits the vault for real. The
 *  user sees exactly what would be written before it happens. */
class ConfirmWriteModal extends Modal {
  private content: string;
  private noteName: string;
  private resolve!: (ok: boolean) => void;
  private decided = false;

  constructor(app: App, content: string, noteName: string) {
    super(app);
    this.content = content;
    this.noteName = noteName;
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    this.titleEl.setText("Write to note?");
    this.contentEl.createEl("p", {
      text: `Hephaestus wants to append this to "${this.noteName}":`,
    });
    this.contentEl.createEl("pre", {
      cls: "heph-confirm-preview",
      text: this.content,
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Only accept if you asked for this. Web pages and attached files" +
        " can try to instruct the model to write things you did not ask" +
        " for.",
    });
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText("Write")
          .setCta()
          .onClick(() => this.finish(true)),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.finish(false)),
      );
  }

  private finish(ok: boolean) {
    this.decided = true;
    this.resolve(ok);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    // Dismissing with Esc or the X counts as a refusal, never a write.
    if (!this.decided) this.resolve(false);
  }
}

/** Fuzzy picker over every file in the vault, for attaching notes and
 *  images the user has already saved. */
class VaultFilePicker extends FuzzySuggestModal<TFile> {
  private onPick: (file: TFile) => void;

  constructor(app: App, onPick: (file: TFile) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Attach a file from your vault…");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile) {
    this.onPick(file);
  }
}

// ------------------------------------------------------------ chat view

class ChatView extends ItemView {
  private plugin: HephaestusPlugin;
  private conv: Conversation | null = null;
  private streaming = false;
  private abort: AbortController | null = null;

  private modelSelect!: HTMLSelectElement;
  private convSelect!: HTMLSelectElement;
  private messagesEl!: HTMLElement;
  private pendingEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  /** Attachments staged for the next message. Image bytes are held in
   *  memory until send, then written to disk. */
  private pending: (Attachment & { bytes?: Uint8Array })[] = [];
  private dialEl!: HTMLElement;
  private dialArc!: SVGCircleElement;
  private dialLabel!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: HephaestusPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Hephaestus";
  }
  getIcon() {
    return "flame";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("heph-root");

    const makeToggle = (
      parent: HTMLElement,
      icon: string,
      title: string,
      get: () => boolean,
      set: (v: boolean) => void,
    ) => {
      const btn = parent.createEl("button", {
        cls: "heph-toggle clickable-icon",
        attr: { "aria-label": title },
      });
      setIcon(btn, icon);
      const sync = () => btn.toggleClass("on", get());
      sync();
      btn.onclick = () => {
        set(!get());
        void this.plugin.persist();
        sync();
      };
      return btn;
    };

    const bar = root.createDiv({ cls: "heph-bar" });
    this.modelSelect = bar.createEl("select", {
      cls: "dropdown heph-model",
    });
    const newBtn = bar.createEl("button", {
      cls: "heph-new",
      text: "New",
    });
    newBtn.onclick = () => {
      this.conv = null;
      this.refreshConvList();
      this.renderMessages();
    };

    const convRow = root.createDiv({ cls: "heph-conv-row" });
    this.convSelect = convRow.createEl("select", {
      cls: "dropdown heph-conv",
    });
    this.convSelect.onchange = () => {
      const id = this.convSelect.value;
      this.conv =
        this.plugin.data.conversations.find((c) => c.id === id) ?? null;
      this.renderMessages();
    };
    // Right-click acts on the conversation currently shown, which is
    // where the user is already looking — better than a list buried in
    // settings.
    this.convSelect.oncontextmenu = (e) => this.convMenu(e);

    this.messagesEl = root.createDiv({ cls: "heph-messages" });
    this.pendingEl = root.createDiv({ cls: "heph-pending" });

    const composer = root.createDiv({ cls: "heph-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "heph-input",
      attr: { placeholder: "Message Hephaestus…", rows: "1" },
    });
    this.inputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    };
    this.inputEl.oninput = () => this.updateDial();
    const sendCol = composer.createDiv({ cls: "heph-send-col" });
    this.sendBtn = sendCol.createEl("button", {
      cls: "heph-send",
      text: "Send",
    });
    this.sendBtn.onclick = () => {
      if (this.streaming) this.abort?.abort();
      else void this.send();
    };
    const sendRow = sendCol.createDiv({ cls: "heph-send-row" });
    const attachBtn = sendRow.createEl("button", {
      cls: "heph-toggle clickable-icon",
      attr: { "aria-label": "Attach an image or file" },
    });
    setIcon(attachBtn, "paperclip");
    attachBtn.onclick = (e) => this.attachMenu(e);

    const insertBtn = sendRow.createEl("button", {
      cls: "heph-toggle clickable-icon",
      attr: { "aria-label": "Insert last reply into active note" },
    });
    setIcon(insertBtn, "file-plus-2");
    insertBtn.onclick = async () => {
      const last = [...(this.conv?.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      if (!last) {
        new Notice("Hephaestus: no reply to insert yet");
        return;
      }
      const r = await this.plugin.writeToNote(last.content, true);
      new Notice(`Hephaestus: ${r.detail}`);
    };

    const modeRow = sendCol.createDiv({ cls: "heph-send-row" });
    makeToggle(
      modeRow,
      "globe",
      "Web search",
      () => this.plugin.data.settings.webSearch,
      (v) => (this.plugin.data.settings.webSearch = v),
    );
    makeToggle(
      modeRow,
      "brain",
      "Thinking mode",
      () => this.plugin.data.settings.think,
      (v) => (this.plugin.data.settings.think = v),
    );

    // The gauge gets the whole row. There is no settings shortcut here:
    // opening the settings tab from a plugin needs app.setting, which is
    // a private Obsidian API.
    const attachRow = sendCol.createDiv({ cls: "heph-send-row" });
    this.buildDial(attachRow);

    this.refreshConvList();
    this.renderMessages();
    await this.loadModels();
  }

  async onClose() {
    this.abort?.abort();
    await this.plugin.persist();
  }

  /** Populate the model dropdown from the server, keeping the saved
   *  choice selected when it still exists there. */
  async loadModels() {
    try {
      const models = await this.plugin.listModels();
      this.modelSelect.empty();
      for (const name of models) {
        this.modelSelect.createEl("option", { text: name, value: name });
      }
      if (models.length === 0) {
        new Notice(
          `Hephaestus: ${this.plugin.providerName()} returned no models` +
            " — load one there first",
        );
      }
      const preferred = this.plugin.data.settings.model;
      if (preferred && models.includes(preferred)) {
        this.modelSelect.value = preferred;
      } else if (preferred && models.length > 0) {
        // The saved model is gone — pulled, renamed, or the server
        // changed. Fall back rather than leaving a dead selection that
        // fails only once the user hits Send.
        this.plugin.data.settings.model = this.modelSelect.value;
        await this.plugin.persist();
        new Notice(
          `Hephaestus: "${preferred}" is no longer available — ` +
            `using ${this.modelSelect.value}`,
          6000,
        );
      }
      // Pick up the real context window for whatever ended up selected.
      if (this.modelSelect.value) {
        await this.plugin.syncContextLength(this.modelSelect.value);
        this.updateDial();
      }
      this.modelSelect.onchange = async () => {
        this.plugin.data.settings.model = this.modelSelect.value;
        await this.plugin.persist();
        // A different model usually means a different context window.
        await this.plugin.syncContextLength(this.modelSelect.value);
        this.updateDial();
      };
    } catch {
      this.modelSelect.empty();
      new Notice(
        `Hephaestus: cannot reach ${this.plugin.providerName()} at ` +
          (this.plugin.baseUrl() || "(no URL set)"),
      );
    }
  }

  /** Rename/delete menu for the selected conversation. */
  private convMenu(evt: MouseEvent) {
    evt.preventDefault();
    const conv = this.conv;
    const menu = new Menu();
    if (!conv) {
      menu.addItem((i) =>
        i.setTitle("No conversation selected").setIcon("info").setDisabled(true),
      );
      menu.showAtMouseEvent(evt);
      return;
    }

    menu.addItem((i) =>
      i
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(() =>
          new RenameModal(this.app, conv.title, async (name) => {
            conv.title = name;
            conv.updatedAt = Date.now();
            await this.plugin.persist();
            this.refreshConvList();
          }).open(),
        ),
    );

    menu.addItem((i) =>
      i
        .setTitle("Delete conversation")
        .setIcon("trash-2")
        .onClick(() => void this.deleteConversation(conv)),
    );

    menu.showAtMouseEvent(evt);
  }

  /** Remove a whole conversation and the image files it owned. */
  private async deleteConversation(conv: Conversation) {
    if (this.streaming) {
      new Notice("Hephaestus: stop the reply before deleting");
      return;
    }
    for (const m of conv.messages) {
      for (const a of m.attachments ?? []) {
        if (a.kind === "image" && a.path) {
          await this.plugin.deleteImage(a.path);
        }
      }
    }
    this.plugin.data.conversations.remove(conv);
    if (this.conv === conv) this.conv = null;
    await this.plugin.persist();
    this.refreshConvList();
    this.renderMessages();
    new Notice(`Hephaestus: deleted "${conv.title}"`);
  }

  /** Rebuild the conversation dropdown, newest first. */
  private refreshConvList() {
    this.convSelect.empty();
    const convs = [...this.plugin.data.conversations].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    // No active conversation: show a non-selectable placeholder label
    // ("New" button starts fresh chats; the dropdown only picks
    // existing ones).
    if (!this.conv) {
      this.convSelect.createEl("option", {
        text: convs.length ? "Open a conversation…" : "No conversations yet",
        value: "",
        attr: { disabled: "true", hidden: "true" },
      });
    }
    for (const c of convs) {
      this.convSelect.createEl("option", { text: c.title, value: c.id });
    }
    this.convSelect.value = this.conv?.id ?? "";
  }

  /** Redraw the whole transcript. Cheap enough at these sizes, and it
   *  keeps message actions and the context gauge in sync with state. */
  private renderMessages() {
    this.updateDial();
    this.messagesEl.empty();
    if (!this.conv || this.conv.messages.length === 0) {
      // Splash for an empty thread. renderMessages runs on every change,
      // so this clears itself the moment a first message exists.
      const empty = this.messagesEl.createDiv({ cls: "heph-empty" });
      const mark = empty.createDiv({ cls: "heph-empty-logo" });
      const doc = new DOMParser().parseFromString(logoSvg, "image/svg+xml");
      const svg = doc.documentElement;
      if (svg && svg.nodeName.toLowerCase() === "svg") {
        // importNode: the parsed node belongs to another document.
        mark.appendChild(document.importNode(svg, true));
      }
      empty.createDiv({
        cls: "heph-empty-text",
        text: "Chat with your AI in Obsidian.",
      });
      return;
    }
    for (const msg of this.conv.messages) {
      void this.renderMessage(msg);
    }
    this.scrollToBottom();
  }

  /** Render one message: plain text for the user, Markdown for the
   *  assistant, plus the edit/redo/delete controls. Returns the body
   *  element so a streaming reply can be updated in place. */
  private async renderMessage(msg: ChatMessage): Promise<HTMLElement> {
    const row = this.messagesEl.createDiv({
      cls: `heph-msg ${msg.role}`,
    });
    const body = row.createDiv({ cls: "heph-msg-body" });
    if (msg.role === "user") {
      if (msg.attachments?.length) {
        const chips = body.createDiv({ cls: "heph-msg-chips" });
        for (const att of msg.attachments) {
          const chip = chips.createDiv({ cls: "heph-chip" });
          const icon = chip.createSpan({ cls: "heph-chip-icon" });
          setIcon(icon, att.kind === "image" ? "image" : "file-text");
          chip.createSpan({ cls: "heph-chip-name", text: att.name });
        }
      }
      body.createDiv({ cls: "heph-msg-text", text: msg.content });
    } else {
      await MarkdownRenderer.render(this.app, msg.content, body, "", this);
    }
    // Saved messages get controls. A reply still streaming is not in
    // conv.messages yet, so it gets none — Stop cancels that instead.
    const conv = this.conv;
    if (conv?.messages.includes(msg)) {
      const actions = row.createDiv({ cls: "heph-msg-actions" });
      const action = (
        icon: string,
        label: string,
        onClick: () => void,
      ) => {
        const btn = actions.createEl("button", {
          cls: "heph-msg-action clickable-icon",
          attr: { "aria-label": label },
        });
        setIcon(btn, icon);
        btn.onclick = onClick;
        return btn;
      };

      action("pencil", "Edit", () => this.editMessage(msg, row, body));
      // Redo only on the last message: regenerating mid-thread would
      // leave every later turn answering a reply that no longer exists.
      // On a trailing question it means "ask this again" — the state you
      // land in after stopping a reply, or editing the final question.
      if (msg === conv.messages.at(-1)) {
        action(
          "refresh-cw",
          msg.role === "assistant"
            ? "Regenerate this reply"
            : "Ask this again",
          () => void this.redo(msg),
        );
      }
      action(
        "trash-2",
        msg.role === "user"
          ? "Delete this message and its reply"
          : "Delete this reply",
        () => void this.deleteMessage(msg),
      );
    }
    return body;
  }

  /** Swap a message body for a textarea, writing the edit back on save.
   *  Editing a question does not re-ask it — use redo on the reply for
   *  that, so an edit never silently discards a good answer. */
  private editMessage(
    msg: ChatMessage,
    row: HTMLElement,
    body: HTMLElement,
  ) {
    if (this.streaming) {
      new Notice("Hephaestus: stop the reply before editing");
      return;
    }
    if (row.hasClass("editing")) return;
    row.addClass("editing");
    body.hide();

    const editor = row.createDiv({ cls: "heph-edit" });
    const area = editor.createEl("textarea", { cls: "heph-edit-area" });
    area.value = msg.content;
    const buttons = editor.createDiv({ cls: "heph-edit-buttons" });
    const save = buttons.createEl("button", {
      cls: "mod-cta",
      text: "Save",
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });

    const close = () => {
      editor.remove();
      body.show();
      row.removeClass("editing");
    };
    const commit = async () => {
      const next = area.value.trim();
      if (!next) {
        new Notice("Hephaestus: a message cannot be empty");
        return;
      }
      if (next !== msg.content) {
        msg.content = next;
        const conv = this.conv;
        if (conv) {
          if (conv.messages[0] === msg) {
            conv.title = titleFrom(next);
          }
          conv.updatedAt = Date.now();
        }
        await this.plugin.persist();
        this.refreshConvList();
      }
      close();
      this.renderMessages();
    };

    save.onclick = () => void commit();
    cancel.onclick = close;
    area.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void commit();
      }
    };
    // Size to the text, then put the caret at the end.
    area.style.height = `${Math.min(area.scrollHeight + 2, 320)}px`;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** Drop the final reply and ask the model the same question again. */
  private async redo(msg: ChatMessage) {
    const conv = this.conv;
    if (!conv || this.streaming) {
      if (this.streaming) {
        new Notice("Hephaestus: already answering");
      }
      return;
    }
    if (conv.messages.at(-1) !== msg) return;
    // On a reply, drop it and re-answer the question above it. On a
    // trailing question, just answer it.
    const question =
      msg.role === "assistant" ? conv.messages.at(-2) : msg;
    if (question?.role !== "user") {
      new Notice("Hephaestus: nothing to regenerate from");
      return;
    }
    if (msg.role === "assistant") conv.messages.pop();
    this.renderMessages();
    await this.stream(conv, question.content);
  }

  /** Drop a message from the current conversation. Deleting a question
   *  takes its answer with it, so no reply is left without its prompt. */
  private async deleteMessage(msg: ChatMessage) {
    const conv = this.conv;
    if (!conv || this.streaming) {
      if (this.streaming) {
        new Notice("Hephaestus: stop the reply before deleting");
      }
      return;
    }
    const i = conv.messages.indexOf(msg);
    if (i === -1) return;
    const alsoReply =
      msg.role === "user" && conv.messages[i + 1]?.role === "assistant";
    const dropped = conv.messages.splice(i, alsoReply ? 2 : 1);
    // Delete the image files those messages owned, or they accumulate
    // forever with nothing referencing them.
    for (const d of dropped) {
      for (const a of d.attachments ?? []) {
        if (a.kind === "image" && a.path) await this.plugin.deleteImage(a.path);
      }
    }

    if (conv.messages.length === 0) {
      // Nothing left: drop the conversation rather than leave an empty
      // entry cluttering the dropdown.
      this.plugin.data.conversations.remove(conv);
      this.conv = null;
    } else if (i === 0) {
      // The title came from the first message; retitle from the new one.
      conv.title = titleFrom(conv.messages[0].content);
    }
    conv.updatedAt = Date.now();
    await this.plugin.persist();
    this.refreshConvList();
    this.renderMessages();
  }

  // -------------------------------------------------- context gauge

  private static readonly DIAL_R = 9;
  private static readonly DIAL_C = 2 * Math.PI * ChatView.DIAL_R;

  /** Radial gauge showing how full the context window is. Built as raw
   *  SVG because Obsidian ships no progress-ring primitive. */
  private buildDial(parent: HTMLElement) {
    // Shares heph-toggle so it sizes exactly like the buttons above it
    // rather than by its own rules.
    this.dialEl = parent.createEl("button", {
      cls: "heph-dial heph-toggle clickable-icon",
    });
    this.dialEl.onclick = () => void this.showContext();
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.addClass("heph-dial-svg");
    const track = document.createElementNS(NS, "circle");
    const arc = document.createElementNS(NS, "circle");
    for (const c of [track, arc]) {
      c.setAttribute("cx", "12");
      c.setAttribute("cy", "12");
      c.setAttribute("r", String(ChatView.DIAL_R));
      c.setAttribute("fill", "none");
      c.setAttribute("stroke-width", "3");
      svg.appendChild(c);
    }
    track.addClass("heph-dial-track");
    arc.addClass("heph-dial-arc");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", String(ChatView.DIAL_C));
    // Start at 12 o'clock and fill clockwise.
    arc.setAttribute("transform", "rotate(-90 12 12)");
    this.dialArc = arc;
    this.dialEl.appendChild(svg);
    this.dialLabel = this.dialEl.createSpan({ cls: "heph-dial-label" });
    this.updateDial();
  }

  /** Current context usage: system prompt, the note if the AI is allowed
   *  to read it, the thread, and whatever is typed but unsent. */
  private currentUsage() {
    const note = this.plugin.activeNote();
    const noteText =
      note && this.plugin.data.settings.readNote
        ? // cachedRead is async; approximate from the file size, which is
          // close enough for a gauge and costs no I/O per keystroke.
          "x".repeat(Math.min(note.stat.size, 12_000))
        : "";
    return usage({
      system: SYSTEM_PROMPT,
      note: noteText,
      messages: this.conv?.messages ?? [],
      draft:
        this.inputEl?.value +
        this.pending.map((p) => p.text ?? "").join(""),
      limit: this.plugin.data.settings.contextTokens,
    });
  }

  /** Full breakdown of what is filling the context window. Reads the
   *  note for real here — the gauge approximates from file size to stay
   *  cheap per keystroke, but a dialog the user opened can afford I/O. */
  private async showContext() {
    const note = this.plugin.activeNote();
    const reading = !!note && this.plugin.data.settings.readNote;
    let noteText = "";
    if (reading && note) {
      noteText = await this.app.vault.cachedRead(note);
      if (noteText.length > 12_000) noteText = noteText.slice(0, 12_000);
    }
    const u = usage({
      system: SYSTEM_PROMPT,
      note: noteText,
      messages: this.conv?.messages ?? [],
      draft:
        this.inputEl.value + this.pending.map((p) => p.text ?? "").join(""),
      limit: this.plugin.data.settings.contextTokens,
    });
    const images = (this.conv?.messages ?? []).reduce(
      (n, m) =>
        n + (m.attachments ?? []).filter((a) => a.kind === "image").length,
      0,
    ) + this.pending.filter((p) => p.kind === "image").length;
    new ContextModal(this.app, {
      usage: u,
      messages: this.conv?.messages.length ?? 0,
      images,
      noteName: reading ? (note?.basename ?? null) : null,
    }).open();
  }

  /** Repaint the gauge: arc length, colour band, and tooltip. */
  private updateDial() {
    if (!this.dialArc) return;
    const u = this.currentUsage();
    const pct = Math.round(u.ratio * 100);
    const shown = Math.min(u.ratio, 1);
    this.dialArc.setAttribute(
      "stroke-dashoffset",
      String(ChatView.DIAL_C * (1 - shown)),
    );
    const level = usageLevel(u.ratio);
    this.dialEl.removeClass("ok", "warn", "danger");
    this.dialEl.addClass(level);
    this.dialLabel.setText(`${pct}%`);
    const pendingImages = this.pending.filter(
      (p) => p.kind === "image",
    ).length;
    this.dialEl.setAttr(
      "aria-label",
      `Context ${pct}% full — ~${u.total.toLocaleString()} of ` +
        `${u.limit.toLocaleString()} tokens ` +
        `(thread ${u.messages}, note ${u.note}, draft ${u.draft}` +
        (pendingImages ? `, ${pendingImages} image(s)` : "") +
        ")",
    );
  }

  // ------------------------------------------------------- attachments

  private static readonly IMAGE_EXT = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp",
  ];
  /** Text attachments are truncated so a stray large file cannot blow
   *  past the model's context window. */
  private static readonly MAX_TEXT = 20_000;

  /** Popup offering the three attachment sources. */
  private attachMenu(evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Image from computer…")
        .setIcon("image")
        .onClick(() => this.pickFromDisk("image/*", "image")),
    );
    menu.addItem((i) =>
      i
        .setTitle("File, PDF or Word doc…")
        .setIcon("file")
        .onClick(() => this.pickFromDisk("", "file")),
    );
    menu.addItem((i) =>
      i
        .setTitle("From vault…")
        .setIcon("folder-open")
        .onClick(() =>
          new VaultFilePicker(this.app, (f) => void this.addVaultFile(f))
            .open(),
        ),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Web page…")
        .setIcon("globe")
        .onClick(() =>
          new RenameModal(
            this.app,
            "",
            (value) => void this.addWebPage(value),
            {
              title: "Attach a web page",
              placeholder: "https://example.com/article",
              cta: "Fetch",
            },
          ).open(),
        ),
    );
    menu.showAtMouseEvent(evt);
  }

  /** Native file picker, staging whatever comes back. */
  private pickFromDisk(accept: string, kind: "image" | "file") {
    const input = document.body.createEl("input", {
      // Hidden via a class rather than an inline style: Obsidian's
      // review guidelines ask plugins to keep styling in CSS.
      cls: "heph-hidden-input",
      attr: { type: "file", multiple: "true", ...(accept ? { accept } : {}) },
    });
    input.onchange = async () => {
      for (const file of Array.from(input.files ?? [])) {
        const buf = await file.arrayBuffer();
        await this.stage(file.name, new Uint8Array(buf), kind);
      }
      input.remove();
      this.renderPending();
    };
    input.click();
  }

  /** Fetch a page and stage its text as an attachment, so it flows
   *  through the same path as any other file — chip, token count, and
   *  inlining into the prompt. */
  private async addWebPage(input: string) {
    const url = normalizeUrl(input);
    if (!url) {
      new Notice("Hephaestus: that does not look like a web address");
      return;
    }
    const notice = new Notice(`Hephaestus: fetching ${url}…`, 0);
    const page = await this.plugin.fetchPage(url, 20_000);
    notice.hide();
    if (!page || !page.text) {
      new Notice(
        "Hephaestus: could not read that page — it may be blocked or" +
          " rendered entirely by JavaScript",
        8000,
      );
      return;
    }
    this.pending.push({
      name: pageLabel(url, page.title),
      kind: "file",
      // Keep the URL in the text so the model can cite it.
      text: `Source: ${url}\n\n${page.text}`,
    });
    this.renderPending();
  }

  /** Stage a file already in the vault, treating known image
   *  extensions as images and everything else as text. */
  private async addVaultFile(file: TFile) {
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const kind = ChatView.IMAGE_EXT.includes(file.extension.toLowerCase())
      ? "image"
      : "file";
    await this.stage(file.name, bytes, kind);
    this.renderPending();
  }

  /** Formats we can extract text from, beyond plain text files. */
  private static readonly DOC_EXT = ["docx", "pdf"];

  /** Extract text from a document format, or null when it is not one we
   *  handle. DOCX is a ZIP of XML; PDF is parsed for text-showing
   *  operators. Both are best-effort. */
  private async extractDocument(
    name: string,
    bytes: Uint8Array,
  ): Promise<string | null> {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    try {
      if (ext === "docx") {
        // Body first, then headers, footers, and notes — reading only
        // document.xml silently drops whatever lives in those.
        const parts = docxTextParts(listZipEntries(bytes));
        if (parts.length === 0) return null;
        const chunks: string[] = [];
        for (const part of parts) {
          const entry = findZipEntry(bytes, part);
          if (!entry) continue;
          const xml =
            entry.method === 8
              ? new TextDecoder().decode(await inflateRaw(entry.data))
              : new TextDecoder().decode(entry.data);
          const text = docxTextFromXml(xml);
          if (text.trim()) chunks.push(text);
        }
        return chunks.join("\n\n");
      }
      if (ext === "pdf") {
        return await this.extractPdf(bytes);
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Walk a PDF's stream objects, inflating the compressed ones, and
   *  collect their text. Deliberately simple: it recovers prose from
   *  PDFs that store text as text, and cannot read scanned pages. */
  private async extractPdf(bytes: Uint8Array): Promise<string> {
    // Latin1 keeps byte values intact so stream offsets stay correct.
    const raw = new TextDecoder("latin1").decode(bytes);
    const chunks: string[] = [];
    const re = /stream\r?\n?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const start = m.index + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end === -1) continue;
      const header = raw.slice(Math.max(0, m.index - 400), m.index);
      const body = raw.slice(start, end);
      if (/\/FlateDecode/.test(header)) {
        try {
          const packed = Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
          // Skip the 2-byte zlib header; PDF streams are zlib-wrapped.
          const inflated = await inflateRaw(packed.subarray(2));
          chunks.push(new TextDecoder("latin1").decode(inflated));
        } catch {
          // Encrypted, damaged, or an image stream — skip it.
        }
      } else if (/\/Length/.test(header) && !/\/Image/.test(header)) {
        chunks.push(body);
      }
      re.lastIndex = end;
    }
    return chunks.map((c) => pdfTextFromContent(c)).join("\n").trim();
  }

  /** Turn raw bytes into a staged attachment, rejecting binaries we
   *  cannot represent as an image, a document, or text. */
  private async stage(
    name: string,
    bytes: Uint8Array,
    kind: "image" | "file",
  ) {
    if (kind === "image") {
      this.pending.push({ name, kind: "image", bytes });
      return;
    }
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ChatView.DOC_EXT.includes(ext)) {
      const extracted = await this.extractDocument(name, bytes);
      if (extracted && extracted.trim()) {
        this.pending.push({
          name,
          kind: "file",
          text:
            extracted.length > ChatView.MAX_TEXT
              ? extracted.slice(0, ChatView.MAX_TEXT) + "\n… [truncated]"
              : extracted,
        });
        return;
      }
      new Notice(
        `Hephaestus: could not read text from ${name}` +
          (ext === "pdf"
            ? " — scanned PDFs need OCR, which this plugin does not do"
            : ""),
        8000,
      );
      return;
    }
    const text = new TextDecoder().decode(bytes);
    // A NUL byte in the first chunk means this is not text (zip, exe, …).
    if (isBinary(text)) {
      new Notice(
        `Hephaestus: ${name} is not a text file — only images and text` +
          " files can be attached",
      );
      return;
    }
    const clipped =
      text.length > ChatView.MAX_TEXT
        ? text.slice(0, ChatView.MAX_TEXT) + "\n… [truncated]"
        : text;
    this.pending.push({ name, kind: "file", text: clipped });
  }

  /** Draw the chips for attachments staged but not yet sent. */
  private renderPending() {
    this.updateDial();
    this.pendingEl.empty();
    for (const att of this.pending) {
      const chip = this.pendingEl.createDiv({ cls: "heph-chip" });
      const icon = chip.createSpan({ cls: "heph-chip-icon" });
      setIcon(icon, att.kind === "image" ? "image" : "file-text");
      chip.createSpan({ cls: "heph-chip-name", text: att.name });
      const x = chip.createEl("button", {
        cls: "heph-chip-x clickable-icon",
        attr: { "aria-label": `Remove ${att.name}` },
      });
      setIcon(x, "x");
      x.onclick = () => {
        this.pending.remove(att);
        this.renderPending();
      };
    }
  }

  /** Pin the transcript to the newest message. */
  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Send what is typed, with any staged attachments: persist images,
   *  start or extend the conversation, then hand off to stream(). */
  private async send() {
    const text = this.inputEl.value.trim();
    const model = this.modelSelect.value;
    // An attachment on its own is a valid message — "what is this?" with
    // an image needs no typed text.
    if ((!text && this.pending.length === 0) || this.streaming || !model) {
      return;
    }
    this.inputEl.value = "";

    const staged = this.pending;
    this.pending = [];
    this.renderPending();
    // Image bytes go to disk now; only the path is kept in history.
    const attachments: Attachment[] = [];
    for (const a of staged) {
      if (a.kind === "image" && a.bytes) {
        attachments.push({
          name: a.name,
          kind: "image",
          path: await this.plugin.saveImage(a.bytes, a.name),
        });
      } else {
        attachments.push({
          name: a.name,
          kind: a.kind,
          ...(a.text ? { text: a.text } : {}),
        });
      }
    }

    if (!this.conv) {
      const label = text || staged[0]?.name || "Attachment";
      this.conv = {
        id: `${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        title: titleFrom(label),
        model,
        updatedAt: Date.now(),
        messages: [],
      };
      this.plugin.data.conversations.push(this.conv);
    }
    const conv = this.conv;
    conv.model = model;
    conv.messages.push({
      role: "user",
      content: text,
      ...(attachments.length ? { attachments } : {}),
    });
    this.refreshConvList();
    this.renderMessages();
    await this.stream(conv, text);
  }

  /** Answer the conversation as it currently stands — its last message
   *  must be the user turn being answered. Shared by send() and redo();
   *  `text` is that turn's text, used as the web-search query. */
  private async stream(conv: Conversation, text: string) {
    this.streaming = true;
    this.sendBtn.setText("Stop");
    this.abort = new AbortController();

    const reply: ChatMessage = { role: "assistant", content: "" };
    const bodyEl = await this.renderMessage(reply);
    // Animated dots + label until the first token arrives (or, in the
    // non-streaming CORS fallback, until the full reply lands).
    const thinking = bodyEl.createDiv({ cls: "heph-thinking" });
    const dots = thinking.createDiv({ cls: "heph-dots" });
    dots.createSpan();
    dots.createSpan();
    dots.createSpan();
    const statusLabel = thinking.createDiv({
      cls: "heph-thinking-label",
    });
    this.scrollToBottom();

    // Optional web search: augment what the model sees, not what we save.
    let sources: SearchSource[] = [];
    // Keep the request inside the context window, reserving room for the
    // reply itself. Trimming is announced rather than silent: a model
    // that has quietly forgotten the start of the thread just looks like
    // it got worse.
    const budget = Math.floor(this.plugin.data.settings.contextTokens * 0.7);
    const trim = trimToBudget(conv.messages, budget);
    if (trim.trimmed > 0) {
      new Notice(
        `Hephaestus: context full — leaving out the oldest ` +
          `${trim.trimmed} message(s)`,
      );
    }
    let modelMessages = await this.plugin.withImages(
      withAttachments(trim.messages),
    );
    if (this.plugin.data.settings.webSearch) {
      statusLabel.setText("Searching the web…");
      const found = await this.plugin.webSearch(text);
      if (found === null) {
        new Notice("Hephaestus: web search failed — answering without it");
      } else if (found.sources.length > 0) {
        sources = found.sources;
        modelMessages = [
          ...modelMessages.slice(0, -1),
          {
            // Spread the real message so attached images survive the
            // search rewrite.
            ...modelMessages[modelMessages.length - 1],
            role: "user",
            content:
              `${SEARCH_PROMPT}\n\n=== WEB SEARCH RESULTS ===\n` +
              `${found.context}\n=== END OF RESULTS ===\n\n` +
              `User request: ${text}`,
          },
        ];
      }
      statusLabel.setText("");
    }
    if (this.plugin.data.settings.think) {
      statusLabel.setText("");
    }

    let pending = "";
    // registerInterval ties the timer to this view's lifecycle, so it
    // cannot outlive the pane if the plugin is disabled mid-stream.
    const flush = this.registerInterval(window.setInterval(() => {
      if (!pending) return;
      reply.content += pending;
      pending = "";
      bodyEl.empty();
      void MarkdownRenderer.render(
        this.app,
        reply.content,
        bodyEl,
        "",
        this,
      ).then(() => this.scrollToBottom());
    }, 250));

    try {
      await this.plugin.chat(
        conv.model,
        modelMessages,
        this.plugin.data.settings.think,
        (t) => {
          pending += t;
        },
        () => statusLabel.setText("Thinking…"),
        this.abort.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        reply.content += `\n\n> ⚠️ ${(err as Error).message}`;
      }
    } finally {
      window.clearInterval(flush);
      reply.content += pending;
      if (reply.content && sources.length > 0) {
        reply.content +=
          "\n\n---\n**Sources**\n" +
          sources
            .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
            .join("\n");
      }
      bodyEl.empty();
      await MarkdownRenderer.render(
        this.app,
        reply.content || "*no response*",
        bodyEl,
        "",
        this,
      );
      this.scrollToBottom();
      if (reply.content) conv.messages.push(reply);
      conv.updatedAt = Date.now();
      this.streaming = false;
      this.sendBtn.setText("Send");
      this.abort = null;
      await this.plugin.persist();
      // Re-render so the finished reply gets its action buttons.
      this.renderMessages();
    }
  }
}

// ------------------------------------------------------------- settings

class HephSettingTab extends PluginSettingTab {
  private plugin: HephaestusPlugin;

  constructor(app: App, plugin: HephaestusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** What to install for better GPU detection, per platform. */
  private platformHint(): string {
    switch (process.platform) {
      case "darwin":
        return "system_profiler returned nothing";
      case "linux":
        return "install nvidia-smi, or pciutils for lspci";
      default:
        return "install nvidia-smi for VRAM detection";
    }
  }

  /** Machine specs plus, when the backend reports model sizes, whether
   *  the selected model actually fits. */
  private async renderHardware(el: HTMLElement, refresh = false) {
    el.empty();
    el.createDiv({ cls: "heph-hw-loading", text: "Reading system info…" });
    const hw = await this.plugin.hardware(refresh);
    el.empty();

    const grid = el.createDiv({ cls: "heph-hw" });
    const row = (
      icon: string,
      label: string,
      value: string,
      hint = "",
    ) => {
      const r = grid.createDiv({ cls: "heph-hw-row" });
      const i = r.createSpan({ cls: "heph-hw-icon" });
      setIcon(i, icon);
      r.createSpan({ cls: "heph-hw-label", text: label });
      const v = r.createDiv({ cls: "heph-hw-value" });
      v.createSpan({ text: value });
      if (hint) v.createSpan({ cls: "heph-hw-hint", text: hint });
    };

    row("cpu", "CPU", hw.cpu, `${hw.cores} logical cores`);
    row(
      "memory-stick",
      "RAM",
      formatBytes(hw.ramTotal),
      `${formatBytes(hw.ramFree)} free`,
    );
    const gpuHint = hw.vram
      ? `${formatBytes(hw.vram)} VRAM`
      : hw.unified
        ? // Not a detection failure: there is no separate VRAM to find.
          `Unified memory — shares the ${formatBytes(hw.ramTotal)} of RAM`
        : hw.gpu
          ? "VRAM unknown on this platform"
          : this.platformHint();
    row("monitor", "GPU", hw.gpu ?? "Not detected", gpuHint);

    // Fit verdict, when the server tells us how big the model is.
    const model = this.plugin.data.settings.model;
    if (model) {
      const sizes = await this.plugin.modelSizes();
      const size = sizes.get(model);
      if (size) {
        const fit = fitVerdict(size, hw.vram, hw.ramTotal, hw.unified);
        const box = el.createDiv({ cls: `heph-fit ${fit.level}` });
        const i = box.createSpan({ cls: "heph-fit-icon" });
        setIcon(
          i,
          fit.level === "ok"
            ? "check-circle"
            : fit.level === "warn"
              ? "alert-triangle"
              : "x-circle",
        );
        const body = box.createDiv();
        body.createDiv({
          cls: "heph-fit-title",
          text: `${model} — ${formatBytes(size)}`,
        });
        body.createDiv({ cls: "heph-fit-text", text: fit.text });
      }
    }

    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Fit is a rough guide: weights plus ~20% runtime overhead," +
        " compared against video memory first and system memory second." +
        " Real usage also depends on quantization and context length.",
    });

    new Setting(el).addButton((b) =>
      b.setButtonText("Refresh").onClick(() => {
        void this.renderHardware(el, true);
      }),
    );
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.data.settings;

    new Setting(containerEl)
      .setName("Server")
      .setDesc(
        "Which local model server to talk to. Ollama and LM Studio use" +
          " different APIs, so this picks the protocol as well as the URL.",
      )
      .addDropdown((d) =>
        d
          .addOption("ollama", "Ollama")
          .addOption("lmstudio", "LM Studio")
          // "custom" (Cloud API key) is deliberately not offered — the
          // backend for it does not exist yet. See CLAUDE.md.
          .setValue(s.provider)
          .onChange(async (value) => {
            s.provider = value as Provider;
            // Switching servers restores that server's stock URL, so a
            // leftover address from earlier experimenting cannot silently
            // point the new selection at the wrong place.
            if (s.provider === "ollama") {
              s.ollamaUrl = DEFAULT_DATA.settings.ollamaUrl;
            } else if (s.provider === "lmstudio") {
              s.lmStudioUrl = DEFAULT_DATA.settings.lmStudioUrl;
            }
            // The new server has its own model list, so the remembered
            // model is unlikely to exist there.
            s.model = "";
            await this.plugin.persist();
            this.plugin.refreshViews();
            this.display();
          }),
      );

    if (s.provider === "ollama") {
      new Setting(containerEl)
        .setName("Ollama URL")
        .setDesc("Where your local Ollama instance is listening.")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434")
            .setValue(s.ollamaUrl)
            .onChange(async (value) => {
              s.ollamaUrl =
                value.trim().replace(/\/+$/, "") || "http://localhost:11434";
              await this.plugin.persist();
            }),
        );
    } else if (s.provider === "lmstudio") {
      new Setting(containerEl)
        .setName("LM Studio URL")
        .setDesc(
          "The address of LM Studio's local server — start it from the" +
            " Developer tab. Enter the base URL without /v1.",
        )
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:1234")
            .setValue(s.lmStudioUrl)
            .onChange(async (value) => {
              s.lmStudioUrl =
                value.trim().replace(/\/+$/, "") || "http://localhost:1234";
              await this.plugin.persist();
            }),
        );
    } else {
      const warning = containerEl.createDiv({ cls: "heph-warning" });
      const icon = warning.createSpan({ cls: "heph-warning-icon" });
      setIcon(icon, "alert-triangle");
      warning.createSpan({
        text:
          "Cloud providers are a future feature and are not connected" +
          " yet. Hephaestus currently talks only to a local server —" +
          " choose Ollama or LM Studio above to keep chatting.",
      });

      new Setting(containerEl)
        .setName("API key")
        .setDesc("Not yet used. Reserved for hosted model providers.")
        .addText((text) => {
          text.setPlaceholder("sk-…").setValue("").setDisabled(true);
          text.inputEl.type = "password";
        });
    }

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Check the server is reachable and list the models it has.")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing…").setDisabled(true);
          try {
            const models = await this.plugin.listModels();
            new Notice(
              models.length
                ? `Hephaestus: connected — ${models.length} model(s): ` +
                    models.slice(0, 3).join(", ") +
                    (models.length > 3 ? "…" : "")
                : `Hephaestus: connected, but ${this.plugin.providerName()}` +
                    " has no models loaded",
              8000,
            );
            this.plugin.refreshViews();
          } catch (err) {
            new Notice(
              `Hephaestus: cannot reach ${this.plugin.providerName()} at ` +
                `${this.plugin.baseUrl() || "(no URL set)"} — ` +
                (err as Error).message,
              8000,
            );
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        }),
      );

    containerEl.createEl("h3", { text: "System" });
    const sysEl = containerEl.createDiv();
    void this.renderHardware(sysEl);

    containerEl.createEl("h3", { text: "Model context" });

    new Setting(containerEl)
      .setName("Detect context window automatically")
      .setDesc(
        "Read the context length from the model itself. Ollama reports" +
          " it via /api/show; LM Studio via its native API. Turn this off" +
          " to set the number by hand.",
      )
      .addToggle((t) =>
        t.setValue(s.autoContext).onChange(async (value) => {
          s.autoContext = value;
          await this.plugin.persist();
          if (value && s.model) {
            const info = await this.plugin.syncContextLength(s.model);
            new Notice(
              info.contextLength
                ? `Hephaestus: detected ${s.contextTokens.toLocaleString()}` +
                    " tokens"
                : "Hephaestus: this server does not report a context length",
              6000,
            );
          }
          this.plugin.refreshViews();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Context window (tokens)")
      .setDesc(
        s.autoContext
          ? "Detected from the selected model. Turn off auto-detect to" +
              " override."
          : "Used by the gauge and to trim old messages before a request" +
              " overflows. Match your model's real context length.",
      )
      .addText((text) => {
        text
          .setPlaceholder("8192")
          .setValue(String(s.contextTokens))
          .setDisabled(s.autoContext)
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            s.contextTokens = Number.isFinite(n) && n > 0 ? n : 8192;
            await this.plugin.persist();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Let the AI read the active note")
      .setDesc("Sends the open note along with your message.")
      .addToggle((t) =>
        t.setValue(s.readNote).onChange(async (value) => {
          s.readNote = value;
          await this.plugin.persist();
          this.plugin.refreshViews();
        }),
      );

    containerEl.createEl("h3", { text: "Web search" });

    new Setting(containerEl)
      .setName("Search provider")
      .setDesc(
        "Used by the globe toggle in the chat pane. DuckDuckGo needs no" +
          " setup but is scraped from HTML, so it can break without" +
          " warning; the others return JSON and are more reliable.",
      )
      .addDropdown((d) =>
        d
          .addOption("duckduckgo", "DuckDuckGo (no setup)")
          .addOption("searxng", "SearXNG (self-hosted)")
          .addOption("brave", "Brave Search API (key)")
          .setValue(s.searchProvider)
          .onChange(async (value) => {
            s.searchProvider = value as SearchProvider;
            await this.plugin.persist();
            this.display();
          }),
      );

    if (s.searchProvider === "searxng") {
      new Setting(containerEl)
        .setName("SearXNG URL")
        .setDesc(
          "Base URL of your instance. The JSON API must be enabled —" +
            " add `formats: [html, json]` to settings.yml. Most public" +
            " instances leave it off.",
        )
        .addText((t) =>
          t
            .setPlaceholder("http://localhost:8888")
            .setValue(s.searxngUrl)
            .onChange(async (value) => {
              s.searxngUrl = value.trim().replace(/\/+$/, "");
              await this.plugin.persist();
            }),
        );
    }

    if (s.searchProvider === "brave") {
      new Setting(containerEl)
        .setName("Brave Search API key")
        .setDesc(
          "Free tier allows 2,000 queries a month. Stored in plain text" +
            " in this vault's plugin data — do not use a key you would" +
            " mind leaking if the vault is synced or shared.",
        )
        .addText((t) => {
          t.setPlaceholder("BSA…")
            .setValue(s.braveKey)
            .onChange(async (value) => {
              s.braveKey = value.trim();
              await this.plugin.persist();
            });
          t.inputEl.type = "password";
        });
    }

    containerEl.createEl("h3", { text: "Safety" });

    new Setting(containerEl)
      .setName("Confirm before writing to a note")
      .setDesc(
        "Show the exact text and ask first. Web pages and attached files" +
          " can contain instructions aimed at the model, so leaving this" +
          " on is strongly recommended.",
      )
      .addToggle((t) =>
        t.setValue(s.confirmWrites).onChange(async (value) => {
          s.confirmWrites = value;
          await this.plugin.persist();
          if (!value) {
            new Notice(
              "Hephaestus: note writes will now happen without asking",
              6000,
            );
          }
        }),
      );

    new Setting(containerEl)
      .setName("Clear conversation history")
      .setDesc("Deletes all saved Hephaestus conversations in this vault.")
      .addButton((btn) =>
        btn
          .setButtonText("Clear")
          .setWarning()
          .onClick(async () => {
            // Take the stored images with it, or they linger with
            // nothing referencing them.
            for (const c of this.plugin.data.conversations) {
              for (const m of c.messages) {
                for (const a of m.attachments ?? []) {
                  if (a.kind === "image" && a.path) {
                    await this.plugin.deleteImage(a.path);
                  }
                }
              }
            }
            this.plugin.data.conversations = [];
            await this.plugin.persist();
            this.plugin.refreshViews();
            new Notice("Hephaestus: conversation history cleared");
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Streaming requires the server to allow Obsidian's origin. For" +
        " Ollama, start it with OLLAMA_ORIGINS=app://obsidian.md (see" +
        " README); for LM Studio, enable CORS in the Developer tab." +
        " Without it, replies still work but arrive all at once instead" +
        " of token by token.",
    });
  }
}
