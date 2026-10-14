//! A space's own model: `"model"` in `<space>/.phaethon/space.json`, beside
//! its name and colour, so the choice travels with the space when it syncs.
//! Phaethon's own agent answers in that space with it instead of the default
//! model setting. The value is a model reference (providers.rs): a plain id is
//! an Anthropic model, `provider:model` any other provider's. The file is
//! user-editable, so a value that isn't one is ignored and the default is used.

use std::collections::BTreeMap;
use std::path::Path;

use crate::providers::{self, ModelRef};
use crate::spaces::{self, meta_file, read_meta_raw, write_meta};
use crate::vault::Vault;

/// The model saved for the space in `dir`, if it has a valid one.
pub fn get_ref(dir: &Path) -> Option<ModelRef> {
    let meta = read_meta_raw(dir).ok().flatten()?;
    providers::parse_ref(meta.get("model")?.as_str()?)
}

/// [`get_ref`] as saved: a plain id for Anthropic, `provider:model` otherwise.
pub fn get(dir: &Path) -> Option<String> {
    get_ref(dir).map(|r| r.saved())
}

/// The model a turn in the space at `dir` uses: its own, else `default`
/// (the vault's model setting; `None` there means the provider's default).
pub fn resolve(dir: &Path, default: Option<String>) -> Option<String> {
    get(dir).or(default)
}

/// Save `model` as the space's own, or with `None` remove it so the space
/// uses the default again. Every other field in space.json is kept; a file
/// that can't be read is refused rather than overwritten.
pub fn set(vault: &Vault, id: &str, model: Option<&str>) -> Result<(), String> {
    let dir = vault.space_dir(id)?;
    let model = match model.map(str::trim) {
        None => None,
        Some(m) => match providers::parse_ref(m) {
            Some(r) => Some(r.saved()),
            None => return Err("That isn’t a model Phaethon knows how to use.".into()),
        },
    };
    let mut meta = match read_meta_raw(&dir) {
        Ok(Some(serde_json::Value::Object(o))) => o,
        Ok(None) => serde_json::Map::new(),
        Ok(Some(_)) | Err(_) if meta_file(&dir).exists() => {
            return Err(format!(
                "This space’s settings file can’t be read, so the model wasn’t changed. Fix or delete {}.",
                meta_file(&dir).display()
            ));
        }
        _ => serde_json::Map::new(),
    };
    match model {
        Some(m) => meta.insert("model".into(), m.into()),
        None => meta.remove("model"),
    };
    write_meta(&dir, &meta).map_err(|e| format!("The model couldn’t be saved: {e}"))
}

/// Every space that has its own model, by id. Spaces using the default are left out.
pub fn list(vault: &Vault) -> Result<BTreeMap<String, String>, String> {
    Ok(spaces::list(vault)?
        .into_iter()
        .filter_map(|s| {
            let model = get(&vault.space_dir(&s.id).ok()?)?;
            Some((s.id, model))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> (PathBuf, Vault) {
        let root = std::env::temp_dir().join(format!("phaethon-space-model-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let vault = Vault::at(&root);
        vault.ensure_initialized().unwrap();
        (root, vault)
    }

    fn saved(root: &Path, id: &str) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(root.join("spaces").join(id).join(".phaethon/space.json")).unwrap()).unwrap()
    }

    #[test]
    fn each_space_keeps_its_own_model_and_falls_back_to_the_default() {
        let (root, vault) = temp_vault("own");
        let (school, work) = (vault.space_dir("school").unwrap(), vault.space_dir("work").unwrap());
        let default = Some("claude-opus-5-5".to_string());
        assert_eq!(resolve(&school, default.clone()), default);
        assert_eq!(resolve(&school, None), None);

        set(&vault, "work", Some(" claude-sonnet-5-5 ")).unwrap();
        assert_eq!(get(&work).as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(resolve(&work, default.clone()).as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(resolve(&school, default.clone()), default, "another space is not affected");
        assert_eq!(list(&vault).unwrap(), BTreeMap::from([("work".to_string(), "claude-sonnet-5-5".to_string())]));

        set(&vault, "work", None).unwrap();
        assert_eq!(resolve(&work, default.clone()), default);
        assert!(list(&vault).unwrap().is_empty());
        assert_eq!(saved(&root, "work"), json!({}));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_space_can_use_another_providers_model() {
        let (root, vault) = temp_vault("other");
        set(&vault, "school", Some("openrouter:openai/gpt-5:free")).unwrap();
        set(&vault, "work", Some("anthropic:claude-haiku-5-5")).unwrap();
        assert_eq!(saved(&root, "school")["model"], "openrouter:openai/gpt-5:free");
        assert_eq!(saved(&root, "work")["model"], "claude-haiku-5-5", "Anthropic models are saved plain");
        let r = get_ref(&vault.space_dir("school").unwrap()).unwrap();
        assert_eq!((r.provider.id, r.model.as_str()), ("openrouter", "openai/gpt-5:free"));
        assert_eq!(list(&vault).unwrap()["school"], "openrouter:openai/gpt-5:free");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn other_fields_are_kept() {
        let (root, vault) = temp_vault("keep");
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), r#"{"name":"Uni","hue":200,"future":[1]}"#).unwrap();
        set(&vault, "school", Some("claude-haiku-5-5")).unwrap();
        assert_eq!(saved(&root, "school"), json!({ "name": "Uni", "hue": 200, "future": [1], "model": "claude-haiku-5-5" }));
        // And a rename keeps the model.
        spaces::update(&vault, "school", Some("School"), None, None).unwrap();
        assert_eq!(saved(&root, "school")["model"], "claude-haiku-5-5");
        set(&vault, "school", None).unwrap();
        assert_eq!(saved(&root, "school"), json!({ "name": "School", "hue": 200, "future": [1] }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bad_models_spaces_and_files_are_refused() {
        let (root, vault) = temp_vault("bad");
        for bad in ["", "gpt-5", "claude-", "Claude-Opus", "claude-opus 5", "claude-../x", "openai:", "openai:a b", "nope:gpt-5"] {
            assert!(set(&vault, "school", Some(bad)).is_err(), "{bad:?}");
        }
        for id in ["nope", "../memory", "", "School", "work/../school"] {
            assert!(set(&vault, id, Some("claude-opus-5-5")).is_err(), "{id:?}");
        }
        assert!(!root.join("spaces/school/.phaethon/space.json").exists(), "nothing was written");
        assert!(!root.join("memory/.phaethon").exists());

        let state = root.join("spaces/work/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), "{ broken").unwrap();
        let err = set(&vault, "work", Some("claude-opus-5-5")).unwrap_err();
        assert!(err.contains("can’t be read"), "{err}");
        assert_eq!(fs::read_to_string(state.join("space.json")).unwrap(), "{ broken");
        assert_eq!(get(&vault.space_dir("work").unwrap()), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_hand_edited_model_that_isnt_one_is_ignored() {
        let (root, vault) = temp_vault("edited");
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        let dir = vault.space_dir("school").unwrap();
        for bad in [json!({ "model": "--help" }), json!({ "model": 5 }), json!({ "model": null }), json!({ "model": "gpt-5" })] {
            fs::write(state.join("space.json"), bad.to_string()).unwrap();
            assert_eq!(resolve(&dir, Some("claude-opus-5-5".into())).as_deref(), Some("claude-opus-5-5"), "{bad}");
        }
        assert!(list(&vault).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_space_json_is_neither_read_nor_written() {
        let (root, vault) = temp_vault("link");
        fs::write(root.join("outside.json"), r#"{"model":"claude-sonnet-5-5"}"#).unwrap();
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        std::os::unix::fs::symlink(root.join("outside.json"), state.join("space.json")).unwrap();
        assert_eq!(get(&vault.space_dir("school").unwrap()), None);
        assert!(set(&vault, "school", Some("claude-haiku-5-5")).is_err());
        assert!(fs::read_to_string(root.join("outside.json")).unwrap().contains("sonnet"));
        fs::remove_dir_all(root).unwrap();
    }
}
