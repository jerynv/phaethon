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
          const conn = M.lms?.connections?.[args.space]?.[0]?.id ?? "canvas-iu-instructure-com";
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
        // study (engine)
        // As src/lib/study.ts. M.study: { decks: { space: [{ path, title, course?, cards: [{ id, kind, front, back, source?, confidence?, due? }] }] },
        // quizzes: { space: [{ path, title, course?, sources, created, questions }] }, attempts: [...], days: [ms...],
        // makeError (study_make_* sends it), step (ms between progress events) }.
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
        case "study_delete": {
          const S = (M.study ??= {});
          if (!M.spaces.some((x) => x.id === args.space)) throw `space "${args.space}" does not exist in this vault`;
          const C241 = "CSCI-C 241 Fall 2026 (All Sections)";
          const SRC = `courses/${C241}/files/HW/Test 1 Review - C241 Fa26.pdf`;
          S.decks ??= {};
          S.quizzes ??= {};
          S.attempts ??= [];
          S.days ??= [];
          S.decks.school ??= [
            {
              path: "study/decks/Logic basics.md",
              title: "Logic basics",
              course: C241,
              cards: [
                { id: "c1", kind: "basic", front: "When is p → q false?", back: "Only when p is true and q is false.", source: SRC },
                { id: "c2", kind: "basic", front: "“A is necessary for B” in logic", back: "B → A", source: SRC, confidence: 2, due: Date.now() - 1000 },
                { id: "c3", kind: "cloze", front: "A set with n members has {{2^n}} subsets.", back: "", source: SRC, confidence: 5, due: Date.now() + 5 * 864e5 },
              ],
            },
          ];
          S.quizzes.school ??= [
            {
              path: "study/quizzes/Test 1 practice.json",
              title: "Test 1 practice",
              course: C241,
              sources: [SRC],
              created: Date.now() - 864e5,
              questions: [
                { id: "q1", kind: "choice", prompt: "When is p → q false?", choices: ["p false, q true", "p true, q false", "both false", "both true"], answer: "p true, q false", explanation: "Only a true premise with a false conclusion fails.", source: SRC },
                { id: "q2", kind: "truefalse", prompt: "A set with 3 members has 6 subsets.", choices: ["true", "false"], answer: "false", explanation: "It has 2^3 = 8.", source: SRC },
                { id: "q3", kind: "multi", prompt: "Which are tautologies? Select all that apply.", choices: ["p ∨ ¬p", "p → p", "p ∧ ¬p", "p → q"], answer: ["p ∨ ¬p", "p → p"], explanation: "Both are true under every assignment.", source: SRC },
                { id: "q4", kind: "short", prompt: "Why does a set with n members have 2^n subsets?", answer: "Each member is in or out: two choices, n times.", explanation: "Counting in-or-out choices.", source: SRC },
                { id: "q5", kind: "cloze", prompt: "The power set of a set with n members has ___ members.", answer: "2^n", accept: ["2ⁿ"], explanation: "One subset per pattern.", source: SRC },
              ],
            },
          ];
          const decks = (S.decks[args.space] ??= []);
          const quizzes = (S.quizzes[args.space] ??= []);
          const now = Date.now();
          const findDeck = (p) => {
            const d = decks.find((x) => x.path === p);
            if (!d) throw "That deck isn’t in this space any more.";
            return d;
          };
          const findQuiz = (p) => {
            const q = quizzes.find((x) => x.path === p);
            if (!q) throw "That quiz isn’t in this space any more.";
            return q;
          };
          const free = (folder, title, ext, list) => {
            const stem = title.replace(/[/\\:*?"<>|]/g, "-").trim() || "Untitled";
            let name = `${folder}/${stem}${ext}`;
            for (let n = 2; list.some((x) => x.path.toLowerCase() === name.toLowerCase()); n++) name = `${folder}/${stem} (${n})${ext}`;
            return name;
          };
          const stream = async (events) => {
            const id = args.onEvent.id ?? Number(String(args.onEvent).split(":")[1]);
            let index = 0;
            for (const e of events) {
              await sleep(S.step ?? 80);
              callbacks[id]?.({ index: index++, message: e });
            }
          };
          const progress = (steps) => steps.flatMap((s) => [{ type: "progress", step: s, done: 0, total: 1 }, { type: "progress", step: s, done: 1, total: 1 }]);
          if (cmd === "study_overview") {
            const day = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 6e4) / 864e5);
            const days = new Set(S.days.map(day));
            let streak = 0;
            for (let d = days.has(day(now)) ? day(now) : day(now) - 1; days.has(d); d--) streak++;
            const summaries = decks.map((d) => ({
              path: d.path,
              title: d.title,
              ...(d.course ? { course: d.course } : {}),
              cards: d.cards.length,
              due: d.cards.filter((c) => c.due != null && c.due <= now).length,
              new: d.cards.filter((c) => c.due == null).length,
              mastery: d.cards.length ? d.cards.filter((c) => (c.confidence ?? 0) >= 4).length / d.cards.length : 0,
              updated: d.updated ?? now - 36e5,
            }));
            return {
              decks: summaries,
              quizzes: quizzes.map((q) => {
                const last = S.attempts.filter((a) => a.quiz === q.path).sort((a, b) => b.taken - a.taken)[0];
                return { path: q.path, title: q.title, ...(q.course ? { course: q.course } : {}), questions: q.questions.length, ...(last ? { lastScore: last.score, lastTaken: last.taken } : {}) };
              }),
              due: summaries.reduce((n, d) => n + d.due, 0),
              streakDays: streak,
            };
          }
          if (cmd === "study_deck") {
            const d = findDeck(args.path);
            return { path: d.path, title: d.title, ...(d.course ? { course: d.course } : {}), sources: d.course ? [SRC] : [], cards: d.cards.map((c) => ({ ...c })) };
          }
          if (cmd === "study_deck_save") {
            if (!String(args.title ?? "").trim()) throw "The deck needs a title.";
            if (!args.cards.length) throw "The deck has no cards yet.";
            args.cards.forEach((c, i) => {
              if (!c.front.trim()) throw `Card ${i + 1} has no question.`;
              if (!c.front.includes("{{") && !c.back.trim()) throw `Card ${i + 1} has no answer.`;
            });
            const d = args.path ? findDeck(args.path) : { path: free("study/decks", args.title, ".md", decks), cards: [] };
            const old = d.cards;
            d.title = args.title.trim();
            d.cards = args.cards.map((c, i) => {
              const prev = old.find((o) => o.front === c.front.trim());
              return { ...(prev ?? {}), id: prev?.id ?? `n${now}-${i}`, kind: c.front.includes("{{") ? "cloze" : "basic", front: c.front.trim(), back: c.back.trim(), ...(c.source ? { source: c.source } : {}) };
            });
            d.updated = now;
            if (!args.path) decks.push(d);
            return d.path;
          }
          if (cmd === "study_session") {
            const chosen = args.paths ? args.paths.map(findDeck) : decks;
            const all = chosen.flatMap((d) => d.cards.map((c) => ({ ...c, deck: d.path })));
            const due = all.filter((c) => c.due != null && c.due <= now).sort((a, b) => a.due - b.due);
            const fresh = all.filter((c) => c.due == null);
            const ahead = args.paths ? all.filter((c) => c.due != null && c.due > now).sort((a, b) => a.due - b.due) : [];
            return [...due, ...fresh, ...ahead].slice(0, args.limit ?? 20);
          }
          if (cmd === "study_rate") {
            if (!(args.confidence >= 1 && args.confidence <= 5)) throw "Rate how well you knew it from 1 to 5.";
            const c = findDeck(args.deck).cards.find((x) => x.id === args.card);
            if (!c) throw "That card isn’t in the deck any more; it may have been edited.";
            const wait = [0, 10 * 6e4, 864e5, 864e5, 3 * 864e5, 5 * 864e5][args.confidence];
            c.confidence = args.confidence;
            c.due = now + wait;
            S.days.push(now);
            return { due: c.due, again: args.confidence <= 2 };
          }
          if (cmd === "study_quiz") return JSON.parse(JSON.stringify(findQuiz(args.path)));
          if (cmd === "study_delete") {
            const di = decks.findIndex((x) => x.path === args.path);
            const qi = quizzes.findIndex((x) => x.path === args.path);
            if (di >= 0) decks.splice(di, 1);
            else if (qi >= 0) {
              quizzes.splice(qi, 1);
              S.attempts = S.attempts.filter((a) => a.quiz !== args.path);
            } else throw "That isn’t a deck or quiz in this space.";
            return;
          }
          if (cmd === "study_make_deck" || cmd === "study_make_quiz") {
            if (S.makeError) return stream([{ type: "progress", step: "reading", done: 0, total: 1 }, { type: "error", message: S.makeError }]);
            const count = Math.max(1, Math.min(args.options.count || 8, 30));
            if (cmd === "study_make_deck") {
              const title = args.options.title || (args.options.fromAttempt ? "Mistakes from Test 1 practice" : "Test 1 review");
              const d = {
                path: free("study/decks", title, ".md", decks),
                title,
                course: C241,
                cards: Array.from({ length: count }, (_, i) => ({ id: `g${now}-${i}`, kind: i % 3 === 2 ? "cloze" : "basic", front: i % 3 === 2 ? `Generated fill-in {{term ${i + 1}}}.` : `Generated question ${i + 1}?`, back: i % 3 === 2 ? "" : `Answer ${i + 1}.`, source: SRC })),
                updated: now,
              };
              decks.push(d);
              return stream([...progress(["reading", "making", "saving"]), { type: "done", path: d.path, cards: count }]);
            }
            const title = args.options.title || "Test 1 practice";
            const kinds = args.options.kinds?.length ? args.options.kinds : ["choice", "truefalse", "short"];
            const q = {
              path: free("study/quizzes", title, ".json", quizzes),
              title,
              course: C241,
              sources: [SRC],
              created: now,
              questions: Array.from({ length: count }, (_, i) => {
                const kind = kinds[i % kinds.length];
                const base = { id: `q${i + 1}`, kind, explanation: "Because the review sheet says so.", source: SRC };
                if (kind === "choice") return { ...base, prompt: `Question ${i + 1}?`, choices: ["A", "B", "C", "D"], answer: "B" };
                if (kind === "multi") return { ...base, prompt: `Question ${i + 1}? Select all that apply.`, choices: ["A", "B", "C", "D"], answer: ["A", "C"] };
                if (kind === "truefalse") return { ...base, prompt: `Statement ${i + 1}.`, choices: ["true", "false"], answer: "true" };
                if (kind === "cloze") return { ...base, prompt: `Fill in ___ ${i + 1}.`, answer: "blank" };
                return { ...base, prompt: `Explain idea ${i + 1}.`, answer: "A model answer." };
              }),
            };
            quizzes.push(q);
            return stream([...progress(["reading", "making", "saving"]), { type: "done", path: q.path, questions: count }]);
          }
          if (cmd === "study_quiz_submit") {
            const q = findQuiz(args.path);
            const norm = (s) => String(s ?? "").trim().toLowerCase();
            const results = q.questions.map((x) => {
              const given = args.answers[x.id] ?? "";
              const from = x.source ? ` (From ${x.source.split("/").pop()}.)` : "";
              if (x.kind === "short") {
                if (!norm(given)) return { id: x.id, correct: false, given, expected: x.answer, feedback: `No answer given. A good answer: ${x.answer}` };
                return { id: x.id, correct: false, partial: 0.5, given, expected: x.answer, feedback: `Right idea, but say why it holds for every member.${from}` };
              }
              if (x.kind === "multi") {
                const right = new Set(x.answer.map(norm));
                const picked = (Array.isArray(given) ? given : [given]).map(norm).filter(Boolean);
                const ok = picked.length === right.size && picked.every((p) => right.has(p));
                return { id: x.id, correct: ok, given, expected: x.answer, feedback: `${ok ? "Right: you picked every one." : `Partly: the right ones are ${x.answer.join(", ")}.`} ${x.explanation}${from}` };
              }
              const ok = [x.answer, ...(x.accept ?? [])].some((a) => norm(a) === norm(given));
              return { id: x.id, correct: ok, given, expected: x.answer, feedback: `${ok ? "Right." : norm(given) ? `Not quite: the answer is ${x.answer}.` : `No answer given. The answer is ${x.answer}.`} ${x.explanation}${from}` };
            });
            const score = results.reduce((n, r) => n + (r.correct ? 1 : r.partial ?? 0), 0) / results.length;
            const attempt = { path: `.phaethon/study/attempts/${q.title}-${now}.json`, quiz: q.path, taken: now, score, results };
            S.attempts.push(attempt);
            const shorts = q.questions.filter((x) => x.kind === "short").length;
            return stream([...(shorts ? [{ type: "progress", step: "grading", done: 0, total: shorts }, { type: "progress", step: "grading", done: shorts, total: shorts }] : []), { type: "done", attempt }]);
          }
          // study_review_mistakes
          const a = S.attempts.find((x) => x.path === args.attemptPath);
          if (!a) throw "That quiz attempt isn’t in this space any more.";
          const summary = a.results.every((r) => r.correct)
            ? "You got everything right on this quiz. Nothing to review: try a harder quiz, or keep up your flashcards."
            : "## Conditionals\n\nYou mixed up which side of p → q must be true. Reread the truth table in Test 1 Review - C241 Fa26.pdf.\n\n## Before the exam\n\n- Redo problem 1 of the review sheet.";
          return stream([{ type: "progress", step: "reviewing", done: 0, total: 1 }, { type: "progress", step: "reviewing", done: 1, total: 1 }, { type: "done", summary }]);
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
