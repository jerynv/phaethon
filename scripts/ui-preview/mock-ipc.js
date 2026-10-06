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
      // Events streamed for each agent_send; { waitApproval: true } pauses until answered.
      turn: [{ kind: "text", delta: "Done." }],
      sendError: null,
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
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    async invoke(cmd, args) {
      calls.push([cmd, JSON.parse(JSON.stringify(args ?? {}))]);
      if (cmd.startsWith("plugin:window|")) return null;
      switch (cmd) {
        case "dev_log": return;
        case "settings_get": return M.settings;
        case "settings_set_backend": M.settings.backend = args.backend; return;
        case "api_key_set": M.settings.hasAnthropicKey = true; return;
        case "api_key_clear": M.settings.hasAnthropicKey = false; return;
        case "appearance_set": M.settings.appearance = args.appearance; return;
        case "thread_load": return M.threads[args.space] ?? [];
        case "grants_list": return { grants: M.grants[args.space] ?? [], problems: M.grantProblems ?? [] };
        case "grant_revoke": {
          for (const k of Object.keys(M.grants)) {
            const before = M.grants[k].length;
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
          const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
          let index = 0;
          const send = (message) => callbacks[id]?.({ index: index++, message });
          window.__liveTurn = { send };
          (async () => {
            if (M.sendError) {
              send({ kind: "error", code: M.sendError.code, message: M.sendError.message });
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
                if (answer === "always") {
                  (M.grants[M.currentSpace ?? "school"] ??= []).push({ id: "g-" + ev.id, from: ev.space, path: ev.path, created: "2026-10-10T09:00:00Z", scope: "always" });
                }
                continue;
              }
              if (ev.waitApproval) {
                const allowed = await new Promise((resolve) => {
                  pending = { id: ev.id, resolve };
                  send({ kind: "approval", id: ev.id, summary: ev.summary, detail: ev.detail });
                });
                pending = null;
                send({ kind: "approvalDone", id: ev.id, allowed });
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
