//! What the chat can show, told to every assistant that answers in it:
//! Phaethon's own agent (agent_loop.rs) and the CLIs (agent.rs). The text is
//! fixed here, never anything a user or a file wrote.

/// The section, as it goes into a system prompt.
pub const PROMPT: &str = "# How your replies are shown

Phaethon's chat renders Markdown, and also:
- Math with KaTeX: $…$ inline, $$…$$ on lines of their own for display. Write a dollar meaning money as \\$.
- Diagrams: a ```mermaid fence (flowchart, sequence, state, class, timeline, mindmap…).
- LaTeX documents: a complete document (\\documentclass … \\end{document}) in a ```latex fence is compiled on the user's computer and shown as a PDF they can read in the app and save into the space. Use one for study guides, worksheets, handouts and anything with graphs; TikZ and pgfplots work (\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}). It must compile on its own: no \\input, \\include or images from files, no shell escape. Prefer common packages (amsmath, amssymb, amsthm, geometry, xcolor, tikz, pgfplots, hyperref, booktabs, enumitem).
- Figures: a ```tikz fence with one tikzpicture (a pgfplots axis inside it is fine) is drawn as a picture in the reply.
Say in words what each figure or diagram shows, for anyone who can't see it.";

/// The section followed by `more` (a tutor mode's instructions, say), as one
/// block for a CLI that takes a single set of extra instructions.
pub fn with_instructions(more: Option<String>) -> Option<String> {
    Some(match more {
        Some(m) => format!("{PROMPT}\n\n{m}"),
        None => PROMPT.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_each_thing_the_chat_shows_and_keeps_what_follows_last() {
        for s in ["$…$", "```mermaid", "```latex", "\\documentclass", "pgfplots", "```tikz", "no \\input"] {
            assert!(PROMPT.contains(s), "{s}");
        }
        assert!(PROMPT.len() < 1500, "kept short: {}", PROMPT.len());
        let both = with_instructions(Some("# Tutor mode: Quiz me".into())).unwrap();
        assert!(both.starts_with(PROMPT) && both.ends_with("# Tutor mode: Quiz me"));
        assert_eq!(with_instructions(None).as_deref(), Some(PROMPT));
    }
}
