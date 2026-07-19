import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDelta,
  clampContext,
  conversationTokens,
  estimateTokens,
  fitVerdict,
  formatBytes,
  isBinary,
  normalizeUrl,
  pageLabel,
  parseBrave,
  parseLmStudioModels,
  parseLspci,
  parseNvidiaSmi,
  parseOllamaShow,
  parseSearxng,
  parseSizeString,
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
} from "../dist/lib.mjs";

// ------------------------------------------------------------- encoding

test("toBase64 round-trips binary exactly", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x7f]);
  assert.ok(Buffer.from(toBase64(png), "base64").equals(Buffer.from(png)));
});

test("toBase64 survives a multi-megabyte image", () => {
  // A naive String.fromCharCode(...bytes) spread blows the call stack
  // here; the chunked loop must not.
  const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 256);
  const encoded = toBase64(big);
  assert.ok(Buffer.from(encoded, "base64").equals(Buffer.from(big)));
});

test("isBinary accepts text and rejects binary", () => {
  assert.equal(isBinary("# hello\nplain markdown"), false);
  assert.equal(isBinary("%PDF-1.4\0\0junk"), true);
});

test("titleFrom clips and collapses whitespace", () => {
  assert.equal(titleFrom("  hello   world \n"), "hello world");
  const long = titleFrom("x".repeat(80));
  assert.equal(long.length, 49);
  assert.ok(long.endsWith("…"));
});

// --------------------------------------------------------------- tokens

test("estimateTokens scales with length", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("images dominate the token estimate", () => {
  const withImage = conversationTokens([
    { role: "user", content: "hi", attachments: [{ name: "a.png", kind: "image" }] },
  ]);
  const withoutImage = conversationTokens([{ role: "user", content: "hi" }]);
  assert.ok(withImage > withoutImage + 500);
});

test("legacy inline images still count toward usage", () => {
  const legacy = conversationTokens([
    { role: "user", content: "hi", images: ["AAAA"] },
  ]);
  assert.ok(legacy > 500);
});

test("usage sums every contributor", () => {
  const u = usage({
    system: "a".repeat(40),
    note: "b".repeat(400),
    messages: [{ role: "user", content: "c".repeat(80) }],
    draft: "d".repeat(40),
    limit: 1000,
  });
  assert.equal(u.system, 10);
  assert.equal(u.note, 100);
  assert.equal(u.messages, 24);
  assert.equal(u.draft, 10);
  assert.equal(u.total, 144);
  assert.equal(u.ratio, 0.144);
});

test("usage never divides by zero", () => {
  const u = usage({ system: "", note: "", messages: [], draft: "", limit: 0 });
  assert.ok(Number.isFinite(u.ratio));
});

test("usageLevel thresholds are green<50, yellow<75, red>=75", () => {
  assert.equal(usageLevel(0), "ok");
  assert.equal(usageLevel(0.499), "ok");
  assert.equal(usageLevel(0.5), "warn");
  assert.equal(usageLevel(0.749), "warn");
  assert.equal(usageLevel(0.75), "danger");
  assert.equal(usageLevel(1.4), "danger");
});

// -------------------------------------------------------------trimming

test("trimToBudget drops oldest and reports the count", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(400), // ~100 tokens each
  }));
  const { messages, trimmed } = trimToBudget(msgs, 500);
  assert.ok(trimmed > 0);
  assert.ok(conversationTokens(messages) <= 500);
  // The newest turn must survive.
  assert.equal(messages.at(-1), msgs.at(-1));
});

test("trimToBudget keeps the final turn even when it alone overflows", () => {
  const msgs = [
    { role: "user", content: "old" },
    { role: "user", content: "x".repeat(10_000) },
  ];
  const { messages } = trimToBudget(msgs, 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], msgs[1]);
});

test("trimToBudget leaves a fitting thread untouched", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const { messages, trimmed } = trimToBudget(msgs, 1000);
  assert.equal(trimmed, 0);
  assert.deepEqual(messages, msgs);
});

// -------------------------------------------------------------- search

test("parseSearxng maps results and drops unusable ones", () => {
  const body = {
    results: [
      { title: "First", url: "https://example.com/a", content: "snippet a" },
      { title: "Dup", url: "https://example.com/a", content: "duplicate" },
      { title: "No scheme", url: "example.com/b", content: "x" },
      { title: "FTP", url: "ftp://example.com/c", content: "x" },
      { title: "Second", url: "https://example.org/d", content: "snippet d" },
    ],
  };
  const out = parseSearxng(body);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "First");
  assert.equal(out[1].url, "https://example.org/d");
  assert.deepEqual(parseSearxng({}), []);
  assert.deepEqual(parseSearxng(null), []);
});

test("parseBrave reads web.results and strips markup", () => {
  const body = {
    web: {
      results: [
        {
          title: "Result",
          url: "https://example.com/x",
          description: "a <strong>bold</strong> match",
        },
      ],
    },
  };
  const out = parseBrave(body);
  assert.equal(out[0].snippet, "a bold match");
  assert.deepEqual(parseBrave({ web: {} }), []);
  assert.deepEqual(parseBrave(undefined), []);
});

test("search results are capped", () => {
  const many = {
    results: Array.from({ length: 30 }, (_, i) => ({
      title: "t" + i,
      url: "https://example.com/" + i,
      content: "c",
    })),
  };
  assert.equal(parseSearxng(many).length, 6);
});

test("normalizeUrl accepts what people paste, rejects the rest", () => {
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("  www.example.com/x  "), "https://www.example.com/x");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl(""), null);
});

test("pageLabel prefers the title, falls back to the host", () => {
  assert.equal(pageLabel("https://example.com/a", "  My   Page "), "My Page");
  assert.equal(pageLabel("https://www.example.com/a"), "example.com");
  assert.equal(pageLabel("https://example.com/a", ""), "example.com");
  assert.equal(pageLabel("https://example.com/a", "x".repeat(90)).length, 60);
});

// ---------------------------------------------------------- model info

test("parseOllamaShow finds context length whatever the architecture", () => {
  // Captured from a real /api/show response.
  const real = {
    details: { parameter_size: "25.2B", quantization_level: "Q4_K_M" },
    model_info: {
      "general.architecture": "gemma4",
      "gemma4.context_length": 262144,
      "gemma4.block_count": 48,
    },
  };
  const info = parseOllamaShow(real);
  assert.equal(info.contextLength, 262144);
  assert.equal(info.parameterSize, "25.2B");
  assert.equal(info.quantization, "Q4_K_M");

  // A different architecture namespaces the key differently.
  assert.equal(
    parseOllamaShow({ model_info: { "qwen3moe.context_length": 32768 } })
      .contextLength,
    32768,
  );
});

test("parseOllamaShow degrades gracefully on junk", () => {
  for (const junk of [null, undefined, {}, { model_info: {} }, "nope"]) {
    const info = parseOllamaShow(junk);
    assert.equal(info.contextLength, null);
    assert.equal(info.parameterSize, null);
  }
});

test("parseLmStudioModels reads the matching model only", () => {
  const body = {
    data: [
      { id: "other-model", max_context_length: 4096 },
      { id: "target", max_context_length: 32768, quantization: "Q4_K_M" },
    ],
  };
  assert.equal(parseLmStudioModels(body, "target").contextLength, 32768);
  assert.equal(parseLmStudioModels(body, "target").quantization, "Q4_K_M");
  assert.equal(parseLmStudioModels(body, "missing").contextLength, null);
  assert.equal(parseLmStudioModels({}, "target").contextLength, null);
});

test("clampContext caps windows too large to be useful", () => {
  assert.equal(clampContext(8192), 8192);
  // A 262k window scaled into the gauge would read 0% forever.
  assert.equal(clampContext(262144), 131072);
  assert.equal(clampContext(1_000_000, 200_000), 200_000);
  assert.equal(clampContext(0), 0);
  assert.equal(clampContext(-5), 0);
  assert.equal(clampContext(Number.NaN), 0);
});

// ------------------------------------------------------------ hardware

test("formatBytes scales and stays readable", () => {
  assert.equal(formatBytes(0), "—");
  assert.equal(formatBytes(-5), "—");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(formatBytes(32 * 1024 ** 3), "32 GB");
});

test("parseNvidiaSmi picks the largest card and handles units", () => {
  const out = [
    "NVIDIA GeForce RTX 3060, 12288 MiB",
    "NVIDIA GeForce GTX 1050, 4096 MiB",
  ].join("\n");
  const gpu = parseNvidiaSmi(out);
  assert.equal(gpu.name, "NVIDIA GeForce RTX 3060");
  assert.equal(gpu.vram, 12288 * 1024 * 1024);
  // A size with no card name is not a usable reading.
  assert.equal(parseNvidiaSmi("24 GiB"), null);
  assert.equal(parseNvidiaSmi(""), null);
  assert.equal(parseNvidiaSmi("command not found"), null);
  // GB/MB spellings are accepted alongside GiB/MiB.
  assert.equal(parseNvidiaSmi("Radeon RX 7900, 24 GB").vram, 24 * 1024 ** 3);
});

test("fitVerdict prefers VRAM, falls back to RAM, then warns", () => {
  const GB = 1024 ** 3;
  assert.equal(fitVerdict(0, 12 * GB, 32 * GB).level, "unknown");
  // 4 GB model on a 12 GB card: comfortable.
  assert.equal(fitVerdict(4 * GB, 12 * GB, 32 * GB).level, "ok");
  // 20 GB model on the same card, but the machine has the RAM for it.
  assert.equal(fitVerdict(20 * GB, 12 * GB, 64 * GB).level, "warn");
  // No GPU at all, but it fits in RAM.
  assert.equal(fitVerdict(4 * GB, null, 32 * GB).level, "warn");
  // Bigger than everything.
  assert.equal(fitVerdict(60 * GB, 12 * GB, 32 * GB).level, "danger");
});

test("parseSizeString handles the units system tools emit", () => {
  assert.equal(parseSizeString("8 GB"), 8 * 1024 ** 3);
  assert.equal(parseSizeString("12227 MiB"), 12227 * 1024 ** 2);
  assert.equal(parseSizeString("1536MB"), 1536 * 1024 ** 2);
  assert.equal(parseSizeString("nonsense"), null);
});

test("parseSystemProfiler reads an Intel Mac's discrete VRAM", () => {
  const json = JSON.stringify({
    SPDisplaysDataType: [
      {
        _name: "Radeon Pro 5500M",
        sppci_model: "AMD Radeon Pro 5500M",
        spdisplays_vram: "8 GB",
        spdisplays_vendor: "sppci_vendor_amd",
      },
    ],
  });
  const gpu = parseSystemProfiler(json);
  assert.equal(gpu.name, "AMD Radeon Pro 5500M");
  assert.equal(gpu.vram, 8 * 1024 ** 3);
  assert.equal(gpu.unified, false);
});

test("parseSystemProfiler marks Apple silicon as unified, not unknown", () => {
  // Apple silicon reports no VRAM field at all — the GPU shares system
  // memory. Treating that as a detection failure would be wrong.
  const json = JSON.stringify({
    SPDisplaysDataType: [
      {
        _name: "Apple M2 Pro",
        sppci_model: "Apple M2 Pro",
        spdisplays_vendor: "sppci_vendor_Apple",
      },
    ],
  });
  const gpu = parseSystemProfiler(json);
  assert.equal(gpu.name, "Apple M2 Pro");
  assert.equal(gpu.vram, null);
  assert.equal(gpu.unified, true);
});

test("parseSystemProfiler survives malformed input", () => {
  assert.equal(parseSystemProfiler("not json"), null);
  assert.equal(parseSystemProfiler("{}"), null);
  assert.equal(parseSystemProfiler('{"SPDisplaysDataType":[]}'), null);
});

test("parseLspci extracts the card name and strips noise", () => {
  const out = [
    "00:02.0 Host bridge: Intel Corporation Device 1234",
    "01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [GeForce RTX 3070] (rev a1)",
  ].join("\n");
  assert.equal(parseLspci(out), "NVIDIA Corporation GA104");
  assert.equal(parseLspci("no gpu here"), null);
});

test("fitVerdict treats unified memory as one shared pool", () => {
  const GB = 1024 ** 3;
  // 20 GB model on a 64 GB Mac: fits, and there is no slow middle
  // ground to warn about because the GPU addresses the same memory.
  const ok = fitVerdict(20 * GB, null, 64 * GB, true);
  assert.equal(ok.level, "ok");
  assert.match(ok.text, /unified/);
  // Same model on a 16 GB Mac: genuinely will not fit.
  assert.equal(fitVerdict(20 * GB, null, 16 * GB, true).level, "danger");
  // Without the unified flag the same numbers only warn, because a
  // discrete setup can spill to RAM.
  assert.equal(fitVerdict(20 * GB, null, 64 * GB, false).level, "warn");
});

test("fitVerdict accounts for runtime overhead, not just weights", () => {
  const GB = 1024 ** 3;
  // Exactly card-sized weights must not report a clean fit: the runtime
  // needs headroom beyond the file itself.
  assert.notEqual(fitVerdict(12 * GB, 12 * GB, 64 * GB).level, "ok");
});

// ----------------------------------------------------------attachments

test("withAttachments inlines file text and leaves images alone", () => {
  const out = withAttachments([
    {
      role: "user",
      content: "what is this?",
      attachments: [{ name: "a.png", kind: "image" }],
    },
    {
      role: "user",
      content: "summarize",
      attachments: [{ name: "n.md", kind: "file", text: "NOTE BODY" }],
    },
  ]);
  assert.equal(out[0].content, "what is this?");
  assert.match(out[1].content, /Attached file: n\.md/);
  assert.match(out[1].content, /NOTE BODY/);
  assert.ok(out[1].content.endsWith("summarize"));
});

test("withAttachments does not mutate its input", () => {
  const input = [
    {
      role: "user",
      content: "hi",
      attachments: [{ name: "n.md", kind: "file", text: "BODY" }],
    },
  ];
  withAttachments(input);
  assert.equal(input[0].content, "hi");
});

// ----------------------------------------------------- openai protocol

test("toOpenAI moves images into content parts", () => {
  const [msg] = toOpenAI([
    { role: "user", content: "what is this?", images: ["QUJD"] },
  ]);
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[0].type, "text");
  assert.equal(
    msg.content[1].image_url.url,
    "data:image/png;base64,QUJD",
  );
  assert.ok(!("images" in msg));
});

test("toOpenAI stringifies tool arguments and echoes ids", () => {
  const out = toOpenAI([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_9", function: { name: "write_to_note", arguments: { content: "x" } } },
      ],
    },
    { role: "tool", content: "ok", tool_call_id: "call_9" },
    { role: "tool", content: "legacy" },
  ]);
  assert.equal(typeof out[0].tool_calls[0].function.arguments, "string");
  assert.equal(out[1].tool_call_id, "call_9");
  // A tool result with no id still needs one or servers reject it.
  assert.equal(out[2].tool_call_id, "call_0");
});

test("parseToolCalls reassembles fragments and survives bad JSON", () => {
  const acc = new Map([
    [0, { id: "a", name: "write_to_note", args: '{"content":"hi"}' }],
    [1, { id: "b", name: "write_to_note", args: "{not json" }],
    [2, { id: "c", name: "", args: "{}" }], // no name: not a real call
  ]);
  const calls = parseToolCalls(acc);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].function.arguments, { content: "hi" });
  assert.deepEqual(calls[1].function.arguments, {});
});

test("parseSSELine decodes data lines and ignores the rest", () => {
  assert.deepEqual(parseSSELine('data: {"a":1}'), { a: 1 });
  assert.equal(parseSSELine("data: [DONE]"), null);
  assert.equal(parseSSELine(""), null);
  assert.equal(parseSSELine(": keep-alive"), null);
  assert.equal(parseSSELine("data: {broken"), null);
});

test("streamed SSE parses identically at every chunk boundary", () => {
  const stream = [
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo world"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"write_to_note","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cont"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ent\\":\\"body\\"}"}}]}}]}',
    "data: [DONE]",
    "",
  ].join("\n");

  const run = (chunkSize) => {
    const bytes = Buffer.from(stream, "utf8");
    let buffer = "";
    let content = "";
    let thinking = 0;
    const acc = new Map();
    for (let off = 0; off < bytes.length; off += chunkSize) {
      buffer += bytes.subarray(off, off + chunkSize).toString("utf8");
      const { lines, rest } = takeLines(buffer);
      buffer = rest;
      for (const line of lines) {
        const chunk = parseSSELine(line);
        if (!chunk) continue;
        const r = applyDelta(chunk.choices?.[0]?.delta ?? {}, acc);
        content += r.text;
        if (r.thinking) thinking++;
      }
    }
    return { content, thinking, tools: parseToolCalls(acc) };
  };

  // 1 byte at a time splits lines mid-JSON, which is the failure mode
  // a real socket produces under load.
  for (const size of [4096, 17, 3, 1]) {
    const r = run(size);
    assert.equal(r.content, "Hello world", `chunk size ${size}`);
    assert.equal(r.thinking, 1, `chunk size ${size}`);
    assert.equal(r.tools.length, 1, `chunk size ${size}`);
    assert.equal(r.tools[0].id, "call_abc");
    assert.deepEqual(r.tools[0].function.arguments, { content: "body" });
  }
});
