import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { keychainGet, providerAccount, resetMemoryKeychain } from "../core/secrets.ts";
import { updateSettings, readSettings } from "../settings/settings.ts";
import { Anthropic, betasFor, checkKey, claudeTraits, echoSafe, modelsOrFallback, requestBody, ANTHROPIC_BETAS } from "./anthropic.ts";
import { OpenAiCompatible, ThinkFilter, checkKey as compatCheckKey, listModels, status, toMessages, takesReasoningEffort } from "./openai.ts";
import {
  baseUrl,
  bindCustomKey,
  checkBase,
  isLoopback,
  keyFor,
  keyProblem,
  modelForSpace,
  origin,
  parseRef,
  preset,
  savedRef,
  unbindCustomKey,
} from "./presets.ts";
import { ProviderError, type Delta, type ModelRequest } from "./types.ts";
import { fromMetadata, modelSees, remember, resetVisionMemory, sees } from "./vision.ts";
import { anthropicReply, deadUrl, fakeServer, openaiReply } from "./testing.ts";
import { sseEvents } from "./http.ts";
import { call } from "../../../tests/harness.ts";
import "./commands.ts";
import { appFiles } from "../core/vault.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());
beforeEach(() => resetMemoryKeychain());

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: { stable: "STABLE", volatile: "TAIL" },
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  effort: "medium",
  ...over,
});
const collect = () => {
  const deltas: Delta[] = [];
  return { deltas, on: (d: Delta) => deltas.push(d), text: () => deltas.filter((d) => d.type === "text").map((d) => (d as { text: string }).text).join("") };
};
const signal = () => new AbortController().signal;

describe("model references and presets", () => {
  it("parses provider:model and plain Anthropic ids", () => {
    expect(parseRef("claude-opus-5-5")).toMatchObject({ provider: { id: "anthropic" }, model: "claude-opus-5-5" });
    expect(parseRef("openai:gpt-5")).toMatchObject({ provider: { id: "openai" }, model: "gpt-5" });
    expect(parseRef("ollama:llama3.2:3b")).toMatchObject({ provider: { id: "ollama" }, model: "llama3.2:3b" });
    expect(parseRef("anthropic:gpt-5")).toBeUndefined();
    expect(parseRef("openai:../x")).toBeUndefined();
    expect(parseRef("gpt-5")).toBeUndefined();
    expect(savedRef(parseRef("openrouter:acme/reader")!)).toBe("openrouter:acme/reader");
    expect(savedRef(parseRef("claude-sonnet-5-5")!)).toBe("claude-sonnet-5-5");
  });

  it("checks addresses and origins", () => {
    expect(checkBase(" http://127.0.0.1:11434/v1/ ")).toBe("http://127.0.0.1:11434/v1");
    for (const bad of ["ftp://x", "http://u:p@x", "https://x/v1?a=1", "https://x#f", "not a url", ""]) expect(() => checkBase(bad)).toThrow("That isn’t an address");
    expect(origin("https://example.com:443/v1")).toBe("https://example.com");
    expect(isLoopback("http://localhost:1234")).toBe(true);
    expect(isLoopback("http://127.8.0.1")).toBe(true);
    expect(isLoopback("http://[::1]:8080")).toBe(true);
    expect(isLoopback("http://localhost.evil.com")).toBe(false);
  });

  it("refuses a key with another provider's prefix before sending it", () => {
    const openai = preset("openai")!;
    expect(keyProblem(openai, openai.base, "sk-ant-abcdefghijklmnop")).toBe(
      "That looks like a key for Anthropic, not OpenAI, so it wasn’t sent anywhere. Choose Anthropic as the provider, or paste a OpenAI key.",
    );
    expect(keyProblem(openai, openai.base, "short")).toMatch(/doesn’t look like a OpenAI API key/);
    const custom = preset("custom")!;
    expect(keyProblem(custom, "https://openrouter.ai/api/v1", "sk-or-abcdefghijkl")).toBeUndefined();
    expect(keyProblem(custom, "https://my.server/v1", "sk-or-abcdefghijkl")).toMatch(/key for OpenRouter/);
  });

  it("binds a custom server's key to its origin and never sends it over plain http", () => {
    const custom = preset("custom")!;
    const saved = bindCustomKey("https://my.server/v1", " k-12345678 ");
    expect(JSON.parse(saved)).toEqual({ origin: "https://my.server", key: "k-12345678" });
    expect(unbindCustomKey(saved, "https://my.server/v2")).toBe("k-12345678");
    expect(() => unbindCustomKey(saved, "https://other.server/v1")).toThrow("was saved for https://my.server, and the address is now https://other.server");
    const httpSaved = bindCustomKey("http://10.0.0.2/v1", "k-12345678");
    expect(() => keyFor(custom, "http://10.0.0.2/v1", () => httpSaved)).toThrow("starts with http://");
    expect(keyFor(custom, "http://127.0.0.1:9/v1", () => bindCustomKey("http://127.0.0.1:9/v1", "k-12345678"))).toBe("k-12345678");
    expect(keyFor(preset("ollama")!, "http://127.0.0.1:11434/v1", () => { throw new Error("keychain must not be read"); })).toBeUndefined();
    expect(() => keyFor(preset("openai")!, "x", () => null)).toThrow("Add your OpenAI API key in Settings to start.");
  });

  it("never lets settings move a fixed preset's address", () => {
    updateSettings({ providerUrls: { openai: "https://evil.example/v1", ollama: "http://127.0.0.1:9999/v1" } });
    const s = readSettings();
    expect(baseUrl(s, preset("openai")!)).toBe("https://api.openai.com/v1");
    expect(baseUrl(s, preset("ollama")!)).toBe("http://127.0.0.1:9999/v1");
    updateSettings({ providerUrls: {} });
    expect(() => baseUrl(readSettings(), preset("custom")!)).toThrow("Add your server’s address in Settings › Assistant first.");
  });

  it("picks the space's model, else the default, else asks for one", () => {
    updateSettings({ provider: "openai", providerModels: {} });
    expect(() => modelForSpace(undefined)).toThrow("Choose which OpenAI model answers, in Settings › Assistant.");
    updateSettings({ provider: null, model: null });
    expect(modelForSpace(undefined).model).toBe("claude-opus-5-5");
  });
});

describe("model sight", () => {
  it("guesses from names and learns from lists", () => {
    expect(modelSees("anthropic", "claude-opus-5-5")).toBe("yes");
    expect(modelSees("openai", "gpt-3.5-turbo")).toBe("no");
    expect(modelSees("openai", "gpt-4o-mini")).toBe("yes");
    expect(modelSees("deepseek", "deepseek-chat")).toBe("no");
    expect(modelSees("ollama", "qwen2.5vl:7b")).toBe("yes");
    expect(modelSees("ollama", "llama3.2:3b")).toBe("unknown");
    expect(fromMetadata({ architecture: { input_modalities: ["text", "IMAGE"] } })).toBe("yes");
    expect(fromMetadata({ capabilities: ["completion"] })).toBe("no");
    expect(fromMetadata({ capabilities: [] })).toBeUndefined();
    remember("openrouter", "https://openrouter.ai/api/v1/", [{ id: "acme/reader", sees: "yes" }]);
    expect(sees("openrouter", "https://openrouter.ai/api/v1", "acme/reader")).toBe("yes");
    const file = JSON.parse(fs.readFileSync(appFiles.modelPictures(), "utf8"));
    expect(file).toEqual({ lists: { "openrouter https://openrouter.ai/api/v1": { "acme/reader": "yes" } } });
    resetVisionMemory();
    expect(sees("openrouter", "https://openrouter.ai/api/v1", "acme/reader")).toBe("yes");
  });
});

describe("server-sent events", () => {
  it("reassembles an event split inside a UTF-8 character and handles CRLF", async () => {
    const bytes = Buffer.from('data: {"t":"é—"}\r\n\r\ndata: a\ndata: b\n\n: comment\n\ndata: tail', "utf8");
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.subarray(0, cut));
        c.enqueue(bytes.subarray(cut));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const e of sseEvents(stream, signal())) out.push(e);
    expect(out).toEqual(['{"t":"é—"}', "a\nb", "", "tail"]);
  });
});

describe("Anthropic", () => {
  it("knows what each Claude model takes", () => {
    expect(claudeTraits("claude-opus-5-5")).toEqual({ adaptive: true, effort: true, updates: true, fallbacks: true });
    expect(claudeTraits("claude-haiku-5-5")).toEqual({ adaptive: true, effort: true, updates: false, fallbacks: false });
    expect(claudeTraits("claude-sonnet-4-5-20250929")).toEqual({ adaptive: false, effort: false, updates: false, fallbacks: false });
    expect(claudeTraits("claude-opus-4-5")).toMatchObject({ adaptive: false, effort: true });
    expect(claudeTraits("claude-fable-5-1")).toEqual({ adaptive: true, effort: true, updates: true, fallbacks: true });
    expect(claudeTraits("claude-3-5-sonnet-latest")).toEqual({ adaptive: false, effort: false, updates: false, fallbacks: false });
  });

  it("builds a cacheable request with effort, fallbacks and between-tool notes", () => {
    const body = requestBody("claude-opus-5-5", req({ effort: "high" }));
    expect(body.system).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "TAIL" },
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.fallbacks).toBe("default");
    expect(body.thinking).toEqual({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(body.max_tokens).toBe(64000);
    expect("tools" in body).toBe(false);
    expect(betasFor("claude-opus-5-5")).toEqual([ANTHROPIC_BETAS.fallback, ANTHROPIC_BETAS.updates, ANTHROPIC_BETAS.binding]);
    const old = requestBody("claude-sonnet-4-5", req());
    expect("thinking" in old || "output_config" in old || "fallbacks" in old).toBe(false);
    expect(betasFor("claude-sonnet-4-5")).toEqual([]);
  });

  it("keeps only what's safe to echo after a fallback", () => {
    const blocks = [
      { type: "thinking", thinking: "" },
      { type: "text", text: "a" },
      { type: "tool_use", id: "t" },
      { type: "fallback" },
      { type: "text", text: "b" },
    ];
    expect(echoSafe(blocks).map((b) => b.type)).toEqual(["text", "fallback", "text"]);
  });

  it("streams over HTTP: request shape, progress notes, split characters, tool input", async () => {
    const srv = await fakeServer([
      anthropicReply(
        [
          { type: "thinking", thinking: "Looking at your notes first." },
          { type: "text", text: "Héllo — wörld" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.md" } },
          { type: "tool_use", id: "toolu_2", name: "read_file", raw: '{"path": ' },
        ],
        "tool_use",
      ),
    ]);
    const p = new Anthropic("sk-ant-test-key-123456", "claude-opus-5-5", srv.url);
    const c = collect();
    const turn = await p.turn(req({ tools: [{ name: "read_file", description: "d", input_schema: { type: "object" } }] }), c.on, signal());
    await srv.close();
    const s = srv.seen[0];
    expect(s.url).toBe("/v1/messages");
    expect(s.headers["x-api-key"]).toBe("sk-ant-test-key-123456");
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(String(s.headers["anthropic-beta"]).split(",")).toContain("server-side-fallback-2026-07-01");
    expect(s.json).toMatchObject({ model: "claude-opus-5-5", stream: true, fallbacks: "default", output_config: { effort: "medium" } });
    expect(c.text()).toBe("Héllo — wörld");
    expect(c.deltas).toContainEqual({ type: "progress", text: "Looking at your notes first." });
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content[0]).toMatchObject({ type: "thinking", thinking: "Looking at your notes first.", signature: "sig" });
    expect(turn.content[2]).toEqual({ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.md" } });
    expect(turn.invalidInputs).toEqual([["toolu_2", '{"path": ']]);
  });

  it("maps errors without the key, retries with retry-after, refuses redirects", async () => {
    const key = "sk-ant-secret-should-not-leak";
    const srv = await fakeServer([
      { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { type: "authentication_error", message: `bad ${key}` } }) },
      { status: 529, headers: { "retry-after": "0" }, body: "{}" },
      anthropicReply([{ type: "text", text: "ok" }]),
      { status: 429, headers: { "retry-after": "120" }, body: "{}" },
      { status: 302, headers: { location: "https://elsewhere.example" }, body: "" },
      { status: 400, body: JSON.stringify({ error: { message: "Your credit balance is too low" } }) },
    ]);
    const p = new Anthropic(key, "claude-opus-5-5", srv.url);
    const e1 = await p.turn(req(), () => {}, signal()).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ kind: "auth", message: "Anthropic didn’t accept your API key. Check it in Settings." });
    expect(String(e1.message)).not.toContain(key);
    const ok = await p.turn(req(), () => {}, signal());
    expect(ok.content).toEqual([{ type: "text", text: "ok" }]);
    const started = Date.now();
    const e2 = await p.turn(req(), () => {}, signal()).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e2).toMatchObject({ kind: "rateLimit", retryAfter: 120 });
    expect(e2.message).toBe("Anthropic is limiting how fast this key can send messages. Try again in 2 minutes.");
    const e3 = await p.turn(req(), () => {}, signal()).catch((e) => e);
    expect(e3.message).toBe("Anthropic redirected the request to another address. The request was not forwarded.");
    const e4 = await p.turn(req(), () => {}, signal()).catch((e) => e);
    expect(e4.kind).toBe("billing");
    expect(srv.seen.length).toBe(6);
    expect(srv.seen.filter((s) => s.url !== "/v1/messages")).toEqual([]);
    await srv.close();
  });

  it("checks keys and lists models", async () => {
    expect((await checkKey("http://127.0.0.1:9", "not-a-key")).problem).toBe("format");
    const srv = await fakeServer([
      { status: 200, body: "{}" },
      { status: 401, body: "{}" },
      { status: 402, body: "{}" },
      { status: 429, body: "{}" },
      { status: 503, body: "{}" },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "claude-x-1", display_name: "X" }, { id: "gpt-5" }] }) },
      { status: 500, body: "" },
    ]);
    const key = "sk-ant-" + "a".repeat(30);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkKey(srv.url, key));
    expect(results.map((r) => r.problem ?? "ok")).toEqual(["ok", "rejected", "billing", "ok", "network"]);
    expect(srv.seen[0].url).toBe("/v1/models?limit=1");
    expect(await modelsOrFallback(srv.url, key)).toEqual([{ id: "claude-x-1", name: "X" }]);
    expect((await modelsOrFallback(srv.url, key))[0].id).toBe("claude-opus-5-5");
    expect((await checkKey(await deadUrl(), key)).problem).toBe("network");
    await srv.close();
  });
});

describe("OpenAI-compatible", () => {
  const openai = preset("openai")!;

  it("converts Messages-shape history at the boundary", () => {
    const out = toMessages(
      "SYS",
      [
        { role: "user", content: [{ type: "text", text: "q" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body", is_error: true }] },
      ],
      false,
      false,
    );
    expect(out).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "q\n\n[An image was attached here, but this model can’t see images.]" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "Error: body" },
    ]);
    const mistral = toMessages("S", [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_long_id", name: "x", input: {} }] }], true, true);
    expect((mistral[1].tool_calls as { id: string }[])[0].id).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  it("hides a leading think block", () => {
    const f = new ThinkFilter();
    expect(["  <thi", "nk>secret</th", "ink>\n\nAnswer", " here"].map((t) => f.push(t)).join("") + f.flush()).toBe("Answer here");
    const g = new ThinkFilter();
    expect(["<t", "able>"].map((t) => g.push(t)).join("") + g.flush()).toBe("<table>");
    expect(takesReasoningEffort("openai/o3-mini")).toBe(true);
    expect(takesReasoningEffort("gpt-4o")).toBe(false);
  });

  it("streams text and split tool calls with the key only in the header", async () => {
    const srv = await fakeServer([openaiReply("Hello there", [{ id: "call_1", name: "read_file", args: '{"path":"notes.md"}' }])]);
    const p = new OpenAiCompatible({ preset: openai, base: srv.url, key: "sk-proj-123456789", model: "gpt-5" });
    const c = collect();
    const turn = await p.turn(req({ effort: "high", tools: [{ name: "read_file", description: "d", input_schema: { type: "object" } }] }), c.on, signal());
    await srv.close();
    expect(srv.seen[0].url).toBe("/chat/completions");
    expect(srv.seen[0].headers.authorization).toBe("Bearer sk-proj-123456789");
    expect(srv.seen[0].text.includes("sk-proj")).toBe(false);
    expect(srv.seen[0].json.reasoning_effort).toBe("high");
    expect(srv.seen[0].json.messages[0]).toEqual({ role: "system", content: "STABLE\n\nTAIL" });
    expect(srv.seen[0].json.tools[0]).toEqual({ type: "function", function: { name: "read_file", description: "d", parameters: { type: "object" } } });
    expect(c.text()).toBe("Hello there");
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "text", text: "Hello there" },
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "notes.md" } },
    ]);
  });

  it("retries 5xx three times, retries once without images when refused, refuses redirects", async () => {
    const srv = await fakeServer([
      { status: 502, body: "bad gateway" },
      { status: 502, body: "bad gateway" },
      { status: 502, body: "bad gateway" },
      { status: 400, body: JSON.stringify({ error: { message: "This model does not support image input" } }) },
      openaiReply("seen as text"),
      { status: 307, headers: { location: "http://elsewhere" }, body: "" },
    ]);
    const p = new OpenAiCompatible({ preset: preset("groq")!, base: srv.url, key: "gsk_123456789", model: "llama-4-scout" });
    const e = await p.turn(req(), () => {}, signal()).catch((x) => x);
    expect(e.message).toBe("Groq is overloaded or having problems right now. Try again in a few minutes.");
    const withImage = req({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] });
    const ok = await p.turn(withImage, () => {}, signal());
    expect(ok.content).toEqual([{ type: "text", text: "seen as text" }]);
    expect(srv.seen[3].text).toContain("image_url");
    expect(srv.seen[4].text).not.toContain("image_url");
    const r = await p.turn(req(), () => {}, signal()).catch((x) => x);
    expect(r.message).toMatch(/^Groq sent Phaethon to another address/);
    await srv.close();
  });

  it("gives local servers no key and says at once when nothing is running", async () => {
    const srv = await fakeServer([openaiReply("local")]);
    const p = new OpenAiCompatible({ preset: preset("ollama")!, base: `${srv.url}/v1`, model: "llama3.2" });
    await p.turn(req(), () => {}, signal());
    expect(srv.seen[0].headers.authorization).toBeUndefined();
    await srv.close();
    const dead0 = await deadUrl();
    const dead = new OpenAiCompatible({ preset: preset("ollama")!, base: `${dead0}/v1`, model: "llama3.2" });
    const started = Date.now();
    const e = await dead.turn(req(), () => {}, signal()).catch((x) => x);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(e.message).toBe(`Phaethon couldn’t reach Ollama at ${dead0}. Make sure it’s open and running, then try again.`);
  });

  it("lists models with sight from metadata, checks keys and local status", async () => {
    const srv = await fakeServer([
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "acme/reader", architecture: { input_modalities: ["image"] } }, { id: "acme/blind", architecture: { input_modalities: ["text"] } }] }) },
      { status: 401, body: "{}" },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "text-embedding-3" }, { id: "gpt-5" }] }) },
    ]);
    const models = await listModels(preset("openrouter")!, srv.url, "sk-or-123456789");
    expect(models).toEqual([
      { id: "acme/reader", name: "acme/reader", sees: "yes" },
      { id: "acme/blind", name: "acme/blind", sees: "no" },
    ]);
    expect(sees("openrouter", srv.url, "acme/blind")).toBe("no");
    expect((await compatCheckKey(preset("openrouter")!, srv.url, "sk-or-123456789")).problem).toBe("rejected");
    expect(await listModels(openai, srv.url, "sk-123456789")).toEqual([{ id: "gpt-5", name: "gpt-5" }]);
    await srv.close();
    const dead = await deadUrl();
    const st = await status(preset("lmstudio")!, `${dead}/v1`, undefined);
    expect(st).toEqual({ running: false, models: [], message: `LM Studio isn’t running at ${dead}. Open it, then check again.` });
  });
});

describe("commands", () => {
  it("saves keys only to the keychain, bound and validated", async () => {
    await expect(call("api_key_set", { provider: "ollama", key: "x" })).rejects.toThrow("That provider doesn’t take a key.");
    await expect(call("api_key_set", { provider: "openai", key: "sk-ant-abcdefghijk" })).rejects.toThrow("looks like a key for Anthropic");
    await expect(call("api_key_set", { provider: "anthropic", key: "sk-or-abcdefghijk" })).rejects.toThrow("looks like a key for OpenRouter");
    await call("api_key_set", { provider: "anthropic", key: " sk-ant-abcdefghijk " });
    expect(keychainGet(providerAccount("anthropic"))).toBe("sk-ant-abcdefghijk");
    await call("settings_set_provider_url", { provider: "custom", url: "https://my.server/v1/" });
    await call("api_key_set", { provider: "custom", key: "k-12345678" });
    expect(JSON.parse(keychainGet(providerAccount("custom"))!)).toEqual({ origin: "https://my.server", key: "k-12345678" });
    await call("api_key_clear", { provider: "anthropic" });
    expect(keychainGet(providerAccount("anthropic"))).toBeNull();
    const settingsFile = fs.readFileSync(path.join(env.home, "Phaethon/default/.phaethon/settings.json"), "utf8");
    expect(settingsFile).not.toContain("k-12345678");
  });

  it("validates settings writes", async () => {
    await expect(call("settings_set_provider", { provider: "nope" })).rejects.toThrow("That isn’t a provider Phaethon knows.");
    await expect(call("settings_set_provider_model", { provider: "openai", model: "../x" })).rejects.toThrow("It’s one word");
    await call("settings_set_provider_model", { provider: "openai", model: "gpt-5" });
    expect(readSettings().providerModels).toEqual({ openai: "gpt-5" });
    await call("settings_set_provider_model", { provider: "openai", model: null });
    expect(readSettings().providerModels).toEqual({});
    await expect(call("settings_set_provider_url", { provider: "openai", url: "https://x" })).rejects.toThrow("That provider’s address can’t be changed.");
    await expect(call("settings_set_model", { model: "gpt-5" })).rejects.toThrow("That isn’t a model Phaethon knows how to use.");
    await call("settings_set_model", { model: null });
    expect(readSettings().model).toBeNull();
    await expect(call("provider_status", { provider: "openai" })).rejects.toThrow("Only a server on this computer or your own can be checked.");
    const fallback = await call<{ id: string }[]>("models_list", {});
    expect(fallback.map((m) => m.id)).toContain("claude-opus-5-5");
  });
});
