# TypeScript rewrite plan (Nov 10, 2026)

Owner request: rewrite everything in TypeScript; make the agent reason instead of reciting facts (build on LearnHarness's techniques); rethink the whole UI on shadcn's Base UI style instead of vic-ui; reuse T3 Code's coding-harness implementation.

## Process model

```
Electron main (src/desktop)          Node core (src/server)                  Renderer (src/web)
 ├─ app:// protocol, CSP header       ├─ MessagePort per renderer (WS only standalone)React 19 + Vite
 ├─ utilityProcess core, MessagePorts ├─ invoke(name,args) router (allow-list) shadcn base-mira + @base-ui/react
 │   kills reported groups on crash   ├─ Channel streams (per-call ids)        T3/coss ui components (MIT)
 ├─ native dialogs, folder picker     ├─ vault, spaces, threads, grants        own timeline/composer
 ├─ LMS sign-in windows (cookies)     ├─ providers + agent loop
 └─ updater                           ├─ CLI backends (claude, codex, gemini)
                                      ├─ LMS, study, plan, latex, ocr
                                      └─ keychain (@napi-rs/keyring)
```

- The core is an Electron utility process (`utilityProcess.fork`, so the RunAsNode fuse can stay off), so provider keys stay out of the renderer exactly as they stayed in Rust before.
- Main ↔ core: the utility process parent port. Main forwards native-only results (folder-picker choices, LMS sign-in cookies) and kills the process groups the core reports if the core dies. The renderer never receives credentials.
- Renderer ↔ core: a MessagePort main hands to the main window only (no TCP port, no token). A WebSocket transport with a token (`timingSafeEqual`) and Origin check exists only for standalone use (tests; later Tailscale). Frames: `{id, cmd, args}` → `{id, ok}` | `{id, err}`; channel messages `{ch, msg}`. Command names, camelCase argument names, return JSON and Channel message JSON stay identical to the Tauri commands (114 of them), so every spec row maps one-to-one.
- The same server can later serve the built UI over Tailscale for mobile.

## Compatibility (existing users' data)

- Vault `~/Phaethon/<vault>` and every file format in it are unchanged (thread.json, threads/, session files, space.json, settings.json, grants.json, course-access.json, decks, quizzes, scope maps, plan files).
- App data stays at Tauri's folder for `io.github.jerynv.phaethon`; Chromium's profile lives in Electron's own userData.
- Keychain service `phaethon`, account `{vault}/provider/{id}`; `@napi-rs/keyring` binds the same `keyring` crate the Rust core used, so saved keys are read as-is.
- Old Tauri 0.1.x installs cannot auto-update to an Electron build; they need one manual install.

## Agent quality (LearnHarness techniques, reimplemented; LearnHarness is AGPL so no code or prompt text is copied)

1. Fragment-composed system prompt (`src/server/agent/prompts/*.md`): identity, accuracy, voice, a reasoning method (premises → one justified step at a time → conclusion → one application check), formatting that stays screen-reader friendly. "Keep replies short" is replaced by "length follows the material, no padding".
2. Effort per turn kind: `high` for tutor and planning turns, `medium` for chat; reasoning effort for OpenAI-compatible reasoning models.
3. Between-tool prose is not lost: `send_to_user` tool for Claude models and thinking `display: "updates"` rendered as progress lines.
4. Tool-argument healing and error-back with fix instructions for weak/local models.
5. Lesson tools: `plan_lesson` (validated prerequisite map, ends the turn), `check` (graded multiple choice, explanation written before the answer; ends the turn) and `explain_back` (free recall). The student's answer, confidence and own reasoning come back as the tool result. UI: a question card that replaces the composer.
6. Learner-centred compaction for long conversations.
7. Rewritten tutor modes on top of the method; the chat prompt allows comprehension checks while generated practice stays in the grounded study pipeline.

## CLI backends (T3 Code patterns, MIT, adapted to plain TypeScript)

- Claude Code: `claude -p --input-format stream-json --output-format stream-json` (the protocol T3's Agent SDK path drives), keeping Phaethon's read-only lockdown flags; T3's message normalization and process-group watcher.
- Codex: `codex app-server` JSON-RPC (thread/start|resume, turn/start|interrupt, model/list, account/read), read-only sandbox, approvals denied.
- Gemini CLI: ACP (`gemini --acp`), permission requests denied except reads.
- Every child leads its own process group; cancel = SIGTERM, 1.5 s, SIGKILL; a watcher kills groups if the core dies.

## UI

shadcn `base-mira` style on `@base-ui/react`, coss/T3 ui primitives (MIT, notices kept), Tailwind v4, lucide icons. Own chat timeline (no assistant-ui), react-markdown + KaTeX + mermaid. Screens: onboarding, chat (timeline, composer, model picker, approvals, access requests, question/plan cards), sidebar (spaces, conversations, search), study (hub, deck editor, review, quiz, make), grades (what-if), plan (exams, schedule, focus), courses (import, access), settings (appearance & accessibility, assistant/providers, CLI agents, spaces, about/updates), file viewer. WCAG 2.2 AA stays the floor; reading font, text scale, contrast, motion and focus-ring preferences carry over.

## Verification

- Core: vitest; Rust unit tests ported as acceptance tests; fake HTTP servers for providers and LMS; fake CLIs for backends.
- UI: Playwright (Chromium) scenarios against the real core with scripted fake providers, plus axe.
- Desktop: the real Electron app launched headless (offscreen + SwiftShader) and captured.
