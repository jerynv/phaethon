//! A space's conversation, stored as a plain JSON file in the space:
//! `<space>/.phaethon/thread.json`, a list of messages in the Messages API shape
//! (`{"role": ..., "content": [blocks]}`).
//!
//! The history is append-only: blocks the model returned (thinking blocks
//! included) are saved and sent back exactly as received, because editing
//! earlier turns invalidates them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

use crate::attachments::is_attachment_ref;
use crate::tools::STATE_DIR;

fn file(space: &Path) -> PathBuf {
    space.join(STATE_DIR).join("thread.json")
}

/// The saved messages, or none if there is no thread yet. A file that is not a
/// list of messages is an error, never silently replaced: it is the user's data.
pub fn load(space: &Path) -> io::Result<Vec<Value>> {
    let raw = match fs::read_to_string(file(space)) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| io::Error::other(format!("thread.json is not valid JSON: {e}")))?;
    match v {
        Value::Array(msgs) if msgs.iter().all(is_message) => Ok(msgs),
        _ => Err(io::Error::other("thread.json is not a list of messages")),
    }
}

fn is_message(m: &Value) -> bool {
    matches!(m["role"].as_str(), Some("user" | "assistant")) && m["content"].is_array()
}

/// Write the whole thread. Goes through a temporary file and a rename, so a
/// crash mid-write never leaves half a file.
pub fn save(space: &Path, msgs: &[Value]) -> io::Result<()> {
    let path = file(space);
    fs::create_dir_all(path.parent().expect("thread file has a parent"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(msgs)?)?;
    fs::rename(&tmp, &path)
}

pub fn user_text(text: &str) -> Value {
    user_message(text, &[])
}

/// A user message: attachments first (the model reads them before the
/// question), then the text.
pub fn user_message(text: &str, attachments: &[Value]) -> Value {
    let mut content: Vec<Value> = attachments.to_vec();
    if !text.trim().is_empty() || content.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    json!({"role": "user", "content": content})
}

/// One message as the UI shows it after a reload.
#[derive(Debug, Serialize, PartialEq)]
pub struct UiMessage {
    pub role: &'static str,
    pub text: String,
    /// Files the user attached, as saved in the space.
    pub attachments: Vec<UiAttachment>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiAttachment {
    pub name: String,
    pub path: String,
    pub media_type: String,
}

/// The thread as the UI shows it: user text, and each assistant reply as one
/// message even when it spans several model turns around tool calls. Tool
/// results and thinking are not shown.
pub fn to_ui(msgs: &[Value]) -> Vec<UiMessage> {
    let mut out: Vec<UiMessage> = vec![];
    for m in msgs {
        let texts: Vec<&str> = m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !t.trim().is_empty())
            .collect();
        let files: Vec<UiAttachment> = m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| is_attachment_ref(b))
            .map(|b| UiAttachment {
                name: b["name"].as_str().unwrap_or("").into(),
                path: b["path"].as_str().unwrap_or("").into(),
                media_type: b["media_type"].as_str().unwrap_or("").into(),
            })
            .collect();
        match m["role"].as_str() {
            Some("user") if !texts.is_empty() || !files.is_empty() => out.push(UiMessage {
                role: "user",
                text: texts.join("\n\n"),
                attachments: files,
            }),
            Some("assistant") if !texts.is_empty() => {
                let joined = texts.join("\n\n");
                match out.last_mut() {
                    Some(last) if last.role == "assistant" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(&joined);
                    }
                    _ => out.push(UiMessage {
                        role: "assistant",
                        text: joined,
                        attachments: vec![],
                    }),
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_ui_view() {
        let dir = std::env::temp_dir().join(format!("phaethon-thread-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        let msgs = vec![
            user_text("what's in notes?"),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "t1", "name": "list_files", "input": {}}
            ]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.md"}]}),
            json!({"role": "assistant", "content": [{"type": "text", "text": "There is a.md."}]}),
        ];
        save(&dir, &msgs).unwrap();
        assert_eq!(load(&dir).unwrap(), msgs);
        assert_eq!(
            to_ui(&msgs),
            vec![
                UiMessage { role: "user", text: "what's in notes?".into(), attachments: vec![] },
                UiMessage { role: "assistant", text: "Let me look.\n\nThere is a.md.".into(), attachments: vec![] },
            ]
        );
        fs::write(file(&dir), "{\"not\": \"a list\"}").unwrap();
        assert!(load(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
