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
  ["new-space", "makes a new space"],
  ["settings-assistant", "opens Settings › Assistant"],
  ["settings-appearance", "opens Settings › Appearance & accessibility"],
  ["settings-accessibility", "opens Settings › Appearance & accessibility"],
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

- The sidebar on the left, from the top: the space switcher (the current space's name), New chat, Search, the space's views, its conversations, and Settings at the bottom. ⌘B (or ⌘\\) hides and shows it; on a narrow window it opens as a panel.
- Space switcher menu: every space (⌘1…9 jumps to one), then for the current space Show in Finder, Add files…, Add a folder… and Export… (the whole space as a .zip), then New space… and Edit spaces….
- Files in a space: the space is a folder on the computer. Add files… and Add a folder… copy files or a whole folder into the space's files/ folder, where you can read them; the originals stay where they were. Hidden files and links are left out; up to 5000 files and 1 GB at once. Anything put in the space's folder by hand (Show in Finder) can be read too.
- Attaching to a message: the paperclip in the message box, dragging files onto the conversation, or pasting. Up to 10 files per message: images, PDFs, Word documents and text. Attached files are saved in the space's attachments/ folder. A folder can't be attached: add it to the space instead.
- In the message box: the paperclip, the model this space uses, and in spaces with Education the tutor mode (Normal, Quiz me, Explain it back, Socratic, Exam cram). Enter sends, Shift+Enter makes a new line, Esc stops a reply.
- Views: Chat in every space; spaces with Education also have Study (flashcards, quizzes, review), Grades, Plan and Courses. ⌘⌥1…5 switches view. Education is turned on in Settings › Spaces.
- Conversations: New chat (⌘N), Search (⌘K or ⌘⇧F) across this space or all of them; each conversation in the list can be deleted from its menu.
- Courses view: connect Canvas, Brightspace, Moodle or Blackboard, import courses, choose which parts of each course each space can see, and browse what was imported.
- Settings (⌘,) has these sections:
  - Appearance & accessibility: theme (light, dark or the computer's), contrast, text size, reading font (Atkinson Hyperlegible, OpenDyslexic, Lexend, the system font), focus rings, larger click targets, reduce motion.
  - Assistant: who answers (Phaethon's own agent with a provider such as Anthropic, OpenAI, OpenRouter, Groq, or Ollama and LM Studio on this computer; or Claude Code, Codex or Gemini CLI on this computer, signed in there), providers and their API keys, the default model and this space's model.
  - Coding agents: Claude Code, Codex and Gemini CLI: installed or not, sign in and out, accounts, and for the space its model, reasoning level, workspace folder and Full access (which lets the coding agent in that space read and change anything on this computer and use the internet without asking); also which other spaces may read this one (read-only, removable).
  - Spaces: each space's name, description, colour and Education.
  - Courses: course sites and who can see each course.
  - About: the version, where the Phaethon folder is, and updates.
- Another space's files can't be read by default; the user can give read-only access when asked, and remove it in Settings › Coding agents.`;

/** The own loop's section: the buttons plus a pointer to the app_guide tool. */
export function appGuidePromptSection(): string {
  return `${actionsPrompt()}\n\nCall app_guide before telling the user where something is in Phaethon or how to change a setting: it lists every place and setting by its name in the app.`;
}

/** For CLI backends, which have no app_guide tool. */
export function appGuideCliSection(): string {
  return `${actionsPrompt()}\n\n${PLACES}`;
}
