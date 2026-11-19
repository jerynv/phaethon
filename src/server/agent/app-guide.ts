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
  ["settings-assistant", "opens Settings › AI & Models (every AI service: Claude, ChatGPT and Gemini plans or API keys, other services, local models)"],
  ["settings-appearance", "opens Settings › Appearance"],
  ["settings-accessibility", "opens Settings › Appearance (kept for older replies; prefer settings-appearance)"],
  ["settings-spaces", "opens Settings › Spaces"],
  ["settings-courses", "opens Settings › Courses"],
  ["settings-memory", "opens Settings › Memory (what Phaethon remembers, the user's profile and each space's profile, privacy)"],
  ["settings-people", "opens Settings › People (the people Phaethon knows and their history)"],
  ["settings-mail", "opens Settings › Mail & connectors (connect the Mail app or Outlook, which space uses which account, sending, Shortcuts)"],
  ["settings-automations", "opens Settings › Automations (background jobs, the daily digest, and schedules)"],
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

- The sidebar on the left, from the top: Hide sidebar and New chat (top right of the sidebar), Search, then "Spaces": every space as a group with its conversations listed under it (pinned ones first, then newest first, "Show more" past eight), and Settings at the bottom. Clicking a space's name opens it; the arrow beside it folds its list (a folded space shows how many conversations it has, and how many are replying or need an answer). Several conversations can reply at the same time, even in one space: the person can send in one, switch to another (or another page) and send there too, and nothing is lost. New chat opens an empty conversation that is only kept once something is sent. Hovering a space shows its menu (New chat, Show folder, Space settings) and a New chat button; hovering a conversation shows its menu (Open, Rename, Reset title once renamed, Pin to top or Unpin, Copy title, Delete…, which asks first). Right-clicking a space or a conversation opens the same menu. Each conversation shows its state on its row: a turning dot and "Working" while a reply is written, an amber dot and "Needs you" when it waits for an approval, an access answer or a question, a red mark and "Failed" when its reply failed, a blue dot when a reply arrived while the person was elsewhere, and a pin when it's pinned. The arrow keys move between rows; F2 renames and Delete deletes the focused conversation. Dragging the sidebar's right edge makes it wider or narrower; double-clicking the edge resets it. The + beside "Spaces" makes a new space. ⌘B (or ⌘\\) hides and shows the sidebar; ⌘1…9 jumps to a space.
- The bar at the top of the window holds the open pages as tabs, like a browser's (a conversation, Files, or a study page); the active tab joins the page below it. A + after the tabs starts a new chat, and the page's own actions sit on the right. The views of a space are Chat and Files everywhere, plus Study, Grades, Plan and Courses where study tools are on (⌥⌘1…6 in that order).
- Files in a space: the space is a folder on the computer. Add files… and Add a folder… copy files or a whole folder into the space's files/ folder, where you can read them; the originals stay where they were. Hidden files and links are left out; up to 5000 files and 1 GB at once. Anything put in the space's folder by hand (Show folder) can be read too.
- Files (every space has it: the Files row under the space in the sidebar, or ⌥⌘2): the space's files and folders as a tree with sizes and dates, folders first; search by name, Recent, and Used in chats (files a conversation read, wrote or attached); clicking a file opens it in the viewer; each item's … or right-click menu has Open, Open in default app, Show in Finder, Rename… (F2), Move to folder…, Copy path and Delete… (to the Trash where the computer has one); New folder and Add (files or a folder) are at the top right, and files can be dropped onto the page. Settings › Spaces › (the space) › Files sets whether hidden files show, how files are sorted, and folders Phaethon's own agent can't read (its file tools refuse them; Claude Code and Codex read the folder with their own tools, so it doesn't apply to them).
- Attaching to a message: the paperclip in the message box, dragging files onto it, or pasting. Up to 10 files per message: images, PDFs, Word documents and text. Attached files are saved in the space's attachments/ folder. A folder can't be attached: add it to the space instead.
- The message box, left to right under the text: the paperclip; the model picker (the model's name with its provider's logo), which chooses the model for this conversation only, from every service set up in Settings › AI & Models and every coding agent on this computer (Claude Code, Codex, Gemini CLI); next to it, for models that have one, the reasoning level; in spaces with study tools, the teaching mode (Normal, Quiz me, Explain it back, Socratic, Exam cram). New conversations start with the model picked last. Enter sends, Shift+Enter makes a new line; while you answer, the send button becomes Stop.
- Under a message: hovering shows Copy, and on the user's last message Edit and resend; a stopped reply has Continue.
- When you want to write a file, the person sees a card with the change: Don't allow (N), Allow in this chat (C: this conversation then writes in its space without asking again), Always in <space> (S: every conversation there writes without asking) and Create file or Apply change (Y). Writing never reaches outside the space. Allowing without asking can be taken back in Settings › Spaces. A request to read another space has Don't allow (N), Always allow (A) and Allow once (Y).
- Search (⌘K): finds words in every conversation of every space, jumps to a space, and runs actions (New chat, Open settings, theme, New space).
- Study tools (turned on per space in Settings › Spaces): Study (flashcards, quizzes and review of due cards; Make a quiz walks through course, test or topics and what it covers, then size, difficulty and model, shows each stage while it writes and can be stopped; a quiz is answered one question at a time with 1–9, Enter and arrow keys, then shows results by topic with Retake misses), Grades (each course's grade and trend first, then what's due soon, missing, recently graded and the items that move the grade most, then full tables with what-if scores), Plan (upcoming deadlines and exams and a study schedule) and Courses (connect Canvas, Brightspace, Moodle or Blackboard, import courses, choose which parts each space can see, and browse what was imported). Opening a file shows it in a panel on the right.
- Settings (⌘,) is not a tab: it takes the page's place, with its own list of sections and "Settings / section" in the title bar instead of the tabs; Back (or Esc) returns to the tab you were on, as it was. Sections:
  - General: where the Phaethon folder is, and the keyboard shortcuts.
  - Notifications: which notifications show (replies that finish while the user is in another app, reminders shortly before an event or a task's due time, scheduled tasks, mail sent or not sent, the daily digest, problems with automations), how long before an event to remind, quiet hours, Send a test; and in the background: keep running in the menu bar when the window is closed, open at login (menu bar only), pause automations.
  - AI & Models: every AI service on one page, always listed, each row saying Ready or Set up. Popular: Claude, ChatGPT and Google Gemini, each with two tabs: a plan the user already pays for (Claude Pro or Max through Claude Code, ChatGPT Plus or Pro through Codex, Gemini CLI; "Install and connect" runs the maker's own installer and then its sign-in in the browser; "Use SSO" signs in to Claude Code through a school's or company's login page; accounts and usage limits show there) or an API key with a default model. More AI services: OpenRouter, Groq, Together AI, Mistral, DeepSeek, xAI (an API key each). On this computer: Ollama and LM Studio. Your own server: any OpenAI-compatible address. Last, a switch to move to another set-up model automatically when one fails (on by default; the chat notes which model took over).
  - Spaces: each space's name, description, colour and study tools; its working folder for coding agents; Full access (lets a coding agent in that space read and change anything on this computer and use the internet without asking); which other spaces may read this one (read-only, removable); where Phaethon writes files without asking (the space, or single conversations; removable); and export as a .zip.
  - Courses: course sites and which space sees which course.
  - Memory: privacy switches (let agents remember, the daily review of conversations, sharing life events across spaces, letting agents add to the profile), the user's own profile ("About me", read by every space) and each space's profile, the front burner (what is remembered now, with times; mark done, dismiss, edit, add) and its archive, and "Try a message" to see what would come up for a message.
  - People: everyone Phaethon knows, with names and aliases ("my boss"), relation, contact details and links, which spaces see them, notes, and their history across chat and email.
  - Mail & connectors: turn on Apple Mail or Outlook (Phaethon uses the accounts already added there; macOS asks once for permission), choose which space may use each account, whether agents may send (always with a countdown, one minute by default) and how long it counts down, whether to keep people's email history from senders and subjects, and which Shortcuts each space may run.
  - Automations: background jobs (letting memories die off, the daily review, people's email history, the daily digest) with their status and Run now, and the user's own schedules (a prompt run in a space on a schedule).
  - Appearance: light, dark or the computer's theme.
  - About: the version and updates. When a new version is out, Phaethon also shows a window a few seconds after it opens with what changed, and Install and restart, Later or Skip this version; the sidebar shows "Update to …" until it's installed. After updating, a "What's new" window shows once.
- Email drafts appear as a card showing the account it sends from, the recipients, subject, message and any attached files from the space (each opens in Phaethon's viewer and can be removed with its ×): Send, Edit, Open in Mail, Discard, Review and tone changes (More formal, Shorter, Warmer, Other…). A send the agent was asked to make counts down on the card with Stop, Edit and Send now; nothing is sent before the countdown ends.
- Phaethon lives on in the menu bar (the notification area on Windows and Linux) after its window is closed, using little memory, so reminders, automations and timed sends keep going. The menu shows replies being written, emails counting down (with Stop sending), the next automation (with Pause automations), recent notifications (each opens what it's about), Settings… and Quit Phaethon. Clicking a notification opens the conversation or page it's about.
- Another space's files can't be read by default; the user can give read-only access when asked, and remove it in Settings › Spaces.`;

/** The own loop's section: the buttons plus a pointer to the app_guide tool. */
export function appGuidePromptSection(): string {
  return `${actionsPrompt()}\n\nCall app_guide before telling the user where something is in Phaethon or how to change a setting: it lists every place and setting by its name in the app.`;
}

/** For CLI backends, which have no app_guide tool. */
export function appGuideCliSection(): string {
  return `${actionsPrompt()}\n\n${PLACES}`;
}
