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
  const BUSY = "Phaethon is still replying in this space. Stop the reply or wait for it to finish, then try again.";
  // As thread.rs titles a conversation: the first user text, whitespace collapsed, at most 60 characters.
  const titleOf = (msgs) => {
    const first = msgs.find((m) => m.role === "user");
    const t = (first?.text ?? "").split(/\s+/).filter(Boolean).join(" ") || first?.attachments?.[0]?.name;
    if (!t) return "New conversation";
    return [...t].length > 60 ? `${[...t].slice(0, 59).join("").trimEnd()}…` : t;
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
        case "settings_get": return M.settings;
        case "settings_set_backend": M.settings.backend = args.backend; return;
        case "settings_set_model": M.settings.model = args.model ?? "claude-opus-5-5"; return;
        case "models_list": return M.models;
        // A space's own model (space.json "model"), as src-tauri/src/space_model.rs: M.spaceModels[id].
        case "space_model_get": return (M.spaceModels ?? {})[args.space] ?? null;
        case "space_model_set": {
          if (!M.spaces.some((s) => s.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          if (args.model != null && !/^claude-[a-z0-9.-]+$/.test(args.model)) throw "That isn’t a model Phaethon knows how to use.";
          M.spaceModels ??= {};
          if (args.model == null) delete M.spaceModels[args.space];
          else M.spaceModels[args.space] = args.model;
          return;
        }
        case "space_models_list": return { ...(M.spaceModels ?? {}) };
        case "api_key_check": {
          if (M.keyCheck) return M.keyCheck;
          const k = String(args.key ?? "").trim();
          return k.startsWith("sk-ant-") && k.length > 20
            ? { ok: true, message: "This key works." }
            : { ok: false, problem: "format", message: "That isn’t an Anthropic API key. Keys start with sk-ant-." };
        }
        case "file_open": return;
        case "api_key_set": M.settings.hasAnthropicKey = true; return;
        case "api_key_clear": M.settings.hasAnthropicKey = false; return;
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
          if (cmd === "thread_open" && M.settings.backend !== "phaethon") throw "Past conversations can be reopened only with Phaethon’s own agent.";
          const archive = (M.threadArchive[args.space] ??= []);
          const chosen = cmd === "thread_open" ? archive.find((t) => t.id === args.id) : null;
          if (cmd === "thread_open" && args.id === "current") return;
          if (cmd === "thread_open" && !chosen) throw "That conversation couldn’t be opened: that conversation is no longer there";
          const current = M.threads[args.space] ?? [];
          if (current.length) archive.push({ id: String(Date.now()), updated: M.currentUpdated?.[args.space] ?? Date.now(), messages: current });
          M.threads[args.space] = chosen ? chosen.messages : [];
          (M.currentUpdated ??= {})[args.space] = chosen ? chosen.updated : Date.now();
          if (chosen) archive.splice(archive.indexOf(chosen), 1);
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
          if (cmd === "thread_clear") {
            if (M.settings.backend !== "phaethon") return { status: "notKept", reason: "Claude Code is answering in this vault, and Phaethon can’t ask it to pick out details." };
            if (M.clearFails) return { status: "notKept", reason: M.clearFails };
          }
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
        case "threads_list": {
          if (M.settings.backend !== "phaethon") return [];
          const summary = (id, messages, updated, current) => ({ id, title: titleOf(messages), updated, messages: messages.length, current });
          const rest = (M.threadArchive[args.space] ?? [])
            .map((t) => summary(t.id, t.messages, t.updated, false))
            .sort((a, b) => b.updated - a.updated);
          return [summary("current", M.threads[args.space] ?? [], M.currentUpdated?.[args.space] ?? Date.now(), true), ...rest];
        }
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
        case "agent_send": {
          M.currentSpace = args.space;
          const usedSpace = M.spaces.find((s) => s.id === args.space);
          if (usedSpace) usedSpace.lastUsed = Date.now();
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
