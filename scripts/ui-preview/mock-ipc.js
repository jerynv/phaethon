// A fake desktop backend for previewing the UI in a plain browser. It answers
// the same commands as src-tauri/src/lib.rs, driven by window.__MOCK__ (set
// by a scenario before this script runs). Never shipped: only shoot.mjs loads it.
(() => {
  const M = (window.__MOCK__ = Object.assign(
    {
      settings: { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5" },
      threads: {},
      // Grants by receiving space: [{ id, from, path, created, scope }]
      grants: {},
      // The vault's spaces; spaces_list returns them most recently used first (lastUsed), then by name.
      spaces: [
        { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 240 },
        { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 },
      ],
      // Events streamed for each agent_send; { waitApproval: true } pauses until answered.
      turn: [{ kind: "text", delta: "Done." }],
      sendError: null,
      // models_list answer; api_key_check answer (null = check the format only).
      models: [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
      ],
      keyCheck: null,
      platform: "mac",
      theme: "light",
    },
    window.__MOCK__ || {},
  ));
  window.__PHAETHON_PLATFORM__ = M.platform;
  const dark = M.theme === "dark";
  const realMatch = window.matchMedia?.bind(window);
  window.matchMedia = (q) =>
    q.includes("prefers-color-scheme")
      ? { matches: q.includes("dark") ? dark : !dark, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
      : realMatch(q);

  const callbacks = {};
  let next = 1;
  const calls = (window.__calls = []);
  let pending = null;
  let pendingAccess = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  M.threadArchive ??= {};
  // { recordTurns: true }: conversations also outlive a page reload (as files do), in this tab only.
  const persist = () => {
    if (!M.recordTurns) return;
    try {
      sessionStorage.setItem("__mockConversations", JSON.stringify({ threads: M.threads, threadArchive: M.threadArchive, currentUpdated: M.currentUpdated }));
    } catch {}
  };
  if (M.recordTurns) {
    try {
      Object.assign(M, JSON.parse(sessionStorage.getItem("__mockConversations") ?? "{}"));
    } catch {}
  }
  const BUSY = "Phaethon is still replying in this space. Stop the reply or wait for it to finish, then try again.";
  // As thread.rs titles a conversation: the first user text, whitespace collapsed, at most 60 characters.
  const titleOf = (msgs) => {
    const first = msgs.find((m) => m.role === "user");
    const t = (first?.text ?? "").split(/\s+/).filter(Boolean).join(" ") || first?.attachments?.[0]?.name;
    if (!t) return "New conversation";
    return [...t].length > 60 ? `${[...t].slice(0, 59).join("").trimEnd()}…` : t;
  };
  // The providers as src-tauri/src/providers.rs has them, and settings_get's view of them.
  const PRESETS = [
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
  const PROVIDER_IDS = Object.fromEntries(PRESETS.map((x) => [x.id, true]));
  const MODEL_ID = /^(?![-./:])(?!.*\.\.)[A-Za-z0-9._:/@+-]{1,200}$/;
  /** The CLI whose own per-space models are in use (lib.rs cli_with_models). */
  const cliWithModels = () => ({ "claude-cli": "claude", "codex-cli": "codex", "gemini-cli": "gemini" })[M.settings.backend] ?? null;
  const baseOf = (x) => (x.editableBase && M.prov?.urls?.[x.id]) || x.base;
  const providerView = () => {
    const P = M.prov;
    const providers = PRESETS.map((x) => {
      const hasKey = x.id === "anthropic" ? !!M.settings.hasAnthropicKey : !!P.keys?.[x.id];
      const baseUrl = baseOf(x);
      const model = x.id === "anthropic" ? M.settings.model : (P.models?.[x.id] ?? null);
      const { base, ...rest } = x;
      return { ...rest, hasKey, baseUrl, defaultBaseUrl: base, model, ready: !!baseUrl && (x.key !== "required" || hasKey) };
    });
    const chosen = providers.find((x) => x.id === (P.provider ?? "anthropic"));
    const defaultModel = chosen.model ? (chosen.id === "anthropic" ? chosen.model : `${chosen.id}:${chosen.model}`) : null;
    return { provider: chosen.id, defaultModel, providerReady: chosen.ready && !!defaultModel, providers };
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    async invoke(cmd, args) {
      calls.push([cmd, JSON.parse(JSON.stringify(args ?? {}))]);
      // Audit hooks: { slow: { cmd: ms } } delays an answer (to show pending
      // states); { fail: { cmd: "message" } } rejects it (to show errors).
      if (M.slow?.[cmd]) await sleep(M.slow[cmd]);
      if (M.fail?.[cmd]) throw M.fail[cmd];
      if (cmd.startsWith("plugin:window|")) return null;
      switch (cmd) {
        case "dev_log": return;
        case "settings_get": return M.prov ? { ...M.settings, ...providerView() } : M.settings;
        case "settings_set_backend": M.settings.backend = args.backend; return;
        case "settings_set_model": M.settings.model = args.model ?? "claude-opus-5-5"; return;
        case "models_list": {
          if (!args.provider || args.provider === "anthropic") return M.models;
          // As providers.rs and openai.rs: a server on this computer that isn't running says so; a list may be refused.
          const preset = PRESETS.find((x) => x.id === args.provider);
          if (preset.local && !M.prov?.running?.[preset.id]) throw `${preset.name} isn’t running at ${baseOf(preset).replace(/\/v1$/, "")}. Open it, then check again.`;
          const list = M.prov?.lists?.[preset.id];
          if (!list) throw `Phaethon couldn’t get the list of models from ${preset.name} just now. You can still type a model’s name.`;
          return list;
        }
        // Providers (src-tauri/src/providers.rs), when a scenario sets M.prov:
        // { provider, keys: { id: true }, models: { id: model }, urls: { id: url }, running: { id: true }, lists: { id: [ModelInfo] } }.
        case "settings_set_provider": M.prov.provider = args.provider; return;
        case "settings_set_provider_model": {
          if (args.model != null && !MODEL_ID.test(args.model)) throw "That isn’t a model name Phaethon can use. It’s one word, like gpt-5 or llama3.2:3b.";
          M.prov.models ??= {};
          M.prov.models[args.provider] = args.model ?? null;
          return;
        }
        case "settings_set_provider_url": {
          if (args.url != null && !/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(args.url))
            throw "That isn’t an address Phaethon can use. It looks like http://127.0.0.1:11434/v1 or https://example.com/v1.";
          M.prov.urls ??= {};
          if (args.url == null) delete M.prov.urls[args.provider];
          else M.prov.urls[args.provider] = args.url.replace(/\/+$/, "");
          return;
        }
        case "provider_status": {
          const preset = PRESETS.find((x) => x.id === args.provider);
          const running = !!M.prov?.running?.[preset.id];
          const models = running ? (M.prov.lists?.[preset.id] ?? []) : [];
          const at = baseOf(preset).replace(/\/v1$/, "");
          return running
            ? { running, models, message: models.length ? `${preset.name} is running, with ${models.length} model${models.length === 1 ? "" : "s"}.` : `${preset.name} is running, but has no models yet. Download one with ollama pull llama3.2 in a terminal, then check again.` }
            : { running, models, message: `${preset.name} isn’t running at ${at}. Open it, then check again.` };
        }
        // A space's own model (space.json "model"), as src-tauri/src/space_model.rs: M.spaceModels[id].
        // With Codex or Gemini CLI answering, its own per-space models instead (space.json "cliModels"): M.cliModels[cli][id].
        case "space_model_get": {
          const cli = cliWithModels();
          if (cli) return M.cliModels?.[cli]?.[args.space] ? `${cli}:${M.cliModels[cli][args.space]}` : null;
          return (M.spaceModels ?? {})[args.space] ?? null;
        }
        case "space_model_set": {
          if (!M.spaces.some((s) => s.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const tagged = /^(claude|codex|gemini):(.*)$/.exec(args.model ?? "");
          const cli = tagged?.[1] ?? (args.model == null ? cliWithModels() : null);
          if (cli) {
            const model = tagged?.[2]?.trim();
            if (model != null && (!MODEL_ID.test(model) || model.length > 100))
              throw "That isn’t a model name Phaethon can pass on: use letters, digits, and . - _ : / only.";
            ((M.cliModels ??= {})[cli] ??= {});
            if (model == null) delete M.cliModels[cli][args.space];
            else M.cliModels[cli][args.space] = model;
            return;
          }
          if (args.model != null && !/^claude-[a-z0-9.-]+$/.test(args.model) && !(args.model.split(":")[0] in PROVIDER_IDS && MODEL_ID.test(args.model.slice(args.model.indexOf(":") + 1))))
            throw "That isn’t a model Phaethon knows how to use.";
          M.spaceModels ??= {};
          if (args.model == null) delete M.spaceModels[args.space];
          else M.spaceModels[args.space] = args.model;
          return;
        }
        case "space_models_list": {
          const cli = cliWithModels();
          if (cli) return Object.fromEntries(Object.entries(M.cliModels?.[cli] ?? {}).map(([id, m]) => [id, `${cli}:${m}`]));
          return { ...(M.spaceModels ?? {}) };
        }
        case "api_key_check": {
          if (M.keyCheck) return M.keyCheck;
          const k = String(args.key ?? "").trim();
          if (args.provider && args.provider !== "anthropic") {
            const name = PRESETS.find((x) => x.id === args.provider).name;
            if (k.startsWith("sk-ant-"))
              return { ok: false, problem: "format", message: `That looks like a key for Anthropic, not ${name}, so it wasn’t sent anywhere. Choose Anthropic as the provider, or paste a ${name} key.` };
            if (k.length < 8 || /\s/.test(k)) return { ok: false, problem: "format", message: `That doesn’t look like a ${name} API key. Copy the whole key again; it’s one line with no spaces.` };
            if (k.includes("deleted")) return { ok: false, problem: "rejected", message: `${name} didn’t accept this key. It may have been deleted, or part of it is missing. Copy it again and paste it here.` };
            return { ok: true, message: "This key works." };
          }
          return k.startsWith("sk-ant-") && k.length > 20
            ? { ok: true, message: "This key works." }
            : { ok: false, problem: "format", message: "That isn’t an Anthropic API key. Keys start with sk-ant-." };
        }
        case "file_open": return;
        case "api_key_set":
          if (!args.provider || args.provider === "anthropic") M.settings.hasAnthropicKey = true;
          if (M.prov) (M.prov.keys ??= {})[args.provider] = true;
          return;
        case "api_key_clear":
          if (!args.provider || args.provider === "anthropic") M.settings.hasAnthropicKey = false;
          if (M.prov) delete (M.prov.keys ??= {})[args.provider];
          return;
        case "appearance_set": M.settings.appearance = args.appearance; return;
        case "spaces_list":
          return [...M.spaces]
            .map((s) => ({ ...s, lastUsed: s.lastUsed ?? null }))
            .sort((a, b) => (b.lastUsed ?? -1) - (a.lastUsed ?? -1) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
        // Contract (src-tauri/src/lib.rs): ids only; the core resolves the folder and refuses anything that isn't a space.
        case "space_touch": {
          const space = M.spaces.find((s) => s.id === args.id);
          if (!space) throw `space "${args.id}" does not exist in this vault`;
          space.lastUsed = Date.now();
          return;
        }
        case "space_show":
          if (!M.spaces.some((s) => s.id === args.id)) throw "That space isn’t in your Phaethon folder any more.";
          return;
        // { exportResult: null } is the save dialog cancelled; M.fail.space_export a failed export.
        case "space_export": {
          if (!M.spaces.some((s) => s.id === args.id)) throw "That space isn’t in your Phaethon folder any more.";
          if (M.exportResult === null) return null;
          const name = M.spaces.find((s) => s.id === args.id).name;
          M.exported = true;
          return M.exportResult ?? { fileName: `${name} 2026-10-10.zip`, files: 12 };
        }
        case "export_show":
          if (!M.exported) throw "There’s no export to show yet.";
          return;
        case "space_create": {
          // As src-tauri/src/spaces.rs: a slug of the name, made unique with -2, -3...
          const name = (args.name ?? "").trim();
          if (!name) throw "A space needs a name.";
          if (name.length > 60) throw "A space’s name can be at most 60 characters.";
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "space";
          let id = base;
          for (let n = 2; M.spaces.some((s) => s.id === id); n++) id = `${base}-${n}`;
          const space = { id, name, description: (args.description ?? "").trim(), hue: Math.round(args.hue ?? 168) };
          M.spaces.push(space);
          return { ...space };
        }
        case "space_update": {
          const space = M.spaces.find((s) => s.id === args.id);
          if (!space) throw `space "${args.id}" does not exist in this vault`;
          if (args.name != null) {
            if (!args.name.trim()) throw "A space needs a name.";
            space.name = args.name.trim();
          }
          if (args.description != null) space.description = args.description.trim();
          if (args.hue != null) space.hue = Math.round(args.hue);
          return { ...space };
        }
        // As thread.rs returns them: each message carries its index and its records.
        case "thread_load":
          // `at` only where a scenario gives one (older saves have none).
          return (M.threads[args.space] ?? []).map((m, i) => ({ index: i, records: [], attachments: [], ...m }));
        // Conversations, as src-tauri/src/thread.rs keeps them: M.threads[space] is the
        // current one, M.threadArchive[space] = [{ id, updated, messages }] the saved ones.
        case "thread_new":
        case "thread_open": {
          if (window.__liveTurn && M.currentSpace === args.space) throw BUSY;
          const archive = (M.threadArchive[args.space] ??= []);
          const chosen = cmd === "thread_open" ? archive.find((t) => t.id === args.id) : null;
          if (cmd === "thread_open" && args.id === "current") return;
          if (cmd === "thread_open" && !chosen) throw "That conversation couldn’t be opened: that conversation is no longer there";
          const current = M.threads[args.space] ?? [];
          if (current.length) archive.push({ id: String(Date.now()), updated: M.currentUpdated?.[args.space] ?? Date.now(), messages: current });
          M.threads[args.space] = chosen ? chosen.messages : [];
          (M.currentUpdated ??= {})[args.space] = chosen ? chosen.updated : Date.now();
          if (chosen) archive.splice(archive.indexOf(chosen), 1);
          persist();
          return;
        }
        case "thread_delete": {
          // Contract: deletes a saved past conversation for good; the current one ("current") is emptied. Refused while a reply runs there.
          if (window.__liveTurn && M.currentSpace === args.space) throw BUSY;
          if (args.id === "current") {
            M.threads[args.space] = [];
            return;
          }
          const archive = M.threadArchive[args.space] ?? [];
          if (!archive.some((t) => t.id === args.id)) throw "That conversation couldn’t be deleted: it is no longer there.";
          M.threadArchive[args.space] = archive.filter((t) => t.id !== args.id);
          return;
        }
        // Clear and Delete everything (src-tauri/src/memory.rs). M.keep: the details Clear keeps;
        // M.clearFails: a reason the details can't be picked out (nothing changes); M.preview /
        // M.forgotten: what Delete everything says it takes and took.
        case "thread_forget_preview":
        case "thread_clear":
        case "thread_forget": {
          if (cmd !== "thread_forget_preview" && window.__liveTurn && M.currentSpace === args.space) throw BUSY;
          const archive = M.threadArchive[args.space] ?? [];
          const msgs = args.id === "current" ? M.threads[args.space] ?? [] : archive.find((t) => t.id === args.id)?.messages;
          if (!msgs) throw "That conversation couldn’t be read: that conversation is no longer there";
          const files = msgs.reduce((n, m) => n + (m.attachments?.length ?? 0), 0);
          if (cmd === "thread_forget_preview") return M.preview ?? { files, sharedFiles: 0, facts: 0 };
          if (cmd === "thread_clear" && M.clearFails) return { status: "notKept", reason: M.clearFails };
          if (args.id === "current") M.threads[args.space] = [];
          else M.threadArchive[args.space] = archive.filter((t) => t.id !== args.id);
          if (cmd === "thread_forget") return M.forgotten ?? { files, filesLeft: 0, facts: 0 };
          const kept = M.keep ?? ["Test 1 for C241 is on Thursday.", "Problem set 4 is due Wednesday."];
          (M.memory ??= {})[args.space] = [...(M.memory[args.space] ?? []), ...kept];
          return { status: "cleared", kept };
        }
        case "claude_cli_status":
          // Contract: whether the claude command is installed (and where). Never says anything about the login.
          return M.claudeCli ?? { installed: true, path: "/Users/you/.local/bin/claude" };
        case "agent_clis_status":
          // Contract (agent::CliInfo): installed, signed in only where the CLI itself says (Codex), the sign-in command,
          // and whether it has a setup of its own for the vault (Codex and Gemini CLI always).
          return (
            M.clis ?? [
              { id: "claude", name: "Claude Code", installed: M.claudeCli?.installed ?? true, loggedIn: null, loginCommand: "claude", supported: true, ownHome: false },
              { id: "codex", name: "Codex", installed: true, loggedIn: true, loginCommand: 'CODEX_HOME="/Users/you/Library/Application Support/app.phaethon/claude-config/default-codex" codex login', supported: true, ownHome: true },
              { id: "gemini", name: "Gemini CLI", installed: true, loggedIn: null, loginCommand: 'GEMINI_CLI_HOME="/Users/you/Library/Application Support/app.phaethon/claude-config/default-gemini" gemini', supported: true, ownHome: true },
              { id: "opencode", name: "OpenCode", installed: false, loggedIn: null, loginCommand: "opencode auth login", supported: false, ownHome: false },
            ]
          );
        // Settings' sign-in to Codex or Gemini CLI for the vault's own setup (agent/sign_in.rs). M.signIn[cli]:
        // { status, message } answered after M.signInDelay ms (default 300), or { hold: true } to wait until
        // window.__signInDone(outcome) or a cancel. Signed in to Codex marks it signed in for agent_clis_status.
        case "agent_cli_sign_in": {
          const name = args.cli === "codex" ? "Codex" : "Gemini CLI";
          const plan = M.signIn?.[args.cli] ?? { status: "signedIn", message: `Signed in to ${name} for this Phaethon folder.` };
          if (M.signInWaiting) return { status: "busy", message: `Phaethon is already waiting for you to sign in to ${name}.` };
          const out = await new Promise((resolve) => {
            M.signInWaiting = resolve;
            window.__signInDone = resolve;
            if (!plan.hold) setTimeout(() => resolve(plan), M.signInDelay ?? 300);
          });
          M.signInWaiting = null;
          if (out.status === "signedIn" && args.cli === "codex" && M.clis) M.clis = M.clis.map((c) => (c.id === "codex" ? { ...c, loggedIn: true } : c));
          return out;
        }
        // Each CLI's own model list (agent/models.rs), as the installed versions gave it (Oct 2026). M.cliLists[cli]
        // replaces one ({ models, note }); M.cliListDelay delays the answer (to show "Asking…").
        case "agent_cli_models": {
          if (M.cliListDelay) await sleep(M.cliListDelay);
          const own = M.cliLists?.[args.cli];
          if (own) return typeof own === "function" ? own() : own;
          if (args.cli === "codex")
            return {
              models: [
                { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work." },
                { id: "gpt-6-astra", name: "GPT-6-Astra", description: "Frontier intelligence for the most demanding work." },
                { id: "gpt-6-luna", name: "GPT-6-Luna", description: "Fast and affordable model for easier tasks." },
              ],
            };
          if (args.cli === "claude")
            return {
              models: ["fable", "opus", "sonnet"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
              note: "Claude Code can’t list its models: these are the names its help gives, each its newest model of that kind. Another model… takes a model’s full name.",
            };
          return {
            models: [["auto", "Auto"], ["pro", "Pro"], ["flash", "Flash"], ["flash-lite", "Flash-Lite"]].map(([id, name]) => ({ id, name })),
            note: "Gemini CLI can’t list its models: these are the choices its own model menu offers. Another model… takes a model’s full name.",
          };
        }
        case "agent_cli_sign_in_cancel": {
          if (!M.signInWaiting) return false;
          M.signInWaiting({ status: "cancelled", message: `Signing in to ${args.cli === "codex" ? "Codex" : "Gemini CLI"} was stopped.` });
          return true;
        }
        case "threads_list": {
          const summary = (id, messages, updated, current) => ({ id, title: titleOf(messages), updated, messages: messages.length, current });
          const rest = (M.threadArchive[args.space] ?? [])
            .map((t) => summary(t.id, t.messages, t.updated, false))
            .sort((a, b) => b.updated - a.updated);
          return [summary("current", M.threads[args.space] ?? [], M.currentUpdated?.[args.space] ?? Date.now(), true), ...rest];
        }
        // ---- Earlier Claude Code conversations (src-tauri/src/cli_import.rs, f17) ----
        // M.cliImport: { offered?: bool, found: [{ messages, updated }] }. Offered when Claude Code answers or
        // `offered` says Claude Code kept transcripts here; a run moves what was found into the archive once
        // and says their titles, refused while a reply runs in the space.
        case "cli_import_offered":
          return M.cliImport?.offered ?? M.settings.backend === "claude-cli";
        case "cli_import_run": {
          if (window.__liveTurn && M.currentSpace === args.space) throw BUSY;
          (M.cliImportRuns ??= []).push(args.space);
          await sleep(M.cliImport?.delay ?? 120);
          const found = M.cliImport?.found ?? [];
          if (M.cliImport) M.cliImport.found = [];
          const archive = (M.threadArchive[args.space] ??= []);
          found.forEach((t, i) => archive.push({ id: `${t.updated}-${i}`, updated: t.updated, messages: t.messages }));
          persist();
          return found.map((t) => titleOf(t.messages));
        }
        // ---- end earlier Claude Code conversations ----
        case "grants_list": {
          const incoming = Object.entries(M.grants).flatMap(([to, gs]) => gs.filter((g) => g.from === args.space).map((g) => ({ ...g, to })));
          return { grants: M.grants[args.space] ?? [], incoming, problems: M.grantProblems ?? [] };
        }
        case "grant_restore": {
          // As the core: only a grant revoked here can come back, once, exactly as it was.
          const r = M.revokedGrants?.[args.id];
          if (!r) throw "That access can’t be put back any more.";
          delete M.revokedGrants[args.id];
          const list = (M.grants[r.to] ??= []);
          if (!list.some((g) => g.id === args.id)) list.push(r.grant);
          return;
        }
        case "grant_revoke": {
          for (const k of Object.keys(M.grants)) {
            const before = M.grants[k].length;
            const gone = M.grants[k].find((g) => g.id === args.id);
            if (gone) (M.revokedGrants ??= {})[args.id] = { to: k, grant: gone };
            M.grants[k] = M.grants[k].filter((g) => g.id !== args.id);
            if (M.grants[k].length !== before) return true;
          }
          return false;
        }
        case "agent_access_answer": {
          const ok = pendingAccess && pendingAccess.id === args.id;
          if (ok) pendingAccess.resolve(args.answer);
          return !!ok;
        }
        case "agent_cancel": {
          // A held-open reply ends as the real backend does: Cancelled, then End.
          const live = window.__liveTurn;
          if (!live) return false;
          window.__liveTurn = null;
          live.send({ kind: "record", record: { kind: "stopped" } });
          live.send({ kind: "cancelled" });
          live.send({ kind: "end", sessionId: null });
          return true;
        }
        case "agent_approve": {
          const ok = pending && pending.id === args.id;
          if (ok) pending.resolve(args.allow);
          return !!ok;
        }
        // As src-tauri/src/search.rs: case- and accent-insensitive, in the shown text of every
        // conversation of the space (or every space), newest first, 3 snippets each.
        case "conversations_search": {
          const fold = (text) => {
            let out = "";
            const at = [];
            [...text].forEach((ch, i, all) => {
              const start = all.slice(0, i).join("").length;
              for (const f of ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()) {
                out += f;
                at.push([start, start + ch.length]);
              }
            });
            return { out, at };
          };
          const needle = fold(String(args.query).trim().replace(/\s+/g, " ")).out;
          const spaces = args.allSpaces ? M.spaces.map((s) => s.id) : [args.space];
          const found = [];
          for (const space of spaces) {
            const convs = [
              { id: "current", messages: M.threads[space] ?? [], updated: M.currentUpdated?.[space] ?? Date.now(), current: true },
              ...(M.threadArchive[space] ?? []).map((t) => ({ ...t, current: false })),
            ];
            for (const c of convs) {
              let matches = 0;
              const snippets = [];
              c.messages.forEach((m, pos) => {
                const text = m.text ?? "";
                const f = fold(text);
                for (let i = f.out.indexOf(needle); needle && i >= 0; i = f.out.indexOf(needle, i + needle.length)) {
                  matches++;
                  if (snippets.length >= 3) continue;
                  const [a, b] = [f.at[i][0], f.at[i + needle.length - 1][1]];
                  snippets.push({ message: pos, role: m.role, before: text.slice(Math.max(0, a - 48), a), matched: text.slice(a, b), after: text.slice(b, b + 96) });
                }
              });
              if (matches) found.push({ space, threadId: c.id, title: titleOf(c.messages), updated: c.updated, current: c.current, matches, snippets });
            }
          }
          found.sort((a, b) => b.updated - a.updated);
          return { conversations: found.slice(0, 50), truncated: found.length > 50 };
        }
        // lms (UI team)
        // Course sites, as the contract in src/lib/lms.ts: they belong to the vault. M.lms: { schools, courses,
        // list: [connection] (or, as before, connections: { space: [...] }: those are joined into one list and each
        // space sees all of the courses imported in its own), connect: "ok" | "cancelled" | "<error>", connectHold
        // (resolve with window.__lmsSignIn(result)), signedOut (lms_courses refuses), failCourse (an id whose import
        // fails), signedOutAt (an id where the session ends mid-import: error "signedOut", then done), skipped:
        // { id: [...] }, step (ms) }. M.courseAccess: { space: { "<connection>/<course>": parts } }.
        case "lms_schools":
        case "lms_connect":
        case "lms_connections":
        case "lms_courses":
        case "lms_import":
        case "lms_disconnect":
        case "course_access_get":
        case "course_access_set": {
          const L = (M.lms ??= {});
          const A = (M.courseAccess ??= {});
          const ALL = ["overview", "syllabus", "assignments", "announcements", "files", "grades"];
          if (!L.list) {
            L.list = [];
            for (const [space, cs] of Object.entries(L.connections ?? {})) {
              for (const c of cs) {
                let mine = L.list.find((x) => x.id === c.id && x.address === c.address);
                if (!mine) {
                  // Two spaces' connections with one id but different sites stay apart.
                  mine = { ...c, id: L.list.some((x) => x.id === c.id) ? `${c.id}-${space}` : c.id, courses: [...c.courses] };
                  L.list.push(mine);
                }
                for (const id of c.courses) {
                  if (!mine.courses.includes(id)) mine.courses.push(id);
                  ((A[space] ??= {})[`${mine.id}/${id}`] ??= [...ALL]);
                }
              }
            }
          }
          L.schools ??= [
            { name: "Indiana University Bloomington", address: "https://iu.instructure.com" },
            { name: "Indiana University Indianapolis", address: "https://iu.instructure.com" },
            { name: "Indiana State University", address: "https://indstate.instructure.com" },
          ];
          L.courses ??= [
            { id: "101", name: "Discrete Structures for Computer Science", code: "CSCI-C 241", term: "Fall 2026", current: true },
            { id: "102", name: "Calculus II", code: "MATH-M 212", term: "Fall 2026", current: true },
            { id: "103", name: "Introduction to Psychology", code: "PSY-P 101", term: "Fall 2026", current: true },
            { id: "90", name: "Introduction to Programming", code: "CSCI-C 200", term: "Spring 2026", current: false },
            { id: "91", name: "Writing and Research", code: "ENG-W 131", term: "Spring 2026", current: false },
          ];
          const spaceOk = (s) => {
            if (!M.spaces.some((x) => x.id === s)) throw `space "${s}" does not exist in this vault`;
          };
          const find = (id) => {
            const c = L.list.find((x) => x.id === id);
            if (!c) throw "That course site isn’t connected.";
            return c;
          };
          const imported = () =>
            L.list.flatMap((c) =>
              c.courses.map((id) => {
                const x = L.courses.find((k) => k.id === id) ?? { name: id };
                return { key: `${c.id}/${id}`, connection: c.id, courseId: id, name: x.name, ...(x.code ? { code: x.code } : {}), ...(x.term ? { term: x.term } : {}), folder: `courses/${x.name}`, ...(L.material?.[id] ? { material: L.material[id] } : {}) };
              }),
            ).sort((a, b) => a.name.localeCompare(b.name));
          if (cmd === "course_access_get") {
            if (args.space != null) spaceOk(args.space);
            const courses = imported();
            const keys = new Set(courses.map((c) => c.key));
            const access = {};
            for (const [s, m] of Object.entries(A)) {
              if (args.space != null && s !== args.space) continue;
              access[s] = Object.fromEntries(Object.entries(m).filter(([k, p]) => keys.has(k) && p.length));
            }
            return { spaces: M.spaces.map((s) => s.id).sort(), courses, access, problems: L.accessProblems ?? [] };
          }
          if (cmd === "course_access_set") {
            spaceOk(args.space);
            if (!imported().some((c) => c.key === args.course)) throw "That course isn’t imported.";
            if (L.accessFail) throw L.accessFail;
            const parts = ALL.filter((p) => args.parts.includes(p));
            if (parts.length) (A[args.space] ??= {})[args.course] = parts;
            else delete A[args.space]?.[args.course];
            return;
          }
          if (cmd === "lms_schools") {
            if (args.kind !== "canvas") return [];
            const q = String(args.query ?? "").trim().toLowerCase();
            if (q.length < 2) return [];
            return L.schools.filter((s) => s.name.toLowerCase().includes(q) || s.address.includes(q));
          }
          if (cmd === "lms_connections") return L.list.map((c) => ({ ...c, courses: [...c.courses] }));
          if (cmd === "lms_connect") {
            const result = L.connectHold ? await new Promise((r) => (window.__lmsSignIn = r)) : (await sleep(L.connectDelay ?? 300), L.connect ?? "ok");
            if (result === "cancelled") throw "cancelled";
            if (result !== "ok") throw result;
            const address = /^https:\/\//.test(args.address) ? args.address.replace(/\/+$/, "") : `https://${args.address.replace(/\/+$/, "")}`;
            let c = L.list.find((x) => x.kind === args.kind && x.address === address);
            if (!c) {
              const school = L.schools.find((s) => s.address === address);
              c = { id: `c${L.list.length + 1}`, kind: args.kind, address, schoolName: school?.name, signedIn: true, courses: [] };
              L.list.push(c);
            }
            c.signedIn = true;
            L.signedOut = false;
            return { ...c, courses: [...c.courses] };
          }
          if (cmd === "lms_disconnect") {
            // Sign out: the connection, its courses and who sees them stay.
            find(args.connection).signedIn = false;
            return;
          }
          const c = find(args.connection);
          if (cmd === "lms_courses") {
            if (L.signedOut || !c.signedIn) {
              c.signedIn = false;
              throw "You’ve been signed out of your course site. Sign in again.";
            }
            return L.courses.map((x) => ({ ...x, imported: c.courses.includes(x.id) }));
          }
          // lms_import: per course a few steps, then its summary; a failed course is an error event and the import goes on.
          for (const s of args.spaces ?? []) spaceOk(s);
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          // As service.rs: the step codes the core sends, each with its own count.
          const STEPS = [["reading", 0, 1], ["reading", 1, 1], ["files", 0, 4], ["files", 2, 4], ["files", 4, 4], ["readings", 0, 1], ["readings", 1, 1], ["writing", 0, 1]];
          for (const courseId of args.courseIds) {
            const course = L.courses.find((x) => x.id === courseId);
            for (let i = 0; i < STEPS.length; i++) {
              await sleep(L.step ?? 60);
              const [step, done, total] = STEPS[i];
              send({ type: "progress", course: courseId, step, done, total });
              if ((courseId === L.failCourse || courseId === L.signedOutAt) && i === 0) break;
            }
            await sleep(L.step ?? 60);
            if (courseId === L.signedOutAt) {
              send({ type: "error", message: "signedOut" });
              break;
            }
            if (courseId === L.failCourse) {
              send({ type: "error", message: `${course?.name ?? "This course"}: the site said you don’t have access to it any more.` });
              continue;
            }
            // A course imported for the first time: the chosen spaces see all of it.
            if (!c.courses.includes(courseId)) {
              c.courses.push(courseId);
              for (const s of args.spaces ?? []) (A[s] ??= {})[`${c.id}/${courseId}`] = [...ALL];
            }
            send({
              type: "course",
              course: courseId,
              folder: `courses/${course?.name ?? courseId}`,
              files: 12 + Number(courseId) % 7,
              readings: Number(courseId) % 4,
              links: 5,
              skipped: L.skipped?.[courseId] ?? [],
              // f18: what its documents are made of (L.material { courseId: MaterialSummary }).
              ...(L.material?.[courseId] ? { material: L.material[courseId] } : {}),
            });
          }
          c.lastSync = Date.now();
          send({ type: "done" });
          return;
        }

        // lms grades (Grades core). As src/lib/lms.ts (CourseGradeView, LmsGradesEvent). M.lmsGrades: { [space]: CourseGradeView[] }
        // (default: three courses of the space's first connection), M.lmsGradesSignedOut (refresh ends "signedOut"),
        // M.lmsGradesFail (a course id whose refresh fails), M.lmsGradesStep (ms), M.lmsGradesNewlyGraded (see the refresh).
        case "lms_grades":
        case "lms_grades_refresh": {
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const G = (M.lmsGrades ??= {});
          // The first site whose courses the space may see grades of (or, as before, its own first connection).
          const seesGrades = Object.entries(M.courseAccess?.[args.space] ?? {}).filter(([, p]) => p.includes("grades")).map(([k]) => k.split("/")[0]);
          const conn = M.lms?.connections?.[args.space]?.[0]?.id ?? M.lms?.list?.find((c) => seesGrades.includes(c.id))?.id;
          // A space that sees no grades has none (unless a scenario sets them).
          if (!conn && !G[args.space]) {
            if (cmd === "lms_grades") return [];
            throw "That course site isn’t connected in this space any more.";
          }
          const day = 86400000;
          const at = (d) => new Date(Date.now() + d * day).toISOString();
          const item = (title, group, score, possible, extra = {}) => ({
            title, group, score, possible, percent: score != null && possible ? Math.round((score / possible) * 10000) / 100 : undefined,
            submitted: score != null, graded: score != null, late: false, missing: false, excused: false, comments: [], ...extra,
          });
          G[args.space] ??= [
            {
              connection: conn, courseId: "102", course: "Calculus II", folder: "courses/Calculus II", updated: Date.now() - 2 * 3600000,
              current: { percent: 78.6, letter: "C+" },
              groups: [{ name: "Homework", weight: 30 }, { name: "Quizzes", weight: 20 }, { name: "Exams", weight: 50 }],
              items: [
                item("Homework 1", "Homework", 18, 20, { due: at(-30) }),
                item("Homework 2", "Homework", 0, 20, { due: at(-16), missing: true, submitted: false }),
                item("Quiz 1", "Quizzes", 8, 10, { due: at(-12) }),
                item("Midterm 1", "Exams", 81, 100, { due: at(-6), comments: ["Review integration by parts before the next exam."] }),
                item("Homework 3", "Homework", undefined, 20, { due: at(3) }),
              ],
            },
            {
              connection: conn, courseId: "101", course: "Discrete Structures for Computer Science", folder: "courses/Discrete Structures for Computer Science",
              updated: Date.now() - 2 * 3600000,
              current: { percent: 91.25, letter: "A-", points: 146, possible: 160 }, final: { percent: 42.1, letter: "F" },
              groups: [{ name: "Problem sets" }, { name: "Labs" }],
              items: [
                item("Problem set 1", "Problem sets", 47, 50, { due: at(-28), comments: ["Clean proofs.", "Watch the base case in 3b."] }),
                item("Problem set 2", "Problem sets", 41, 50, { due: at(-14), late: true }),
                item("Lab 1", "Labs", 30, 30, { due: at(-21) }),
                item("Lab 2", "Labs", 28, 30, { due: at(-7) }),
                item("Problem set 3", "Problem sets", undefined, 50, { due: at(-1), submitted: true }),
                item("Lab 3", "Labs", undefined, 30, { due: at(-2), excused: true, graded: true }),
              ],
            },
            {
              connection: conn, courseId: "103", course: "Introduction to Psychology", folder: "courses/Introduction to Psychology",
              updated: Date.now() - 2 * 3600000, current: {}, groups: [], items: [],
              note: "Your course site doesn’t show you grades for this course.",
            },
          ];
          if (cmd === "lms_grades") return G[args.space].map((g) => structuredClone(g));
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          const mine = G[args.space].filter((g) => g.connection === args.connection);
          for (let n = 0; n < mine.length; n++) {
            const g = mine[n];
            await sleep(M.lmsGradesStep ?? 60);
            send({ type: "progress", course: g.courseId, step: "grades", done: n, total: mine.length });
            if (M.lmsGradesSignedOut) {
              send({ type: "error", message: "signedOut" });
              break;
            }
            if (g.courseId === M.lmsGradesFail) {
              send({ type: "error", message: `${g.course}: Your course site answered with an error (500).` });
              continue;
            }
            g.updated = Date.now();
            // M.lmsGradesNewlyGraded: { course, title, score, comments? } is graded by a refresh.
            const ng = M.lmsGradesNewlyGraded;
            const it = ng && ng.course === g.courseId && g.items.find((x) => x.title === ng.title && !x.graded);
            if (it) Object.assign(it, { score: ng.score, percent: it.possible ? Math.round((ng.score / it.possible) * 10000) / 100 : undefined, graded: true, comments: ng.comments ?? [] });
            send({ type: "course", course: g.courseId, grades: structuredClone(g) });
          }
          send({ type: "done" });
          return;
        }
        // study (UI)
        // Study, as the contract in src/lib/study.ts. M.study: { decks: { path: { title, course?, sources, cards:
        // [{ front, back }] } }, quizzes: { path: quiz }, progress: { cardId: { confidence, due } }, streakDays,
        // courses: [{ course, folder }] (what lms_grades gives), makeError (study_make_* sends it as an error),
        // reviewSummary, step (ms) }. A card is due when it has no progress or its due time has passed.
        case "study_overview":
        case "study_deck":
        case "study_deck_save":
        case "study_session":
        case "study_rate":
        case "study_make_deck":
        case "study_make_quiz":
        case "study_quiz":
        case "study_quiz_submit":
        case "study_review_mistakes":
        case "study_delete":
        case "study_sources": {
          const S = (M.study ??= {});
          S.decks ??= {};
          S.quizzes ??= {};
          S.progress ??= {};
          S.attempts ??= {};
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          if (cmd === "study_sources")
            return (S.courses ?? []).map((c) => ({ name: c.course, folder: c.folder, syllabus: true, assignments: true, files: true, readings: true }));
          const inSpace = (p) => typeof p === "string" && !p.startsWith("/") && !p.split("/").includes("..");
          if (args.path != null && !inSpace(args.path)) throw "That isn’t a file in this space.";
          const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
          const cardsOf = (path) =>
            (S.decks[path]?.cards ?? []).map((c) => {
              const id = hash(`${path}\n${c.front}`);
              // A scenario may give a card's starting progress on the card itself ({ confidence, due }).
              const p = S.progress[id] ?? (c.confidence ? { confidence: c.confidence, due: c.due ?? 0 } : null);
              return { id, kind: /\{\{.+?\}\}/.test(c.front) ? "cloze" : "basic", front: c.front, back: c.back ?? "", ...(c.source ? { source: c.source } : {}), ...(c.quote ? { quote: c.quote } : {}), ...(c.picture ? { picture: c.picture } : {}), ...(p ? { confidence: p.confidence, due: p.due } : {}) };
            });
          const now = Date.now();
          const isDue = (c) => c.due == null || c.due <= now;
          const stream = () => {
            const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
            let index = 0;
            // As Tauri does (ipc/channel.rs): a message of 8192 bytes of JSON or more is fetched by the page, so it arrives after the command has returned.
            return (message) => {
              const m = { index: index++, message };
              if (JSON.stringify(message).length >= 8192) setTimeout(() => callbacks[id]?.(m), 40);
              else callbacks[id]?.(m);
            };
          };
          const titleFile = (dir, title, ext) => `study/${dir}/${title.replace(/[\\/:*?"<>|]/g, "-")}.${ext}`;
          switch (cmd) {
            case "study_overview": {
              const decks = Object.entries(S.decks).map(([path, d]) => {
                const cards = cardsOf(path);
                const recent = cards.filter((c) => c.confidence != null);
                return {
                  path,
                  title: d.title,
                  course: d.course,
                  cards: cards.length,
                  due: cards.filter((c) => c.confidence != null && isDue(c)).length + cards.filter((c) => c.confidence == null).length,
                  new: cards.filter((c) => c.confidence == null).length,
                  mastery: cards.length ? recent.filter((c) => c.confidence >= 4).length / cards.length : 0,
                  updated: d.updated ?? now,
                };
              });
              const quizzes = Object.entries(S.quizzes).map(([path, q]) => ({ path, title: q.title, course: q.course, questions: q.questions.length, lastScore: q.lastScore, lastTaken: q.lastTaken }));
              return { decks, quizzes, due: decks.reduce((n, d) => n + d.due, 0), streakDays: S.streakDays ?? 0 };
            }
            case "study_deck": {
              const d = S.decks[args.path];
              if (!d) throw "That deck isn’t in this space any more.";
              return { path: args.path, title: d.title, course: d.course, sources: d.sources ?? [], cards: cardsOf(args.path) };
            }
            case "study_deck_save": {
              const title = String(args.title ?? "").trim();
              if (!title) throw "A deck needs a name.";
              for (const c of args.cards) if (!c.front.trim() || (!c.back.trim() && !/\{\{.+?\}\}/.test(c.front))) throw "Every card needs a front and a back.";
              const path = args.path || titleFile("decks", title, "md");
              const d = (S.decks[path] ??= { title, sources: [] });
              d.title = title;
              // Progress follows the front (the card's id), as in the core.
              const old = d.cards ?? [];
              d.cards = args.cards.map((c) => ({ ...old.find((o) => o.front === c.front), front: c.front, back: c.back }));
              d.updated = now;
              return path;
            }
            case "study_session": {
              const paths = args.paths ?? Object.keys(S.decks);
              const cards = paths.flatMap((p) => cardsOf(p).filter(isDue).map((c) => ({ ...c, deck: p })));
              return cards.slice(0, args.limit ?? 40);
            }
            case "study_rate": {
              if (M.fail?.study_rate_once) {
                const m = M.fail.study_rate_once;
                delete M.fail.study_rate_once;
                throw m;
              }
              const conf = Number(args.confidence);
              if (!(conf >= 1 && conf <= 5)) throw "A rating is from 1 to 5.";
              const days = [0, 0, 1, 3, 7][conf - 1];
              const due = now + (days ? days * 86400000 : 60000);
              S.progress[args.card] = { confidence: conf, due };
              (S.rated ??= []).push([args.card, conf]);
              return { due, again: conf <= 2 };
            }
            case "study_make_deck":
            case "study_make_quiz": {
              const send = stream();
              const quiz = cmd === "study_make_quiz";
              if (!args.sources?.length) throw "Choose what to make them from.";
              if (!args.sources.every(inSpace)) throw "That isn’t a file in this space.";
              // The core's steps (study/grounded.rs): mapping when the course has no fresh scope map, then reading,
              // making, checking (with kept and dropped so far) and saving. S.makeSteps overrides them.
              const count = Number(args.options.count) || 10;
              const course = args.sources[0].split("/").slice(0, 2).join("/");
              const view = S.scopeViews?.[course];
              const steps = S.makeSteps ?? [
                ...(view && view.state !== "fresh" ? [["mapping", 0, 2], ["mapping", 1, 2]] : []),
                ["reading", 0, 1],
                ["reading", 1, 1],
                ["making", 0, 3],
                ["checking", 0, count, 0, 0],
                ["checking", count, count, count, 1],
                ["saving", 0, 1],
              ];
              // An exam whose scope isn't known (S.unknownScopes, as the core finds it) and that the person
              // hasn't said (S.statedScopes): needsScope, then the core's error, nothing made.
              const exam = args.options.exam;
              const needsScope = exam && (S.unknownScopes ?? []).includes(exam) && !S.statedScopes?.[exam];
              for (const [step, done, total, kept, dropped] of needsScope ? steps.filter((s) => s[0] === "mapping").concat([["mapping", 2, 2]]) : steps) {
                await sleep(S.step ?? 60);
                send({ type: "progress", step, done, total, ...(kept != null ? { kept, dropped } : {}) });
                if (S.makeError) break;
              }
              await sleep(S.step ?? 60);
              if (needsScope) {
                const name = (S.courses ?? []).find((c) => c.folder === course)?.course ?? course;
                send({ type: "needsScope", course, courseName: name, exam });
                send({ type: "error", message: `I couldn’t find what ${exam} covers in your ${name} materials, so I haven’t made anything: I won’t guess. Tell me what it covers (for example “through HW 6, not graphs”) and I’ll make it from that.` });
                return;
              }
              if (S.makeError) {
                send({ type: "error", message: S.makeError });
                return;
              }
              const title = args.options.title || (args.options.fromAttempt ? "Mistakes to review" : args.options.focus ? `Cards on ${args.options.focus}` : quiz ? "Practice quiz" : "New cards");
              if (quiz) {
                const kinds = args.options.kinds?.length ? args.options.kinds : ["choice"];
                const path = titleFile("quizzes", title, "json");
                const questions = Array.from({ length: count }, (_, i) => {
                  const kind = kinds[i % kinds.length];
                  return kind === "truefalse"
                    ? { id: `q${i + 1}`, kind, prompt: `Statement ${i + 1} is true.`, choices: ["True", "False"], answer: "True", explanation: "It is." }
                    : { id: `q${i + 1}`, kind: "choice", prompt: `Question ${i + 1}?`, choices: ["A", "B", "C"], answer: "A", explanation: "A is right." };
                });
                S.quizzes[path] = { title, sources: args.sources, created: now, questions };
                send({ type: "done", path, questions: count });
              } else {
                const path = titleFile("decks", title, "md");
                S.decks[path] = { title, sources: args.sources, updated: now, cards: Array.from({ length: count }, (_, i) => ({ front: `New card ${i + 1}?`, back: `Answer ${i + 1}.` })) };
                send({ type: "done", path, cards: count });
              }
              return;
            }
            case "study_quiz": {
              const q = S.quizzes[args.path];
              if (!q) throw "That quiz isn’t in this space any more.";
              return q;
            }
            case "study_quiz_submit": {
              const q = S.quizzes[args.path];
              if (!q) throw "That quiz isn’t in this space any more.";
              const send = stream();
              const norm = (s) => String(s ?? "").trim().toLowerCase();
              const shorts = q.questions.filter((x) => x.kind === "short").length;
              for (let i = 0; i < shorts; i++) {
                await sleep(S.step ?? 60);
                send({ type: "progress", step: "checking short answers", done: i + 1, total: shorts });
              }
              if (S.gradeError) {
                send({ type: "error", message: S.gradeError });
                return;
              }
              const results = q.questions.map((x) => {
                const given = args.answers[x.id] ?? (x.kind === "multi" ? [] : "");
                let correct = false;
                let partial;
                if (x.kind === "multi") {
                  const want = new Set(x.answer);
                  const got = new Set(given);
                  const hits = [...got].filter((g) => want.has(g)).length;
                  const wrong = [...got].filter((g) => !want.has(g)).length;
                  correct = hits === want.size && wrong === 0;
                  if (!correct && hits > wrong) partial = (hits - wrong) / want.size;
                } else if (x.kind === "short") {
                  const words = norm(x.answer).split(/\W+/).filter((w) => w.length > 3);
                  const found = words.filter((w) => norm(given).includes(w)).length;
                  correct = words.length > 0 && found === words.length;
                  if (!correct && found > 0) partial = found / words.length;
                } else correct = norm(given) === norm(x.answer);
                const feedback = correct ? x.explanation : `${x.explanation}${x.source ? ` See ${x.source.split("/").pop()}.` : ""}`;
                return { id: x.id, correct, ...(partial ? { partial } : {}), given, expected: x.answer, feedback };
              });
              const score = results.reduce((n, r) => n + (r.correct ? 1 : r.partial ?? 0), 0) / results.length;
              const taken = now;
              const attempt = { path: `.phaethon/study/attempts/${args.path.split("/").pop().replace(/\.json$/, "")}-${taken}.json`, quiz: args.path, taken, score, results };
              S.attempts[attempt.path] = attempt;
              q.lastScore = score;
              q.lastTaken = taken;
              send({ type: "done", attempt });
              return;
            }
            case "study_review_mistakes": {
              const send = stream();
              if (!S.attempts[args.attemptPath]) throw "That attempt isn’t saved any more.";
              await sleep(S.step ?? 60);
              send({ type: "progress", step: "reading what you missed", done: 1, total: 1 });
              await sleep(S.step ?? 60);
              if (S.makeError) {
                send({ type: "error", message: S.makeError });
                return;
              }
              send({ type: "done", summary: S.reviewSummary ?? "## Graph colouring\n\nYou mixed up the **chromatic number** with the degree. Reread *Notes, week 6*.\n\n- Redo exercises 6.2 and 6.4\n- Then make cards from these mistakes" });
              return;
            }
            case "study_delete": {
              if (!S.decks[args.path] && !S.quizzes[args.path]) throw "That isn’t in this space any more.";
              delete S.decks[args.path];
              delete S.quizzes[args.path];
              return;
            }
          }
          return;
        }
        // plan and tutor modes (UI)
        // As src-tauri/src/plan.rs and tutor_mode.rs. M.upcoming: { space: [{ course, folder, title, dueIn (days), link }] }
        // (dates relative to now); M.exams: { space: [...] }; M.planState: { space: {...} }; M.planSaved: { space: markdown };
        // M.tutorModes: { space: mode }.
        case "space_tutor_mode_set": {
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          if (!["normal", "quiz", "explain", "socratic", "cram"].includes(args.mode)) throw "That isn’t a tutor mode Phaethon knows.";
          M.tutorModes ??= {};
          if (args.mode === "normal") delete M.tutorModes[args.space];
          else M.tutorModes[args.space] = args.mode;
          return;
        }
        case "space_tutor_modes_list": return { ...(M.tutorModes ?? {}) };
        case "plan_upcoming":
        case "plan_exams_get":
        case "plan_exams_set":
        case "plan_save":
        case "plan_state_get":
        case "plan_state_set": {
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          if (cmd === "plan_upcoming") {
            const at = (n) => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime() + n * 86400000; };
            const up = M.upcoming?.[args.space] ?? (args.space === "school" ? [
              { course: "Discrete Structures for Computer Science", folder: "Discrete Structures for Computer Science", title: "HW 5", dueIn: 4, link: "courses/Discrete Structures for Computer Science/assignments.md#hw-5" },
              { course: "Calculus II", folder: "Calculus II", title: "Problem set 2", dueIn: 2, link: "courses/Calculus II/assignments.md#problem-set-2" },
              { course: "Calculus II", folder: "Calculus II", title: "Reading: series", dueIn: 0, link: "courses/Calculus II/assignments.md#reading-series" },
            ] : []);
            const courses = M.planCourses?.[args.space] ?? [...new Map(up.map((u) => [u.folder, { name: u.course, folder: u.folder }])).values()];
            return { courses, items: up.map(({ dueIn, ...u }) => ({ ...u, due: at(dueIn) })).sort((a, b) => a.due - b.due) };
          }
          M.exams ??= {};
          if (cmd === "plan_exams_get") return [...(M.exams[args.space] ?? [])];
          if (cmd === "plan_exams_set") {
            const clean = args.exams.map((e) => {
              const title = String(e.title ?? "").split(/\s+/).filter(Boolean).join(" ");
              if (!title) throw "An exam needs a name, like “Test 1”.";
              if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") || Number.isNaN(Date.parse(e.date))) throw "An exam needs a real date.";
              const course = e.course?.trim() || undefined;
              return { id: e.id, title, date: e.date, ...(course ? { course } : {}) };
            });
            clean.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
            M.exams[args.space] = clean;
            return clean;
          }
          if (cmd === "plan_save") {
            (M.planSaved ??= {})[args.space] = args.markdown;
            return "study/plan.md";
          }
          M.planState ??= {};
          if (cmd === "plan_state_get") return M.planState[args.space] ?? { studyDays: [0, 1, 2, 3, 4, 5], sessionsPerDay: 3, sessionMinutes: 25, done: [] };
          const st = args.planState;
          if (!st.studyDays.length) throw "Choose at least one day of the week to study on.";
          M.planState[args.space] = { ...st, studyDays: [...new Set(st.studyDays)].sort() };
          return M.planState[args.space];
        }
        // ---- study from chat (f13) ----
        // A reply's phaethon-study block, as src-tauri/src/study/chat.rs checks and makes it. Uses
        // M.study (courses, quizzes, decks, step) like the study block above, plus: chatError (make
        // sends it as an error; chatErrorOnce: only the first time), chatQuiz (the questions made),
        // chatMade { origin: path } (what each block made). What was made outlives a reload in this tab.
        case "study_chat_plan":
        case "study_chat_make":
        case "study_chat_cancel": {
          const S = (M.study ??= {});
          S.quizzes ??= {};
          S.decks ??= {};
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const KEEP = "__mockStudyChat";
          if (!S.chatLoaded) {
            S.chatLoaded = true;
            try {
              const kept = JSON.parse(sessionStorage.getItem(KEEP) ?? "null");
              if (kept) {
                S.chatMade = { ...kept.chatMade, ...S.chatMade };
                Object.assign(S.quizzes, kept.quizzes);
                Object.assign(S.decks, kept.decks);
              }
            } catch {}
          }
          S.chatMade ??= {};
          const runsNow = (window.__studyChatRuns ??= {});
          const keep = () => {
            try {
              const quizzes = Object.fromEntries(Object.values(S.chatMade).filter((p) => S.quizzes[p]).map((p) => [p, S.quizzes[p]]));
              const decks = Object.fromEntries(Object.values(S.chatMade).filter((p) => S.decks[p]).map((p) => [p, S.decks[p]]));
              sessionStorage.setItem(KEEP, JSON.stringify({ chatMade: S.chatMade, quizzes, decks }));
            } catch {}
          };
          if (cmd === "study_chat_cancel") {
            const r = runsNow[args.origin];
            if (r) r.cancel = true;
            return !!r;
          }
          const squash = (x) => String(x).split(/\s+/).filter(Boolean).join(" ");
          const fnv = (str) => [...str].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16).padStart(8, "0");
          const origin = fnv(`${squash(args.question)}\u0000${squash(args.block)}`);
          let b;
          try {
            b = JSON.parse(args.block);
          } catch {
            throw "The plan isn’t written in a form Phaethon can read.";
          }
          if (!b || typeof b !== "object" || Array.isArray(b)) throw "The plan isn’t written in a form Phaethon can read.";
          const kind = b.kind === "quiz" ? "quiz" : ["deck", "flashcards", "cards"].includes(b.kind) ? "deck" : null;
          if (!kind) throw `The plan can’t be used: “${b.kind}” isn’t a quiz or flashcards.`;
          const max = kind === "quiz" ? 50 : 100;
          const notes = [];
          let count = b.count ?? (kind === "quiz" ? 10 : 20);
          if (typeof count !== "number" || count < 1 || !Number.isInteger(count)) throw "The plan can’t be used: its count must be a whole number, at least 1.";
          if (count > max) {
            notes.push(`At most ${max} ${kind === "quiz" ? "questions" : "cards"} are made at once, so this makes ${max}.`);
            count = max;
          }
          const KINDS = ["choice", "multi", "truefalse", "short", "cloze"];
          const kinds = (b.kinds ?? []).filter((k) => KINDS.includes(k));
          for (const k of b.kinds ?? []) if (!KINDS.includes(k)) notes.push(`“${k}” isn’t a kind of question Phaethon makes, so it’s left out.`);
          const courses = (S.courses ?? []).map((c) => ({ name: c.course, folder: c.folder }));
          const sources = [];
          const unknown = [];
          for (const raw of b.sources ?? []) {
            const want = String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
            const c = courses.find((x) => x.folder === raw || x.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(want) || x.folder.toLowerCase().replace(/[^a-z0-9]/g, "").includes(want));
            if (c && !sources.some((s) => s.path === c.folder)) sources.push({ path: c.folder, name: c.name });
            else if (!c) unknown.push(raw);
          }
          if (!sources.length && !unknown.length && courses.length === 1) sources.push({ path: courses[0].folder, name: courses[0].name });
          else if (!sources.length && !unknown.length && courses.length) sources.push({ path: "courses", name: "all your courses" });
          if (!sources.length) throw unknown.length ? `None of what it names is in this space or its courses: ${unknown.join(", ")}.` : "There’s no course material in this space to make it from. Import a course first, or ask about files in this space.";
          const madePath = S.chatMade[origin] && (S.quizzes[S.chatMade[origin]] || S.decks[S.chatMade[origin]]) ? S.chatMade[origin] : undefined;
          const plan = {
            origin,
            kind,
            ...(b.title ? { title: b.title } : {}),
            ...(b.focus ? { focus: b.focus } : {}),
            count,
            kinds: kind === "quiz" ? (kinds.length ? kinds : ["choice", "truefalse", "short"]) : [],
            difficulty: ["easier", "exam", "harder"].includes(b.difficulty) ? b.difficulty : "exam",
            sources,
            unknown,
            notes,
            ...(madePath ? { made: madePath } : {}),
            running: !!runsNow[origin],
            // f18: the warning when the material leans on pages the model can't look at (S.planMaterial).
            ...(S.planMaterial ? { material: S.planMaterial } : {}),
            // f15: the exam and what is known of its scope (S.planScopes { exam: PlanScope }, S.statedScopes { exam: text }).
            ...(b.exam ? { exam: b.exam } : {}),
            ...(b.exam && S.statedScopes?.[b.exam]
              ? { scope: { exam: b.exam, state: "known", words: S.statedScopes[b.exam], fromUser: true, evidence: [{ source: "from you", quote: S.statedScopes[b.exam] }], course: sources[0].path, courseName: sources[0].name } }
              : b.exam && S.planScopes?.[b.exam]
                ? { scope: S.planScopes[b.exam] }
                : {}),
          };
          if (cmd === "study_chat_plan") return plan;
          // study_chat_make
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          (S.chatMakes ??= []).push({ origin, question: args.question, reply: args.reply });
          if (madePath) {
            send({ type: "done", path: madePath });
            return;
          }
          if (runsNow[origin]) {
            send({ type: "error", message: "This is already being made. It opens in Study when it’s ready." });
            return;
          }
          const run = (runsNow[origin] = { cancel: false });
          try {
            // f15: an exam whose scope is unknown (S.chatNeedsScope) stops and asks, until it is stated.
            const needs = S.chatNeedsScope;
            if (needs && !S.statedScopes?.[needs.exam]) {
              await sleep(S.step ?? 80);
              send({ type: "progress", step: "mapping", done: 0, total: 1 });
              await sleep(S.step ?? 80);
              send({ type: "needsScope", ...needs });
              send({ type: "error", message: `I couldn’t find what ${needs.exam} covers in your ${needs.courseName} materials, so I haven’t made anything: I won’t guess. Tell me what it covers (for example “through HW 6, not graphs”) and I’ll make it from that.` });
              return;
            }
            // f15: the grounded steps (S.chatSteps: [[step, done, total, kept?, dropped?]]).
            const steps = S.chatSteps ?? [["reading", 0, 1], ["reading", 1, 1], ["making", 0, 1], ["making", 1, 1], ["saving", 0, 1]];
            for (const [step, done, total, kept, dropped] of steps) {
              await sleep(S.step ?? 80);
              if (run.cancel) {
                send({ type: "cancelled" });
                return;
              }
              send({ type: "progress", step, done, total, ...(kept != null ? { kept, dropped } : {}) });
              if (S.chatHoldAt === step) await new Promise((r) => (window.__releaseChat = r));
              if (S.chatError && step === "making") {
                const message = S.chatError;
                if (S.chatErrorOnce) delete S.chatError;
                send({ type: "error", message });
                return;
              }
            }
            const title = b.title || (kind === "quiz" ? "Practice quiz" : "New cards");
            const path = `study/${kind === "quiz" ? "quizzes" : "decks"}/${title.replace(/[\\/:*?"<>|]/g, "-")}.${kind === "quiz" ? "json" : "md"}`;
            if (kind === "quiz") {
              const questions = S.chatQuiz ?? Array.from({ length: count }, (_, i) => ({ id: `q${i + 1}`, kind: "choice", prompt: `Question ${i + 1}?`, choices: ["A", "B", "C", "D"], answer: "A", explanation: "A is right." }));
              S.quizzes[path] = { title, course: sources[0].name, sources: sources.map((s) => s.path), created: Date.now(), questions, ...(S.chatGrounding ? { grounding: S.chatGrounding } : {}) };
            } else {
              S.decks[path] = { title, sources: sources.map((s) => s.path), updated: Date.now(), cards: S.chatCards ?? Array.from({ length: count }, (_, i) => ({ front: `New card ${i + 1}?`, back: `Answer ${i + 1}.` })) };
            }
            S.chatMade[origin] = path;
            keep();
            send({ type: "done", path, ...(kind === "quiz" ? { questions: count } : { cards: count }), ...(S.chatGrounding ? { grounding: S.chatGrounding } : {}) });
          } finally {
            delete runsNow[origin];
          }
          return;
        }
        // ---- end study from chat (f13) ----
        // ---- course scope and citations (f15) ----
        // As src-tauri/src/study/scope.rs and citations.rs. M.study.scopeViews { course: ScopeView },
        // M.study.statedScopes { exam: text } (study_scope_state writes it; the f13 plan reads it), and
        // M.study.citeFiles { path: text }: a citation is found when its quote (spaces squeezed) is in that text.
        case "study_scope":
        case "study_scope_build":
        case "study_scope_state":
        case "study_citations_check": {
          const S = (M.study ??= {});
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const squeeze = (s) => String(s).replace(/[“”]/g, '"').replace(/\*/g, "").replace(/\s+/g, " ").trim();
          if (cmd === "study_citations_check") {
            (S.citationChecks ??= []).push(args.citations.length);
            return args.citations.map(({ path, quote }) => {
              const name = path.split("/").pop();
              const text = S.citeFiles?.[path];
              const q = squeeze(quote);
              if (text == null) return { found: false, path, name, why: "That isn’t a file in your materials that this space can read." };
              const t = squeeze(text);
              const at = t.indexOf(q);
              if (at < 0) return { found: false, path, name, why: "Those words aren’t in that file." };
              return { found: true, path, name, at: S.citeAt?.[path], before: t.slice(Math.max(0, at - 80), at), passage: q, after: t.slice(at + q.length, at + q.length + 80) };
            });
          }
          if (cmd === "study_scope_state") {
            if (!String(args.exam ?? "").trim()) throw "Name the exam in a few words.";
            S.statedScopes ??= {};
            if (String(args.text ?? "").trim()) S.statedScopes[args.exam] = String(args.text).trim();
            else delete S.statedScopes[args.exam];
            (S.scopeStates ??= []).push({ course: args.course, exam: args.exam, text: args.text });
            return;
          }
          const view = S.scopeViews?.[args.course];
          if (cmd === "study_scope") {
            if (!view) throw "That course isn’t one this space can see.";
            // What the person said is kept with the course, as scope.rs keeps it.
            const said = Object.entries(S.statedScopes ?? {}).map(([exam, text]) => ({ exam, text, at: 0 }));
            return { ...view, stated: [...(view.stated ?? []).filter((x) => !said.some((y) => y.exam === x.exam)), ...said] };
          }
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          for (const [done, total] of [[0, 2], [1, 2], [2, 2]]) {
            await sleep(S.step ?? 60);
            send({ type: "progress", step: "mapping", done, total });
          }
          if (view) view.state = "fresh";
          send({ type: "done" });
          return;
        }
        // ---- end course scope and citations (f15) ----
        // ---- Rich output: LaTeX (src-tauri/src/latex.rs) and the file viewer (viewer.rs) ----
        // M.latex: { noEngine: true } | { fail: { message, line, log } } | {} (compiles);
        // M.pdfs: { doc: base64, fig: base64 } served by latex_pdf (ids "doc" and "fig");
        // M.files: { "<path>": { kind, text?, b64?, mediaType?, size?, language?, tooBig? } } for file_view / file_bytes.
        case "latex_status":
          return M.latex?.noEngine
            ? { engine: null, engines: [], message: "There’s no LaTeX on this computer. To see LaTeX documents here, install a TeX distribution: MacTeX on a Mac (tug.org/mactex), TeX Live on Linux or Windows (tug.org/texlive), or tectonic (tectonic-typesetting.github.io). Then open this again." }
            : { engine: "pdfLaTeX", engines: ["pdfLaTeX", "XeLaTeX"], message: null };
        case "latex_compile": {
          await sleep(M.latex?.delay ?? 150);
          if (M.latex?.noEngine) return { status: "noEngine", message: "There’s no LaTeX on this computer. To see LaTeX documents here, install a TeX distribution: MacTeX on a Mac (tug.org/mactex), TeX Live on Linux or Windows (tug.org/texlive), or tectonic (tectonic-typesetting.github.io). Then open this again." };
          const fail = M.latex?.fail ?? (/\\undefinedcommand/.test(args.source) ? { message: "LaTeX doesn’t know the command \\undefinedcommand (line 4). It may need a package the document doesn’t load, or be a typo.", line: 4, log: "! Undefined control sequence.\nl.4 \\undefinedcommand\n" } : null);
          if (fail) return { status: "failed", line: null, log: "", ...fail };
          return { status: "ok", id: args.figure ? "fig" : "doc", engine: "pdfLaTeX" };
        }
        case "latex_pdf": {
          const b64 = M.pdfs?.[args.id];
          if (!b64) throw "That PDF isn’t here any more. Compile the document again.";
          return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
        }
        case "latex_save": {
          const slug = (args.title || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
          (M.latexSaved ??= []).push(args);
          const n = M.latexSaved.filter((s) => s.title === args.title).length;
          const name = n === 1 ? slug : `${slug}-${n}`;
          return M.latex?.fail ? { tex: `documents/${name}.tex`, pdf: null, note: `Only the source was saved: ${M.latex.fail.message}` } : { tex: `documents/${name}.tex`, pdf: `documents/${name}.pdf`, note: null };
        }
        case "file_view":
        case "file_bytes": {
          const path = String(args.path).trim();
          // As viewer.rs: nothing outside the space (or courses it may see).
          if (!path || path.startsWith("/") || path.startsWith("@") || path.split("/").includes("..") || path.startsWith(".phaethon")) {
            throw "Only files in this space can be opened from here.";
          }
          const f = M.files?.[path] ?? (M.files ? null : { kind: "markdown", text: `# ${path.split("/").pop()}\n\nA file in this space.` });
          if (!f) throw `“${path}” isn’t in this space any more. It may have been moved or deleted.`;
          if (cmd === "file_bytes") {
            if (!f.b64) throw "Only PDFs and pictures are read this way.";
            return Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)).buffer;
          }
          const name = path.split("/").pop();
          const size = f.size ?? (f.b64 ? Math.floor((f.b64.length * 3) / 4) : (f.text ?? "").length);
          return { path, name, kind: f.kind, size, mediaType: f.mediaType ?? "", text: f.text ?? null, language: f.language ?? null, tooBig: !!f.tooBig };
        }
        // ---- end of rich output ----
        // ---- Updates (src-tauri/src/updater.rs, u1) ----
        // M.updates: { view: UpdateView, check: UpdateView (update_check's answer), install: [InstallEvent & { delay }],
        // installError: "words" }. Without it, this build isn't set up for updates, as the repo ships.
        case "update_state": return structuredClone(M.updates?.view ?? { currentVersion: "0.1.0", source: null, canInstall: true, status: { state: "notSetUp", reason: "This build doesn’t name a place to get updates from." } });
        case "update_check": {
          await sleep(M.updates?.checkDelay ?? 300);
          if (M.updates?.check) M.updates.view = structuredClone(M.updates.check);
          return structuredClone(M.updates?.view);
        }
        case "update_install": {
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          for (const ev of M.updates?.install ?? []) {
            await sleep(ev.delay ?? 200);
            const { delay, ...message } = ev;
            callbacks[id]?.({ index: index++, message });
          }
          if (M.updates?.installError) throw M.updates.installError;
          if (M.updates?.holdInstall) await new Promise(() => {});
          return;
        }
        // ---- end updates ----
        case "agent_send": {
          M.currentSpace = args.space;
          const usedSpace = M.spaces.find((s) => s.id === args.space);
          if (usedSpace) usedSpace.lastUsed = Date.now();
          // Continue a stopped reply: the backend carries on after its text (contract: continueFrom is its index).
          if (args.continueFrom != null) {
            M.continued = { space: args.space, from: args.continueFrom, prompt: args.prompt };
          }
          // Edit / regenerate: everything from that message on is replaced.
          if (args.replaceFrom != null && M.threads[args.space]) M.threads[args.space] = M.threads[args.space].slice(0, args.replaceFrom);
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          window.__liveTurn = { send };
          (async () => {
            if (M.sendError) {
              send({ kind: "error", code: M.sendError.code, message: M.sendError.message, retryAfterSecs: M.sendError.retryAfterSecs });
              send({ kind: "end", sessionId: null });
              return;
            }
            for (const ev of M.turn) {
              await sleep(ev.delay ?? 40);
              if (ev.waitAccess) {
                const answer = await new Promise((resolve) => {
                  pendingAccess = { id: ev.id, resolve };
                  send({ kind: "accessRequest", id: ev.id, space: ev.space, path: ev.path, reason: ev.reason });
                });
                pendingAccess = null;
                send({ kind: "accessRequestDone", id: ev.id, answer });
                send({ kind: "record", record: { kind: "access", space: ev.space, path: ev.path, answer } });
                if (answer === "always") {
                  (M.grants[M.currentSpace ?? "school"] ??= []).push({ id: "g-" + ev.id, from: ev.space, path: ev.path, created: "2026-10-10T09:00:00Z", scope: "always" });
                }
                continue;
              }
              if (ev.waitApproval) {
                const allowed = await new Promise((resolve) => {
                  pending = { id: ev.id, resolve };
                  send({
                    kind: "approval",
                    id: ev.id,
                    summary: ev.summary,
                    detail: ev.detail,
                    action: ev.action ?? "create",
                    path: ev.path ?? "notes.md",
                    space: ev.space ?? M.currentSpace,
                    before: ev.before ?? null,
                    truncated: ev.truncated ?? false,
                  });
                });
                pending = null;
                send({ kind: "approvalDone", id: ev.id, allowed });
                send({ kind: "record", record: { kind: "approval", path: ev.path ?? "notes.md", action: ev.action ?? "create", allowed } });
                continue;
              }
              const { delay, ...message } = ev;
              send(message);
            }
            if (!M.holdOpen && window.__liveTurn) {
              window.__liveTurn = null;
              // { recordTurns: true }: the turn is saved in the space's conversation, as both backends do.
              if (M.recordTurns && args.continueFrom == null) {
                const text = M.turn.filter((e) => e.kind === "text").map((e) => e.delta).join("");
                const msgs = (M.threads[args.space] ??= []);
                msgs.push({ role: "user", text: args.prompt, at: Date.now() });
                if (text) msgs.push({ role: "assistant", text, at: Date.now() });
                (M.currentUpdated ??= {})[args.space] = Date.now();
                persist();
              }
              send({ kind: "end", sessionId: null });
            }
          })();
          return;
        }
      }
      throw new Error("mock-ipc: no answer for " + cmd);
    },
  };
})();
