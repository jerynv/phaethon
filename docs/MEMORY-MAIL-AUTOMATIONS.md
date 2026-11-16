# Memory, people, mail and automations

Status: built on `feat/memory-people-mail-automations` (Nov 16, 2026). This file is the plan and the record: what was asked, what was decided, what is proven.

## What was asked

1. **Memory that knows when to speak.** A meeting at 6 am Saturday is relevant when the conversation touches it, not on every "hi". Once the user says it happened (attended, missed, went well) it leaves the front burner; the conversation it was mentioned in stays searchable. A temporary state ("bad food, emailing my bosses I can't come in") stays relevant across chats for an estimated window, then dies off. A one-off vent ("I hate my boss") is never stored as a statement; at most the underlying dynamic (why) is kept.
2. **Profiles.** A global profile (about me, how I operate, what agents have noticed across spaces) and a space profile (how to act in this space).
3. **People.** One card per person: names and aliases ("my boss"), relation, org, emails, phones, links (LinkedIn), notes on the dynamic, and an interaction history across chat and mail, so "tell my boss I'm late" needs no more context.
4. **Mail through the apps the user already has.** The system Mail app (which can hold work and school accounts an agent could never sign into directly), Outlook, and Shortcuts.
5. **Draft and send with a human in the loop.** A draft card showing which account it sends from (with the provider's mark), recipients, subject and body, editable; "draft" never sends; "send" counts down (one minute by default) visibly, with Stop, Edit and Send now. Tone and review.
6. **Automations.** Background jobs and schedules that run regularly, each only when it has something to do.
7. **Settings for all of it**, privacy above all.

## Decisions

- **Files stay the database.** Profiles are Markdown, memories, people, mail settings and schedules are JSON under the vault. Nothing is hidden in a store the user can't open.
  - `<vault>/memory/profile.md`: global profile. The user writes anything; agents only add lines under `## What agents have noticed`.
  - `<space>/PROFILE.md`: how to act in this space, same rule under `## Noticed in this space`.
  - `<vault>/.phaethon/memories.json`: timed and contextual memories (the front burner and its archive).
  - `<vault>/memory/people/<id>.json`: one file per person.
  - `<vault>/.phaethon/mail.json`: connectors, which space sees which account, send rules.
  - `<space>/.phaethon/outbox/<id>.json`: drafts and their send state.
  - `<vault>/.phaethon/schedules.json`, `jobs.json`: user schedules and job run state.
  - `<space>/MEMORY.md` (kept facts from cleared chats) is unchanged and still always read.
- **Memory kinds.** `event` (has a time; awaits an outcome once it has passed; expires unresolved after a grace period), `state` (temporary condition with an estimated end, extendable), `task` (a commitment or follow-up, open until done), `note` (background context, the why, optionally decaying). Closed items keep a link to the conversation they came from and stay findable with `recall`.
- **Relevance, not injection.** Each turn scores the open items against the user's latest message: word overlap weighted by rarity, people named (including aliases like "my boss"), and time cues ("tonight", "Saturday", "this week") against an item's time; availability and communication cues ("email", "late", "can I make") raise current states and near events. Small talk scores nothing. Only items over the threshold go into that turn's prompt, labelled as possibly relevant background. The `recall` tool searches everything on demand, including closed items, people and past conversations in the space.
- **Scope follows the walls.** An item belongs to the space it came from. One marked `vault` (sick, travelling: things that touch the whole life) is shared with other spaces only when "Share life events across spaces" is on. A person is visible in the spaces listed on their card (or all). A mail account is usable only in the spaces it is assigned to; with none assigned, no space can touch mail.
- **The agent never sends on its own.** `draft_email` with intent `send` schedules a send after the delay (default 60 s) and the card counts down; the user can stop, edit (pauses) or send now. Sending can be turned off entirely, making every draft draft-only. A schedule's unattended turn can only draft. A send whose time passed while Phaethon was closed is not sent; it goes back to draft.
- **Mail connectors are local apps.** Apple Mail and legacy Outlook through Apple Events (`osascript`, JavaScript for Automation for Mail), with macOS's Automation permission. Shortcuts through `/usr/bin/shortcuts`, only the ones the user allowed for a space. Direct IMAP or Graph sign-in is not built: the Mail app already covers multiple accounts, including ones a workplace won't let a third-party app sign into.
- **Jobs run in the core while Phaethon is open**, catch up once at launch, and say why they're idle ("no mail account is assigned to a space"). Built in: memory sweep (no model), memory review (model, only when there is new conversation since the last run), mail to people (headers only, never bodies), daily digest per space (off by default). User schedules run a prompt in a space on a schedule into a new conversation, without approvals: writes, access requests and sends are refused in an unattended turn.

## Acceptance checks

| # | Outcome | Check |
| --- | --- | --- |
| 1 | "hi" gets no memories; "what's my Saturday morning look like" gets the 6 am meeting | `memory/relevance.test.ts` |
| 2 | A passed event awaits an outcome, closes with `update_memory` and leaves the prompt, stays in `recall` with its conversation | `memory/items.test.ts`, `memory/tools.test.ts` |
| 3 | A state expires after its window; extending it keeps it | `memory/items.test.ts` |
| 4 | Vault-scoped items cross spaces only with the setting; space items never do | `memory/items.test.ts` |
| 5 | Venting is refused as a statement (the tool asks for the dynamic) and secrets are refused | `memory/tools.test.ts` |
| 6 | Profiles: user text untouched, agent lines only under its heading, both in the prompt | `memory/profile.test.ts` |
| 7 | "my boss" resolves to the person whose alias or relation says so, only in their spaces; mail and chat interactions land on the card | `people/people.test.ts` |
| 8 | Mail: a space sees only its accounts; search/read/draft through the connector; Apple Mail scripts run against the real Mail app | `mail/mail.test.ts`, a read-only run on this Mac |
| 9 | Draft card: draft never sends; send counts down from 60 s, Stop cancels, Edit pauses, Send now sends; a stale scheduled send reverts to draft | `mail/outbox.test.ts`, `e2e/mail.spec.ts` |
| 10 | Jobs: cron parsing, catch-up, idle reasons, unattended turns refuse writes and sends | `jobs/*.test.ts` |
| 11 | Settings: Memory, People, Mail and Automations sections edit all of the above | `e2e/memory.spec.ts`, screenshots |
| 12 | `pnpm typecheck`, `pnpm test`, `pnpm test:ui` pass | run at the end |

## Since (Nov 16, evening)

- The coding agents use Phaethon's tools (Codex as dynamic tools, Claude Code and Gemini CLI over per-turn local MCP). Checked live: Codex (gpt-5.6-sol) and Claude Code each saved "never use em dashes" to the profile with `note_profile`, and Codex's resumed thread still had the tools. Gemini CLI is wired the same way but refuses the development account, so it is covered by unit tests only.
- Tool steps carry what they were about and what they found, for Phaethon's own agent and the coding agents alike; `recall` also searches the profiles.
- Emailing someone unknown adds them to People when a name can be found.
- Mail marks are the providers' own logos (vendored, see `src/web/src/assets/mail/LICENSES.txt`); the Mail, Shortcuts and Outlook rows use the installed apps' own icons.
- Settings › Memory: loads in one piece (layout shift 0, was 0.30), profiles edit only the person's own words with agent lines listed apart, and each kind of memory has the action that fits it.

## State (Nov 16, 2026)

Every check above passes:

- `pnpm typecheck` passes. `pnpm test` (vitest): 1052 passed, 1 skipped. `pnpm build` passes. `npx playwright test`: 47 passed, including `e2e/mail.spec.ts` (draft card, countdown, Stop, Edit, Send, Open in Mail, Undo) and `e2e/memory.spec.ts` (the four Settings sections).
- Apple Mail was run read-only against this Mac's Mail app: 4 accounts (Exchange shown as school, iCloud, two Gmail), inbox and sent in each, and message reads. Gmail's sent mailbox is nested under `[Gmail]`, so mailboxes are found by position, not by name. Composing was checked by building a message and deleting it, never sending. Mail autosaves a built message into that account's Drafts, so the test draft was removed by hand.
- Tests never touch this Mac's Shortcuts app: `PHAETHON_FAKE_SHORTCUTS` stands in for it.
- Classic Outlook support is written against its scripting dictionary but has not been run, because no Outlook is installed on the development Mac.
