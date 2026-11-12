/**
 * What the model may tell the user about Phaethon itself: the buttons it can
 * put under a reply (`phaethon-actions`, ids matching the renderer's list) and
 * where every control is (the `app_guide` tool).
 */

export const ACTIONS_FENCE = "phaethon-actions";

export const ACTIONS: [id: string, does: string][] = [
  ["add-files", "the user picks files on their computer and they are copied into this space's files/ folder"],
  ["add-folder", "the user picks a folder and it is copied, with everything in it, into this space's files/ folder"],
  ["attach-files", "opens the file picker to attach files to their next message"],
  ["show-folder", "opens this space's folder in Finder (File Explorer, Files)"],
  ["import-courses", "opens Courses, where the user connects a course site and imports courses"],
  ["new-space", "opens Settings › Spaces to make a new space"],
  ["settings-assistant", "opens Settings › Providers (API keys and models for Phaethon's own agent)"],
  ["settings-appearance", "opens Settings › Appearance"],
  ["settings-accessibility", "opens Settings › Appearance (kept for older replies; prefer settings-appearance)"],
  ["settings-spaces", "opens Settings › Spaces"],
  ["settings-courses", "opens Settings › Courses"],
  ["settings-about", "opens Settings › About"],
];

export function actionsPrompt(): string {
  return `# Buttons under your reply

When the user wants to do something in the app (add a file or folder, change a setting, connect a course site), say where it is in one short sentence and put the buttons for it after your reply: a \`\`\`${ACTIONS_FENCE} block with one id per line, at most 3, the most likely first. The app draws them as buttons; anything not in this list is ignored:
${ACTIONS.map(([id, does]) => `- ${id}: ${does}`).join("\n")}
For example, someone who wants to bring in a folder of school files gets add-folder and add-files.`;
}

export const PLACES = `# Where things are in Phaethon

Use this to tell the user exactly where a control is, by its name as it appears. Never say you can't see the app, and never guess at buttons not listed here. "⌘" is Ctrl on Windows and Linux.

- The sidebar on the left, from the top: Hide sidebar and New chat (top right of the sidebar), Search, then "Spaces": every space as a group with its conversations listed under it (pinned ones first, then newest first, "Show more" past eight), and Settings at the bottom. Clicking a space's name opens it; the arrow beside it folds its list (a folded space shows how many conversations it has). Hovering a space shows its menu (Show folder, Space settings) and a New chat button; hovering a conversation shows its menu (Rename, Reset title once renamed, Pin to top or Unpin, Delete…, which asks first). A dot left of a conversation means a reply is being written (pulsing) or arrived while the person was elsewhere; a pin means it's pinned. Dragging the sidebar's right edge makes it wider or narrower; double-clicking the edge resets it. The + beside "Spaces" makes a new space. ⌘B (or ⌘\\) hides and shows the sidebar; ⌘1…9 jumps to a space.
- The bar at the top of the window shows the space and the conversation's title; on the right, spaces with study tools have the view tabs (Chat, Study, Grades, Plan, Courses; ⌘⌥1…5), and the ⋯ menu has New chat, Show space folder and Delete conversation.
- Files in a space: the space is a folder on the computer. Add files… and Add a folder… copy files or a whole folder into the space's files/ folder, where you can read them; the originals stay where they were. Hidden files and links are left out; up to 5000 files and 1 GB at once. Anything put in the space's folder by hand (Show folder) can be read too.
- Attaching to a message: the paperclip in the message box, dragging files onto it, or pasting. Up to 10 files per message: images, PDFs, Word documents and text. Attached files are saved in the space's attachments/ folder. A folder can't be attached: add it to the space instead.
- The message box, left to right under the text: the paperclip; the model picker (the model's name with its provider's logo), which chooses the model for this conversation only, from every provider set up in Settings › Providers and every coding agent on this computer (Claude Code, Codex, Gemini CLI); next to it, for models that have one, the reasoning level; in spaces with study tools, the teaching mode (Normal, Quiz me, Explain it back, Socratic, Exam cram). New conversations start with the model picked last. Enter sends, Shift+Enter makes a new line; while you answer, the send button becomes Stop.
- Under a message: hovering shows Copy, and on the user's last message Edit and resend; a stopped reply has Continue.
- Search (⌘K): finds words in every conversation of every space, jumps to a space, and runs actions (New chat, Open settings, theme, New space).
- Study tools (turned on per space in Settings › Spaces): Study (flashcards, quizzes, review of due cards, making a deck or quiz from the space's files), Grades (course grades with what-if scores), Plan (upcoming deadlines and exams and a study schedule) and Courses (connect Canvas, Brightspace, Moodle or Blackboard, import courses, choose which parts each space can see, and browse what was imported). Opening a file shows it in a panel on the right.
- Settings (⌘,) replaces the sidebar with its own list; Back to app (or Esc) returns. Sections:
  - General: where the Phaethon folder is, and the keyboard shortcuts.
  - Providers: Phaethon's own agent's providers (Anthropic, OpenAI, OpenRouter, Groq, Together, Mistral, DeepSeek, xAI; Ollama and LM Studio on this computer; or your own server), their API keys, addresses and models.
  - Coding agents: Claude Code, Codex and Gemini CLI: installed or not, sign in and out (always through the agent's own login), accounts and usage.
  - Spaces: each space's name, description, colour and study tools; its working folder for coding agents; Full access (lets a coding agent in that space read and change anything on this computer and use the internet without asking); which other spaces may read this one (read-only, removable); and export as a .zip.
  - Courses: course sites and which space sees which course.
  - Appearance: light, dark or the computer's theme.
  - About: the version and updates.
- Another space's files can't be read by default; the user can give read-only access when asked, and remove it in Settings › Spaces.`;

/** The own loop's section: the buttons plus a pointer to the app_guide tool. */
export function appGuidePromptSection(): string {
  return `${actionsPrompt()}\n\nCall app_guide before telling the user where something is in Phaethon or how to change a setting: it lists every place and setting by its name in the app.`;
}

/** For CLI backends, which have no app_guide tool. */
export function appGuideCliSection(): string {
  return `${actionsPrompt()}\n\n${PLACES}`;
}
