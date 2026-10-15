//! What Phaethon has and where each thing is, so the assistant can point the
//! user to the right control instead of guessing at buttons, and the buttons
//! it can put under a reply (a ```phaethon-actions block, drawn by
//! chat-actions.tsx). Phaethon's own agent reads the guide with the
//! `app_guide` tool; a CLI, which can't call Phaethon's tools, is given it
//! with its instructions. Fixed text, never anything a user or a file wrote.

pub const FENCE: &str = "phaethon-actions";

/// The buttons a reply can offer: (id, what pressing it does). The words and
/// icons on them are the app's (src/lib/chat-actions.ts), so a reply can't
/// label a button as something else.
pub const ACTIONS: &[(&str, &str)] = &[
    ("add-files", "the user picks files on their computer and they are copied into this space's files/ folder"),
    ("add-folder", "the user picks a folder and it is copied, with everything in it, into this space's files/ folder"),
    ("attach-files", "opens the file picker to attach files to their next message"),
    ("show-folder", "opens this space's folder in Finder (File Explorer, Files)"),
    ("import-courses", "imports courses from a course site"),
    ("new-space", "makes a new space"),
    ("settings-assistant", "opens Settings › Assistant"),
    ("settings-appearance", "opens Settings › Appearance"),
    ("settings-accessibility", "opens Settings › Accessibility"),
    ("settings-spaces", "opens Settings › Spaces"),
    ("settings-courses", "opens Settings › Course sites"),
    ("settings-about", "opens Settings › About"),
];

/// Where things are. "⌘" is Ctrl on Windows and Linux.
const PLACES: &str = "# Where things are in Phaethon

Use this to tell the user exactly where a control is, by its name as it appears. Never say you can't see the app, and never guess at buttons not listed here.

- Spaces: the sidebar on the left lists them; ⌘1…9 goes to one. Each space has a menu (its … button, a right-click, or Shift+F10): Show in Finder, Add files…, Add a folder…, Export… (the whole space as a .zip), Import courses…, Course access…, Edit name and colour…. New space… is in the command palette (⌘K).
- Files in a space: the space is a folder on the computer. Add files… and Add a folder… (in the + button beside the message box, and in the space's menu) copy files or a whole folder into the space's files/ folder, where you can read them; the originals stay where they were. Hidden files and links are left out; up to 5000 files and 1 GB at once. Anything put in the space's folder by hand (Show in Finder) can be read too.
- Attaching to a message: + › Attach files…, or drag files onto the conversation. Up to 10 files per message: images, PDFs, Word documents and text. Attached files are saved in the space's attachments/ folder. A folder can't be attached: add it to the space instead.
- Beside the message box: the model for this space, and the tutor mode (Normal, Quiz me, Explain it back, Socratic, Exam cram).
- Views in each space: Chat, Study (flashcards, quizzes, review), Grades, Plan (⌥⌘1…4, or the tabs at the top).
- Command palette: ⌘K finds any space or command. ⌘N new conversation, ⌘⇧F search conversations, ⌘/ every keyboard shortcut.
- Settings (⌘, or Settings in the title bar) has these sections:
  - Assistant: which assistant answers (Phaethon's own assistant, with a provider such as Anthropic, OpenAI, OpenRouter, Groq, or Ollama and LM Studio on this computer; or Claude Code, Codex or Gemini CLI on this computer, signed in there), the provider's API key and the default model.
  - Appearance: theme (light, dark or the computer's), colour, and layout (density, roundness, sidebar width).
  - Accessibility: increase contrast, reading font (Atkinson Hyperlegible, OpenDyslexic, Lexend, the system font), text size with line, letter and word spacing, larger click targets, reduce motion, wide reading.
  - Spaces: each space's name, description and colour; which other spaces it may read (read-only, and removable) and which courses it sees.
  - Course sites: connect Canvas, Brightspace, Moodle or Blackboard; who can see each course.
  - About: the version, the licence, where the Phaethon folder is, and updates.
- Another space's files can't be read by default; the user can give read-only access when asked, and remove it in Settings › Spaces.";

/// How to offer buttons, told to every assistant.
pub fn actions_prompt() -> String {
    let list: Vec<String> = ACTIONS.iter().map(|(id, does)| format!("- {id}: {does}")).collect();
    format!(
        "# Buttons under your reply

When the user wants to do something in the app (add a file or folder, change a setting, connect a course site), say where it is in one short sentence and put the buttons for it after your reply: a ```{FENCE} block with one id per line, at most 3, the most likely first. The app draws them as buttons; anything not in this list is ignored:
{}
For example, someone who wants to bring in a folder of school files gets add-folder and add-files.",
        list.join("\n")
    )
}

/// The guide, as the app_guide tool returns it.
pub fn guide() -> String {
    PLACES.to_string()
}

/// For Phaethon's own agent: the buttons, and that the guide is a tool call away.
pub fn prompt_section() -> String {
    format!(
        "{}\n\nCall app_guide before telling the user where something is in Phaethon or how to change a setting: it lists every place and setting by its name in the app.",
        actions_prompt()
    )
}

/// For a CLI, which can't call app_guide: the buttons and the whole guide.
pub fn cli_section() -> String {
    format!("{}\n\n{}", actions_prompt(), PLACES)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every id here is one the app draws, and the other way round.
    #[test]
    fn the_app_draws_every_action() {
        let ts = include_str!("../../src/lib/chat-actions.ts");
        let list = ts.split("CHAT_ACTION_IDS = [").nth(1).and_then(|r| r.split(']').next()).expect("the id list");
        let drawn: Vec<&str> = list.split(',').map(|w| w.trim().trim_matches('"')).filter(|w| !w.is_empty()).collect();
        let ours: Vec<&str> = ACTIONS.iter().map(|(id, _)| *id).collect();
        assert_eq!(drawn, ours);
        assert!(ts.contains(&format!("ACTIONS_FENCE = \"{FENCE}\"")));
    }

    #[test]
    fn the_prompts_say_what_each_backend_needs() {
        let own = prompt_section();
        assert!(own.contains("app_guide") && own.contains("```phaethon-actions") && own.contains("- add-folder:"));
        assert!(!own.contains("# Where things are"), "own agent reads the guide by tool");
        let cli = cli_section();
        assert!(cli.contains("# Where things are") && !cli.contains("Call app_guide"));
        assert!(guide().contains("Add a folder…") && guide().contains("Settings"));
        assert!(cli.len() < 5000, "kept short: {}", cli.len());
    }
}
