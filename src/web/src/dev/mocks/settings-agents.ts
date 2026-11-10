/**
 * Dev-only fake core for Settings › Assistant and Settings › Coding agents.
 * Stateful, so flows can be clicked through. Pick a starting state with
 * `scenario=` in the URL hash (`#mock&scenario=fresh`):
 *  - configured (default): Anthropic default with a key, OpenRouter and Ollama
 *    added; Claude Code signed in plus a signed-out "Work" account; Codex
 *    signed in; Gemini CLI missing; grants both ways; full access off.
 *  - fresh: nothing added; Claude Code installed but signed out; Codex
 *    missing; Gemini CLI installed (can't tell sign-in).
 *  - cli: Codex answers; this space has its own Codex model and reasoning;
 *    a bound workspace folder that is unavailable; full access on.
 *  - notready: OpenAI is the default but has no model chosen.
 *  - broken: settings and CLI status can't be read.
 * Keys are never stored here beyond "has one".
 */
type Args = Record<string, unknown>;
type ProviderId = "anthropic" | "openai" | "openrouter" | "groq" | "together" | "mistral" | "deepseek" | "xai" | "ollama" | "lmstudio" | "custom";

const scenario = new URLSearchParams(location.hash.slice(1)).get("scenario") ?? "configured";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRESETS: { id: ProviderId; name: string; base: string; key: "required" | "optional" | "none"; local: boolean; editableBase: boolean; keysUrl: string; keyPrefix: string }[] = [
  { id: "anthropic", name: "Anthropic", base: "https://api.anthropic.com", key: "required", local: false, editableBase: false, keysUrl: "https://console.anthropic.com/settings/keys", keyPrefix: "sk-ant-" },
  { id: "openai", name: "OpenAI", base: "https://api.openai.com/v1", key: "required", local: false, editableBase: false, keysUrl: "https://platform.openai.com/api-keys", keyPrefix: "" },
  { id: "openrouter", name: "OpenRouter", base: "https://openrouter.ai/api/v1", key: "required", local: false, editableBase: false, keysUrl: "https://openrouter.ai/settings/keys", keyPrefix: "sk-or-" },
  { id: "groq", name: "Groq", base: "https://api.groq.com/openai/v1", key: "required", local: false, editableBase: false, keysUrl: "https://console.groq.com/keys", keyPrefix: "gsk_" },
  { id: "together", name: "Together AI", base: "https://api.together.xyz/v1", key: "required", local: false, editableBase: false, keysUrl: "https://api.together.ai/settings/api-keys", keyPrefix: "" },
  { id: "mistral", name: "Mistral", base: "https://api.mistral.ai/v1", key: "required", local: false, editableBase: false, keysUrl: "https://console.mistral.ai/api-keys", keyPrefix: "" },
  { id: "deepseek", name: "DeepSeek", base: "https://api.deepseek.com/v1", key: "required", local: false, editableBase: false, keysUrl: "https://platform.deepseek.com/api_keys", keyPrefix: "" },
  { id: "xai", name: "xAI", base: "https://api.x.ai/v1", key: "required", local: false, editableBase: false, keysUrl: "https://console.x.ai", keyPrefix: "xai-" },
  { id: "ollama", name: "Ollama", base: "http://127.0.0.1:11434/v1", key: "none", local: true, editableBase: true, keysUrl: "", keyPrefix: "" },
  { id: "lmstudio", name: "LM Studio", base: "http://127.0.0.1:1234/v1", key: "none", local: true, editableBase: true, keysUrl: "", keyPrefix: "" },
  { id: "custom", name: "Your own server", base: "", key: "optional", local: false, editableBase: true, keysUrl: "", keyPrefix: "" },
];

const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", sees: "yes" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", sees: "yes" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", sees: "yes" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", sees: "yes" },
  { id: "claude-opus-5", name: "Claude Opus 5", sees: "yes" },
];
const OPENROUTER_MODELS = [
  "openai/gpt-5.5|OpenAI: GPT-5.5",
  "openai/gpt-5.5-mini|OpenAI: GPT-5.5 Mini",
  "anthropic/claude-sonnet-5.5|Anthropic: Claude Sonnet 5.5",
  "google/gemini-3.1-pro|Google: Gemini 3.1 Pro",
  "google/gemini-3.1-flash|Google: Gemini 3.1 Flash",
  "meta-llama/llama-5-70b-instruct|Meta: Llama 5 70B Instruct",
  "mistralai/mistral-large-3|Mistral: Mistral Large 3",
  "deepseek/deepseek-v4|DeepSeek: DeepSeek V4",
  "deepseek/deepseek-r2|DeepSeek: R2",
  "qwen/qwen-4-235b|Qwen: Qwen 4 235B",
  "x-ai/grok-5|xAI: Grok 5",
  "moonshotai/kimi-k3|MoonshotAI: Kimi K3",
].map((s) => ({ id: s.split("|")[0], name: s.split("|")[1], sees: "unknown" }));
const OLLAMA_MODELS = [
  { id: "llama3.2:3b", name: "llama3.2:3b" },
  { id: "qwen3:8b", name: "qwen3:8b" },
  { id: "gemma3:12b", name: "gemma3:12b" },
];

type Prov = { hasKey: boolean; url: string | null; model: string | null };
const prov: Record<ProviderId, Prov> = Object.fromEntries(PRESETS.map((p) => [p.id, { hasKey: false, url: null, model: null }])) as Record<ProviderId, Prov>;
const settings = {
  backend: "phaethon" as string,
  provider: "anthropic" as ProviderId,
  anthropicModel: null as string | null,
  active: {} as Record<string, string>,
};

type Instance = { id: string; cli: "claude" | "codex" | "gemini"; name: string; binary: string; args: string[] };
type InstState = { installed: boolean; loggedIn: boolean | null; account: string | null; plan: string | null; readOnly?: boolean; managedHome: boolean };
const instances: { config: Instance; state: InstState }[] = [];
const installed = { claude: true, codex: true, gemini: false };

const SPACES = [
  { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250, educationEnabled: true, lastUsed: Date.now() - 60_000 },
  { id: "work", name: "Work", description: "Lab job and projects", hue: 150, educationEnabled: false, lastUsed: Date.now() - 3_600_000 },
  { id: "personal", name: "Personal", description: "", hue: 20, educationEnabled: false, lastUsed: null },
];
const spaceModel: Record<string, string> = {};
const cliModel: Record<string, Partial<Record<string, string>>> = {};
const reasoning: Record<string, Record<string, Record<string, string>>> = {};
const fullAccess = new Set<string>();
const workspaces: Record<string, { path: string; available: boolean } | undefined> = {};
type Grant = { id: string; to: string; from: string; path: string; created: string };
let grants: Grant[] = [];
const revoked = new Map<string, Grant>();
let grantProblems: string[] = [];

function builtIns() {
  instances.push(
    { config: { id: "claude", cli: "claude", name: "Claude Code", binary: "", args: [] }, state: { installed: installed.claude, loggedIn: false, account: null, plan: null, managedHome: false } },
    { config: { id: "codex", cli: "codex", name: "Codex", binary: "", args: [] }, state: { installed: installed.codex, loggedIn: false, account: null, plan: null, managedHome: true } },
    { config: { id: "gemini", cli: "gemini", name: "Gemini CLI", binary: "", args: [] }, state: { installed: installed.gemini, loggedIn: null, account: null, plan: null, managedHome: true } },
  );
}

const inst = (id: string) => instances.find((i) => i.config.id === id);

if (scenario === "fresh") {
  installed.codex = false;
  installed.gemini = true;
  builtIns();
} else {
  prov.anthropic.hasKey = true;
  prov.openrouter = { hasKey: true, url: null, model: "openai/gpt-5.5" };
  prov.ollama = { hasKey: false, url: null, model: "llama3.2:3b" };
  builtIns();
  Object.assign(inst("claude")!.state, { loggedIn: true, account: "student@example.edu", plan: "Max" });
  Object.assign(inst("codex")!.state, { loggedIn: true, account: null, plan: null });
  instances.push({
    config: { id: "claude-work", cli: "claude", name: "Work", binary: "", args: [] },
    state: { installed: true, loggedIn: false, account: null, plan: null, managedHome: true },
  });
  instances.push({
    config: { id: "codex-system", cli: "codex", name: "Codex · System", binary: "", args: [] },
    state: { installed: true, loggedIn: true, account: null, plan: null, readOnly: true, managedHome: false },
  });
  spaceModel.work = "openrouter:openai/gpt-5.5";
  grants = [
    { id: "8b1e7c2a-0d4f-4c11-9a0e-1f5e0f3a9c01", to: "school", from: "work", path: "calendar", created: "2026-10-10T14:03:00Z" },
    { id: "2f9a1d34-7e55-4b0a-8c6d-55a1b2c3d402", to: "work", from: "school", path: "courses/c241/notes.md", created: "2026-11-02T09:41:00Z" },
    { id: "c3d4e5f6-1111-4a2b-9c3d-77e8f9a0b103", to: "personal", from: "school", path: "study/plan.md", created: "2026-11-08T18:20:00Z" },
  ];
  grantProblems = ["Entry 4 is skipped: it lets work read itself."];
  if (scenario === "cli") {
    settings.backend = "codex-cli";
    settings.active.codex = "codex";
    cliModel.school = { codex: "gpt-6.1-sol" };
    reasoning.school = { codex: { "gpt-6.1-sol": "high" } };
    workspaces.school = { path: "/Users/student/Code/c241-homework", available: false };
    fullAccess.add("school");
  }
  if (scenario === "notready") {
    settings.provider = "openai";
    prov.openai = { hasKey: true, url: null, model: null };
  }
}

function view(id: ProviderId) {
  const p = PRESETS.find((x) => x.id === id)!;
  const s = prov[id];
  const baseUrl = p.editableBase ? (s.url ?? p.base) : p.base;
  const model = id === "anthropic" ? (settings.anthropicModel ?? "claude-opus-5-5") : s.model;
  const ready = !!baseUrl && (p.key !== "required" || s.hasKey);
  return { id, name: p.name, key: p.key, local: p.local, editableBase: p.editableBase, hasKey: p.local ? false : s.hasKey, baseUrl, defaultBaseUrl: p.base, model, keysUrl: p.keysUrl, keyPrefix: p.keyPrefix, ready };
}

function settingsView() {
  const providers = PRESETS.map((p) => view(p.id));
  const chosen = providers.find((p) => p.id === settings.provider)!;
  const defaultModel = chosen.model ? (chosen.id === "anthropic" ? chosen.model : `${chosen.id}:${chosen.model}`) : null;
  return {
    backend: settings.backend,
    hasAnthropicKey: prov.anthropic.hasKey,
    model: settings.anthropicModel ?? "claude-opus-5-5",
    provider: settings.provider,
    defaultModel,
    providerReady: chosen.ready && !!chosen.model,
    providers,
    appearance: {},
    vaultPath: "/Users/student/Phaethon/default",
    version: "0.2.0",
  };
}

const cliOf = () => (settings.backend.endsWith("-cli") ? settings.backend.slice(0, -4) : null);
const selectedId = (cli: string) => settings.active[cli] ?? cli;

const CLI_CATALOG: Record<string, { models: unknown[]; defaultModel?: string; note?: string }> = {
  claude: {
    defaultModel: "claude-opus-5-5",
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", aliases: ["opus"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", description: "Most capable for complex work" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", aliases: ["sonnet"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", aliases: ["haiku"], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "low" },
    ],
  },
  codex: {
    defaultModel: "gpt-6.1-sol",
    models: [
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "ultra"], defaultReasoningEffort: "medium" },
      { id: "gpt-6.1-sol-mini", name: "GPT-6.1-Sol Mini", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
      { id: "gpt-6-codex", name: "GPT-6 Codex", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high" },
    ],
  },
  gemini: { models: [{ id: "auto", name: "Auto" }, { id: "pro", name: "Pro" }, { id: "flash", name: "Flash" }, { id: "flash-lite", name: "Flash-Lite" }] },
};

const signIns = new Map<string, () => void>();

function instanceViews() {
  return instances.map(({ config, state }) => ({
    config,
    installed: state.installed,
    loggedIn: state.installed ? state.loggedIn : null,
    account: state.installed ? state.account : null,
    plan: state.installed ? state.plan : null,
    selected: selectedId(config.cli) === config.id && cliOf() === config.cli,
    managedHome: state.managedHome,
    source: state.readOnly || (config.id === "claude") ? "system" : "managed",
    readOnly: !!state.readOnly,
  }));
}

function space(id: unknown) {
  const s = SPACES.find((x) => x.id === id);
  if (!s) throw `space "${String(id)}" does not exist in this vault`;
  return s;
}

const handlers: Record<string, (args: Args) => unknown> = {
  async settings_get() {
    await wait(250);
    if (scenario === "broken") throw "settings.json is not a JSON object; fix or remove it first";
    return settingsView();
  },
  async settings_set_backend({ backend }) {
    await wait(120);
    settings.backend = String(backend);
  },
  async settings_set_provider({ provider }) {
    settings.provider = provider as ProviderId;
  },
  async settings_set_model({ model }) {
    settings.anthropicModel = (model as string | null) ?? null;
  },
  async settings_set_provider_model({ provider, model }) {
    prov[provider as ProviderId].model = (model as string | null) || null;
  },
  async settings_set_provider_url({ provider, url }) {
    await wait(150);
    const u = (url as string | null)?.trim() ?? null;
    if (u && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(u)) throw "That isn’t an address Phaethon can use. It looks like http://127.0.0.1:11434/v1 or https://example.com/v1.";
    prov[provider as ProviderId].url = u ? u.replace(/\/$/, "") : null;
  },
  async api_key_check({ key, provider = "anthropic" }) {
    await wait(700);
    const p = PRESETS.find((x) => x.id === provider)!;
    const k = String(key);
    if (k.includes("offline")) return { ok: false, problem: "network", message: `Couldn’t reach ${p.name}.` };
    if (k.includes("broke")) return { ok: false, problem: "billing", message: "No credit." };
    if (p.id === "anthropic" && !k.startsWith("sk-ant-")) return { ok: false, problem: "format", message: "That isn’t an Anthropic key." };
    if (p.id !== "anthropic" && k.startsWith("sk-ant-")) return { ok: false, problem: "format", message: `That looks like a key for Anthropic, not ${p.name}, so it wasn’t sent anywhere. Choose Anthropic as the provider, or paste a ${p.name} key.` };
    if (k.includes("bad")) return { ok: false, problem: "rejected", message: `${p.name} didn’t accept this key.` };
    return { ok: true, message: "Key works." };
  },
  async api_key_set({ provider }) {
    await wait(150);
    const p = PRESETS.find((x) => x.id === provider)!;
    if (p.key === "none") throw "That provider doesn’t take a key.";
    if (p.id === "custom" && !prov.custom.url) throw "Add your server’s address first, then its key.";
    prov[p.id].hasKey = true;
  },
  async api_key_clear({ provider }) {
    prov[provider as ProviderId].hasKey = false;
  },
  async models_list({ provider = "anthropic" }) {
    await wait(provider === "anthropic" ? 300 : 650);
    if (provider === "anthropic") return ANTHROPIC_MODELS;
    if (provider === "openrouter") return OPENROUTER_MODELS;
    if (provider === "ollama") return OLLAMA_MODELS;
    if (provider === "lmstudio") throw "Nothing answers at http://127.0.0.1:1234/v1. Start LM Studio’s server, then try again.";
    if (provider === "openai") return [
      { id: "gpt-5.5", name: "gpt-5.5" },
      { id: "gpt-5.5-mini", name: "gpt-5.5-mini" },
      { id: "o5", name: "o5" },
    ];
    throw `${PRESETS.find((p) => p.id === provider)?.name} didn’t send its model list. Type the model’s name instead.`;
  },
  async provider_status({ provider }) {
    await wait(500);
    if (provider === "ollama") return { running: true, models: OLLAMA_MODELS, message: "Ollama is running, with 3 models." };
    if (provider === "lmstudio") return { running: false, models: [], message: "LM Studio isn’t running at http://127.0.0.1:1234/v1. Start its server, then check again." };
    return { running: false, models: [], message: "Nothing answers at that address yet." };
  },

  async spaces_list() {
    return SPACES;
  },
  async space_models_list() {
    const cli = cliOf();
    if (cli) return Object.fromEntries(Object.entries(cliModel).filter(([, m]) => m[cli]).map(([s, m]) => [s, `${cli}:${m[cli]}`]));
    return { ...spaceModel };
  },
  async space_model_get({ space: id }) {
    space(id);
    const cli = cliOf();
    if (cli) return cliModel[String(id)]?.[cli] ? `${cli}:${cliModel[String(id)]![cli]}` : null;
    return spaceModel[String(id)] ?? null;
  },
  async space_model_set({ space: id, model }) {
    space(id);
    const m = model as string | null;
    const split = m ? /^(claude|codex|gemini):(.+)$/.exec(m) : null;
    const cli = cliOf();
    if (split) (cliModel[String(id)] ??= {})[split[1]] = split[2];
    else if (!m && cli) delete cliModel[String(id)]?.[cli];
    else if (m) spaceModel[String(id)] = m;
    else delete spaceModel[String(id)];
  },
  async space_reasoning_get({ space: id, cli, model }) {
    return reasoning[String(id)]?.[String(cli)]?.[(model as string | null) ?? "$default"] ?? null;
  },
  async space_reasoning_set({ space: id, cli, model, effort }) {
    await wait(120);
    const key = (model as string | null) ?? "$default";
    const per = ((reasoning[String(id)] ??= {})[String(cli)] ??= {});
    if (effort) per[key] = String(effort);
    else delete per[key];
  },

  async agent_clis_status() {
    await wait(400);
    if (scenario === "broken") throw "Phaethon couldn’t check the coding agents: spawn failed";
    const names = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" } as const;
    return [
      ...(["claude", "codex", "gemini"] as const).map((id) => ({
        id,
        name: names[id],
        installed: installed[id],
        loggedIn: id === "gemini" || !installed[id] ? null : (inst(id)?.state.loggedIn ?? null),
        loginCommand: id === "codex" ? "codex login" : id,
        supported: true,
        ownHome: id !== "claude",
      })),
      { id: "opencode", name: "OpenCode", installed: false, loggedIn: null, loginCommand: "opencode auth login", supported: false, ownHome: false },
    ];
  },
  async agent_instances_list() {
    await wait(350);
    if (scenario === "broken") throw "Phaethon couldn’t read its coding agent accounts.";
    return instanceViews();
  },
  async agent_instance_save({ instance }) {
    await wait(200);
    const i = instance as Instance;
    if (!i.name.trim() || i.name.trim().length > 80) throw "Use a name of 1–80 characters.";
    if (i.args.some((a) => /^(--output-format|--resume|-p|--print)(=|$)/.test(a))) throw "Output, session and prompt arguments are managed by Phaethon.";
    const existing = inst(i.id);
    const clean = { ...i, name: i.name.trim(), binary: i.binary.trim() };
    if (existing) existing.config = clean;
    else instances.push({ config: clean, state: { installed: installed[i.cli], loggedIn: false, account: null, plan: null, managedHome: true } });
    return clean;
  },
  async agent_instance_select({ id }) {
    const i = inst(String(id));
    if (!i) throw "Assistant instance not found.";
    settings.active[i.config.cli] = i.config.id;
    settings.backend = `${i.config.cli}-cli`;
  },
  async agent_instance_remove({ id }) {
    const at = instances.findIndex((i) => i.config.id === id);
    if (at < 0) return;
    if (["claude", "codex", "gemini", "codex-system", "gemini-system"].includes(String(id))) throw "Built-in assistants cannot be removed.";
    instances.splice(at, 1);
  },
  async agent_instance_sign_in({ id }) {
    const i = inst(String(id));
    if (!i) throw "Assistant instance not found.";
    if (!i.state.installed) return { status: "missing", message: `${i.config.name} isn’t installed.` };
    const cancelled = await new Promise<boolean>((resolve) => {
      signIns.set(String(id), () => resolve(true));
      setTimeout(() => resolve(false), 6000);
    });
    signIns.delete(String(id));
    if (cancelled) return { status: "cancelled", message: i.config.cli === "claude" ? "Sign-in stopped." : `Signing in to ${i.config.name} was stopped.` };
    Object.assign(i.state, { loggedIn: true, account: i.config.cli === "claude" ? "student.work@example.com" : null, plan: i.config.cli === "claude" ? "Pro" : null });
    return { status: "signedIn", message: i.config.cli === "claude" ? "Signed in to Claude Code." : `Signed in to ${i.config.name} for this Phaethon folder.` };
  },
  async agent_instance_sign_in_cancel({ id }) {
    const stop = signIns.get(String(id));
    stop?.();
    return !!stop;
  },
  async agent_instance_sign_out({ id }) {
    await wait(300);
    const i = inst(String(id));
    if (!i) throw "Assistant instance not found.";
    if (i.config.cli === "gemini") throw "Use Gemini CLI to sign out of this account.";
    Object.assign(i.state, { loggedIn: false, account: null, plan: null });
  },
  async agent_instance_usage({ id }) {
    await wait(600);
    const i = inst(String(id));
    if (i?.config.cli === "gemini") return { available: false, windows: [], reason: "Gemini CLI does not expose account limits." };
    if (!i?.state.loggedIn) return { available: false, windows: [], reason: "Usage is unavailable. Refresh to try again." };
    return {
      available: true,
      reason: null,
      windows:
        i.config.cli === "claude"
          ? [
              { label: "5 hours", usedPercent: 38, resetsAt: new Date(Date.now() + 2.4 * 3_600_000).toISOString() },
              { label: "7 days", usedPercent: 71, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
            ]
          : [
              { label: "Session", usedPercent: 12, resetsAt: Math.floor(Date.now() / 1000) + 4 * 3600 },
              { label: "Weekly", usedPercent: 54, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86400 },
            ],
    };
  },
  async agent_instance_models({ id }) {
    await wait(700);
    const i = inst(String(id));
    if (!i) throw "Assistant instance not found.";
    if (!i.state.installed) return { models: [], note: `${i.config.name} isn’t installed.` };
    return CLI_CATALOG[i.config.cli];
  },
  async agent_cli_models({ cli }) {
    await wait(700);
    return CLI_CATALOG[String(cli)] ?? { models: [], note: "Couldn’t load models. Retry." };
  },

  async grants_list({ space: id }) {
    await wait(200);
    space(id);
    return {
      grants: grants.filter((g) => g.to === id).map(({ id: gid, from, path, created }) => ({ id: gid, from, path, created, scope: "always" })),
      incoming: grants.filter((g) => g.from === id).map(({ id: gid, to, path, created }) => ({ id: gid, to, path, created, scope: "always" })),
      problems: grantProblems,
    };
  },
  async grant_revoke({ id }) {
    const g = grants.find((x) => x.id === id);
    if (!g) return false;
    grants = grants.filter((x) => x.id !== id);
    revoked.set(String(id), g);
    return true;
  },
  async grant_restore({ id }) {
    const g = revoked.get(String(id));
    if (!g) throw "That access can’t be put back any more.";
    revoked.delete(String(id));
    grants.push(g);
  },
  async full_access_list() {
    return [...fullAccess];
  },
  async full_access_set({ id, on }) {
    space(id);
    if (on) fullAccess.add(String(id));
    else fullAccess.delete(String(id));
    return !!on;
  },
  async space_workspace_get({ id }) {
    await wait(150);
    const s = space(id);
    const w = workspaces[s.id];
    return w ? { path: w.path, kind: "folder", available: w.available } : { path: `/Users/student/Phaethon/default/spaces/${s.id}`, kind: "managed", available: true };
  },
  async workspace_choose({ token }) {
    await wait(500);
    return { token, path: "/Users/student/Code/phaethon-notes", name: "phaethon-notes" };
  },
  async space_workspace_bind({ id }) {
    const s = space(id);
    workspaces[s.id] = { path: "/Users/student/Code/phaethon-notes", available: true };
    return { path: workspaces[s.id]!.path, kind: "folder", available: true };
  },
  async space_workspace_clear({ id }) {
    const s = space(id);
    delete workspaces[s.id];
    return { path: `/Users/student/Phaethon/default/spaces/${s.id}`, kind: "managed", available: true };
  },
};

export default handlers;
