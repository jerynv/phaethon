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
        // As src-tauri/src/search.rs: case- and accent-insensitive, in the shown text of every
        // conversation of the space (or every space), newest first, 3 snippets each.
        case "conversations_search": {
          if (M.settings.backend !== "phaethon") throw "Claude Code keeps its own history, which Phaethon can’t search. Only conversations with Phaethon’s own agent can be searched.";
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
        // Course sites, as the contract in src/lib/lms.ts. M.lms: { schools, courses, connections: { space: [...] },
        // connect: "ok" | "cancelled" | "<error>", connectHold (resolve with window.__lmsSignIn(result)),
        // signedOut (lms_courses refuses), failCourse (an id whose import fails), signedOutAt (an id where the session
        // ends mid-import: error "signedOut", then done), skipped: { id: [...] }, step (ms) }.
        case "lms_schools":
        case "lms_connect":
        case "lms_connections":
        case "lms_courses":
        case "lms_import":
        case "lms_disconnect": {
          const L = (M.lms ??= {});
          L.connections ??= {};
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
          const conns = (s) => (L.connections[s] ??= []);
          const find = (s, id) => {
            const c = conns(s).find((x) => x.id === id);
            if (!c) throw "That course site isn’t connected in this space any more.";
            return c;
          };
          if (cmd === "lms_schools") {
            if (args.kind !== "canvas") return [];
            const q = String(args.query ?? "").trim().toLowerCase();
            if (q.length < 2) return [];
            return L.schools.filter((s) => s.name.toLowerCase().includes(q) || s.address.includes(q));
          }
          spaceOk(args.space);
          if (cmd === "lms_connections") return conns(args.space).map((c) => ({ ...c, courses: [...c.courses] }));
          if (cmd === "lms_connect") {
            const result = L.connectHold ? await new Promise((r) => (window.__lmsSignIn = r)) : (await sleep(L.connectDelay ?? 300), L.connect ?? "ok");
            if (result === "cancelled") throw "cancelled";
            if (result !== "ok") throw result;
            const address = /^https:\/\//.test(args.address) ? args.address.replace(/\/+$/, "") : `https://${args.address.replace(/\/+$/, "")}`;
            let c = conns(args.space).find((x) => x.kind === args.kind && x.address === address);
            if (!c) {
              const school = L.schools.find((s) => s.address === address);
              c = { id: `c${conns(args.space).length + 1}`, kind: args.kind, address, schoolName: school?.name, signedIn: true, courses: [] };
              conns(args.space).push(c);
            }
            c.signedIn = true;
            L.signedOut = false;
            return { ...c, courses: [...c.courses] };
          }
          if (cmd === "lms_disconnect") {
            find(args.space, args.connection);
            L.connections[args.space] = conns(args.space).filter((x) => x.id !== args.connection);
            return;
          }
          const c = find(args.space, args.connection);
          if (cmd === "lms_courses") {
            if (L.signedOut || !c.signedIn) {
              c.signedIn = false;
              throw "You’ve been signed out of your course site. Sign in again.";
            }
            return L.courses.map((x) => ({ ...x, imported: c.courses.includes(x.id) }));
          }
          // lms_import: per course a few steps, then its summary; a failed course is an error event and the import goes on.
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
            if (!c.courses.includes(courseId)) c.courses.push(courseId);
            send({
              type: "course",
              course: courseId,
              folder: `courses/${course?.name ?? courseId}`,
              files: 12 + Number(courseId) % 7,
              readings: Number(courseId) % 4,
              links: 5,
              skipped: L.skipped?.[courseId] ?? [],
            });
          }
          c.lastSync = Date.now();
          send({ type: "done" });
          return;
        }
        // lms grades (Grades core). As src/lib/lms.ts (CourseGradeView, LmsGradesEvent). M.lmsGrades: { [space]: CourseGradeView[] }
        // (default: three courses of the space's first connection), M.lmsGradesSignedOut (refresh ends "signedOut"),
        // M.lmsGradesFail (a course id whose refresh fails), M.lmsGradesStep (ms).
        case "lms_grades":
        case "lms_grades_refresh": {
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const G = (M.lmsGrades ??= {});
          const conn = M.lms?.connections?.[args.space]?.[0]?.id;
          // A space with no course site has no grades (unless a scenario sets them).
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
              return { id, kind: /\{\{.+?\}\}/.test(c.front) ? "cloze" : "basic", front: c.front, back: c.back ?? "", ...(p ? { confidence: p.confidence, due: p.due } : {}) };
            });
          const now = Date.now();
          const isDue = (c) => c.due == null || c.due <= now;
          const stream = () => {
            const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
            let index = 0;
            return (message) => callbacks[id]?.({ index: index++, message });
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
              const steps = [["reading your course files", 1, 3], ["reading your course files", 2, 3], ["reading your course files", 3, 3], [quiz ? "writing the questions" : "writing the cards", 0, 1]];
              for (const [step, done, total] of steps) {
                await sleep(S.step ?? 60);
                send({ type: "progress", step, done, total });
                if (S.makeError && done === 2) break;
              }
              await sleep(S.step ?? 60);
              if (S.makeError) {
                send({ type: "error", message: S.makeError });
                return;
              }
              const count = Number(args.options.count) || 10;
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
