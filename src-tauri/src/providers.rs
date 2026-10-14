//! Which model provider answers, and with what. Every provider Phaethon knows
//! is a [`Preset`]: Anthropic (anthropic.rs), and services that speak OpenAI's
//! Chat Completions (openai.rs) — OpenAI, OpenRouter, Groq, Together, Mistral,
//! DeepSeek, xAI, Ollama and LM Studio on this computer, and a server of the
//! person's own.
//!
//! A model is named by a reference, `provider:model` (`openrouter:openai/gpt-5`);
//! a plain id is an Anthropic model, as space.json and settings.json held them
//! before there were other providers. Anthropic models are saved plain.
//!
//! Keys live in the keychain (secrets.rs) and only ever go to their own
//! provider: a preset's address is fixed here, never read from the (synced,
//! editable) settings file, and the key for a server of one's own is saved
//! together with the origin it was saved for and is sent nowhere else. Local
//! servers get no key at all. Redirects are never followed with a key.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use url::Url;

use crate::anthropic::{self, Anthropic};
use crate::openai::{self, OpenAi};
use crate::provider::{Delta, ModelRequest, ModelTurn, Provider, ProviderError};
use crate::vault::{Vault, VaultSettings};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyNeed {
    Required,
    Optional,
    None,
}

#[derive(Debug)]
pub struct Preset {
    pub id: &'static str,
    /// For people: "OpenRouter".
    pub name: &'static str,
    /// Where requests go; empty for a server of one's own (the person says).
    pub base: &'static str,
    pub key: KeyNeed,
    /// Runs on this computer: nothing leaves it, and no key is sent.
    pub local: bool,
    /// Whether the person may change the address (local and own servers only).
    pub editable_base: bool,
    /// Where to make a key, for the key field's hint.
    pub keys_url: &'static str,
    /// A start no other provider's keys share, when keys have one.
    pub key_prefix: &'static str,
    /// The path (after `base`) of a cheap call that needs a working key.
    pub check_path: &'static str,
}

pub const ANTHROPIC: &str = "anthropic";
pub const CUSTOM: &str = "custom";

pub const PRESETS: &[Preset] = &[
    Preset { id: ANTHROPIC, name: "Anthropic", base: "https://api.anthropic.com", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://console.anthropic.com/settings/keys", key_prefix: "sk-ant-", check_path: "/v1/models?limit=1" },
    Preset { id: "openai", name: "OpenAI", base: "https://api.openai.com/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://platform.openai.com/api-keys", key_prefix: "", check_path: "/models" },
    // OpenRouter's model list is public, so its key is checked with /key.
    Preset { id: "openrouter", name: "OpenRouter", base: "https://openrouter.ai/api/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://openrouter.ai/settings/keys", key_prefix: "sk-or-", check_path: "/key" },
    Preset { id: "groq", name: "Groq", base: "https://api.groq.com/openai/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://console.groq.com/keys", key_prefix: "gsk_", check_path: "/models" },
    Preset { id: "together", name: "Together AI", base: "https://api.together.xyz/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://api.together.ai/settings/api-keys", key_prefix: "", check_path: "/models" },
    Preset { id: "mistral", name: "Mistral", base: "https://api.mistral.ai/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://console.mistral.ai/api-keys", key_prefix: "", check_path: "/models" },
    Preset { id: "deepseek", name: "DeepSeek", base: "https://api.deepseek.com/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://platform.deepseek.com/api_keys", key_prefix: "", check_path: "/models" },
    Preset { id: "xai", name: "xAI", base: "https://api.x.ai/v1", key: KeyNeed::Required, local: false, editable_base: false, keys_url: "https://console.x.ai", key_prefix: "xai-", check_path: "/models" },
    Preset { id: "ollama", name: "Ollama", base: "http://127.0.0.1:11434/v1", key: KeyNeed::None, local: true, editable_base: true, keys_url: "", key_prefix: "", check_path: "/models" },
    Preset { id: "lmstudio", name: "LM Studio", base: "http://127.0.0.1:1234/v1", key: KeyNeed::None, local: true, editable_base: true, keys_url: "", key_prefix: "", check_path: "/models" },
    Preset { id: CUSTOM, name: "Your own server", base: "", key: KeyNeed::Optional, local: false, editable_base: true, keys_url: "", key_prefix: "", check_path: "/models" },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// The providers whose keys may be saved (local servers take none).
pub fn keyed_ids() -> impl Iterator<Item = &'static str> {
    PRESETS.iter().filter(|p| p.key != KeyNeed::None).map(|p| p.id)
}

// ---- Model references -------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: &'static Preset,
    pub model: String,
}

impl PartialEq for Preset {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for Preset {}

impl ModelRef {
    /// As saved: plain for Anthropic, `provider:model` otherwise.
    pub fn saved(&self) -> String {
        if self.provider.id == ANTHROPIC { self.model.clone() } else { format!("{}:{}", self.provider.id, self.model) }
    }
}

/// A model id as OpenAI-compatible services write them: `gpt-5`,
/// `openai/gpt-5:free`, `llama3.2:3b`, `org/Model-7B@q4`. One line of plain
/// characters, so it can't smuggle anything into a path, a header or a flag.
pub fn is_valid_compat_model(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.starts_with(['-', '.', '/', ':'])
        && !id.contains("..")
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:/@+".contains(&b))
}

/// A saved model reference, checked. `None` for anything that isn't one.
pub fn parse_ref(s: &str) -> Option<ModelRef> {
    let s = s.trim();
    if let Some((p, m)) = s.split_once(':')
        && let Some(provider) = preset(p)
    {
        let ok = if provider.id == ANTHROPIC { anthropic::is_valid_model_id(m) } else { is_valid_compat_model(m) };
        return ok.then(|| ModelRef { provider, model: m.to_string() });
    }
    anthropic::is_valid_model_id(s).then(|| ModelRef { provider: preset(ANTHROPIC).expect("anthropic"), model: s.to_string() })
}

// ---- What the vault's settings say ------------------------------------------

/// The provider chosen for Phaethon's own agent (`"provider"` in settings.json).
pub fn chosen(settings: &VaultSettings) -> &'static Preset {
    settings.provider.as_deref().and_then(preset).unwrap_or_else(|| preset(ANTHROPIC).expect("anthropic"))
}

fn string_map(v: &Option<Value>) -> BTreeMap<String, String> {
    v.as_ref()
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.trim().to_string()))).collect())
        .unwrap_or_default()
}

/// The model chosen for `p` in Settings, if a valid one is saved.
pub fn chosen_model(settings: &VaultSettings, p: &Preset) -> Option<String> {
    if p.id == ANTHROPIC {
        return Some(settings.model.clone().filter(|m| anthropic::is_valid_model_id(m)).unwrap_or_else(|| anthropic::DEFAULT_MODEL.into()));
    }
    string_map(&settings.provider_models).remove(p.id).filter(|m| is_valid_compat_model(m))
}

/// The default model: the chosen provider's chosen model. `None` when a
/// provider other than Anthropic is chosen and no model is picked for it yet.
pub fn default_ref(settings: &VaultSettings) -> Option<ModelRef> {
    let provider = chosen(settings);
    chosen_model(settings, provider).map(|model| ModelRef { provider, model })
}

/// Where requests for `p` go. A preset's own address always; only local and
/// own servers take one from the settings file, and it must pass [`check_base`].
pub fn base_url(settings: &VaultSettings, p: &Preset) -> Result<String, String> {
    if p.id == ANTHROPIC {
        return Ok(anthropic::base_url());
    }
    if !p.editable_base {
        return Ok(p.base.to_string());
    }
    match string_map(&settings.provider_urls).remove(p.id).filter(|u| !u.is_empty()) {
        Some(u) => check_base(&u).map_err(|_| format!("The address saved for {} isn’t one Phaethon can use. Fix it in Settings › Assistant.", p.name)),
        None if !p.base.is_empty() => Ok(p.base.to_string()),
        None => Err("Add your server’s address in Settings › Assistant first.".into()),
    }
}

/// An address for a server: http or https, a host, no name or password in
/// it, no query or fragment. Returned without a trailing `/`.
pub fn check_base(raw: &str) -> Result<String, String> {
    let bad = || "That isn’t an address Phaethon can use. It looks like http://127.0.0.1:11434/v1 or https://example.com/v1.".to_string();
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 300 || raw.chars().any(char::is_whitespace) {
        return Err(bad());
    }
    let url = Url::parse(raw).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(bad());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(bad());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `scheme://host:port` of an address.
pub fn origin(base: &str) -> Option<String> {
    Url::parse(base).ok().map(|u| u.origin().ascii_serialization()).filter(|o| o != "null")
}

/// Whether `base` is on this computer.
pub fn is_loopback(base: &str) -> bool {
    Url::parse(base).ok().is_some_and(|u| match u.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    })
}

// ---- Keys ---------------------------------------------------------------------

/// The provider a key so plainly belongs to that it must not go anywhere else.
fn owner_of(key: &str) -> Option<&'static Preset> {
    PRESETS.iter().filter(|p| !p.key_prefix.is_empty()).find(|p| key.starts_with(p.key_prefix))
}

/// Why `key` can't be used with `p` (at `base`), before anything is sent: an
/// empty or malformed key, or one that plainly belongs to another provider.
pub fn key_problem(p: &Preset, base: &str, key: &str) -> Option<String> {
    let key = key.trim();
    if key.len() < 8 || key.len() > 400 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Some(format!("That doesn’t look like a {} API key. Copy the whole key again; it’s one line with no spaces.", p.name));
    }
    match owner_of(key) {
        // A key of one provider never goes to another, unless the person's own server is that provider's address.
        Some(o) if o.id != p.id && !(p.id == CUSTOM && origin(base) == origin(o.base)) => {
            Some(format!("That looks like a key for {}, not {}, so it wasn’t sent anywhere. Choose {} as the provider, or paste a {} key.", o.name, p.name, o.name, p.name))
        }
        _ => None,
    }
}

/// What the keychain holds for a server of one's own: the key and the origin
/// it was saved for.
pub fn bind_custom_key(base: &str, key: &str) -> Result<String, String> {
    let origin = origin(base).ok_or("Add your server’s address first, then its key.")?;
    Ok(serde_json::json!({"origin": origin, "key": key.trim()}).to_string())
}

/// The key for a server of one's own, only if it was saved for `base`'s origin.
pub fn unbind_custom_key(saved: &str, base: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(saved).map_err(|_| "The key saved for your own server can’t be read. Save it again in Settings › Assistant.".to_string())?;
    let (Some(o), Some(k)) = (v["origin"].as_str(), v["key"].as_str()) else {
        return Err("The key saved for your own server can’t be read. Save it again in Settings › Assistant.".into());
    };
    if origin(base).as_deref() != Some(o) {
        return Err(format!(
            "The key for your own server was saved for {o}, and the address is now {}. Save the key again for the new address in Settings › Assistant.",
            origin(base).unwrap_or_default()
        ));
    }
    Ok(k.to_string())
}

/// The key to send to `p` at `base`: none for local servers, the saved one
/// otherwise (an own server's only for the origin it was saved for). `read`
/// reads the keychain (a parameter so tests need none).
pub fn key_for(p: &Preset, base: &str, read: impl FnOnce(&str) -> Result<Option<String>, String>) -> Result<Option<String>, String> {
    if p.key == KeyNeed::None {
        return Ok(None);
    }
    let saved = read(p.id)?;
    let key = match (p.id, saved) {
        (CUSTOM, Some(s)) => Some(unbind_custom_key(&s, base)?),
        (_, s) => s,
    };
    match key {
        None if p.key == KeyNeed::Required => Err(format!("Add your {} API key in Settings to start.", p.name)),
        Some(k) if p.id == CUSTOM && !base.starts_with("https://") && !is_loopback(base) => {
            let _ = k;
            Err("Your server’s address starts with http://, so its key would travel unprotected. Use an https:// address, or remove the key.".into())
        }
        k => Ok(k),
    }
}

// ---- The provider for a turn ---------------------------------------------------

/// Any provider Phaethon's own loop can run on.
pub enum AnyProvider {
    Anthropic(Anthropic),
    OpenAi(OpenAi),
}

impl Provider for AnyProvider {
    async fn turn(&self, req: ModelRequest<'_>, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<ModelTurn, ProviderError> {
        match self {
            AnyProvider::Anthropic(p) => p.turn(req, on_delta).await,
            AnyProvider::OpenAi(p) => p.turn(req, on_delta).await,
        }
    }
}

/// The provider for `r`, as the vault's settings say, reading keys with `read`.
pub fn build(settings: &VaultSettings, r: &ModelRef, read: impl FnOnce(&str) -> Result<Option<String>, String>) -> Result<AnyProvider, String> {
    let base = base_url(settings, r.provider)?;
    let key = key_for(r.provider, &base, read)?;
    if r.provider.id == ANTHROPIC {
        return Ok(AnyProvider::Anthropic(Anthropic::new(key.unwrap_or_default(), Some(r.model.clone()), settings.effort.clone())));
    }
    Ok(AnyProvider::OpenAi(OpenAi::new(openai::Config {
        provider: r.provider,
        base,
        key,
        model: r.model.clone(),
        effort: settings.effort.clone(),
    })))
}

/// The model a turn in the space at `space_dir` uses: its own, else the default.
pub fn model_for_space(settings: &VaultSettings, space_dir: &Path) -> Result<ModelRef, String> {
    crate::space_model::get_ref(space_dir).or_else(|| default_ref(settings)).ok_or_else(|| {
        format!("Choose which {} model answers, in Settings › Assistant.", chosen(settings).name)
    })
}

/// The provider and model that answer in the space at `space_dir`, with its
/// key from the keychain. `Err` is a message for the person (no key, no model).
pub fn for_space(vault: &Vault, space_dir: &Path) -> Result<AnyProvider, String> {
    let settings = vault.settings();
    let r = model_for_space(&settings, space_dir)?;
    let name = vault.name();
    build(&settings, &r, |id| crate::secrets::get(&name, id))
}

/// Whether `p` could answer now: a key saved where one is needed, an address
/// where one is needed. Local servers count as ready (whether they run is
/// [`openai::status`]'s question).
pub fn ready(settings: &VaultSettings, p: &Preset, has_key: bool) -> bool {
    base_url(settings, p).is_ok() && (p.key != KeyNeed::Required || has_key)
}

/// One provider as Settings shows it. Never the key: only whether one is saved.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: &'static str,
    pub name: &'static str,
    /// `"required"`, `"optional"` or `"none"`.
    pub key: &'static str,
    pub local: bool,
    pub editable_base: bool,
    pub has_key: bool,
    /// The address requests go to ("" when an own server has none yet).
    pub base_url: String,
    /// The preset's own address, for "back to the usual address".
    pub default_base_url: &'static str,
    /// The model chosen for it in Settings, if any (for Anthropic, always one).
    pub model: Option<String>,
    pub keys_url: &'static str,
    pub key_prefix: &'static str,
    pub ready: bool,
}

pub fn views(settings: &VaultSettings, has_key: impl Fn(&str) -> bool) -> Vec<ProviderView> {
    PRESETS
        .iter()
        .map(|p| {
            let has = p.key != KeyNeed::None && has_key(p.id);
            ProviderView {
                id: p.id,
                name: p.name,
                key: match p.key {
                    KeyNeed::Required => "required",
                    KeyNeed::Optional => "optional",
                    KeyNeed::None => "none",
                },
                local: p.local,
                editable_base: p.editable_base,
                has_key: has,
                base_url: base_url(settings, p).unwrap_or_default(),
                default_base_url: p.base,
                model: chosen_model(settings, p),
                keys_url: p.keys_url,
                key_prefix: p.key_prefix,
                ready: ready(settings, p, has),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(v: Value) -> VaultSettings {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn references_parse_and_old_plain_ids_mean_anthropic() {
        let r = parse_ref("claude-sonnet-5-5").unwrap();
        assert_eq!((r.provider.id, r.model.as_str(), r.saved()), (ANTHROPIC, "claude-sonnet-5-5", "claude-sonnet-5-5".to_string()));
        assert_eq!(parse_ref("anthropic:claude-haiku-5-5").unwrap().saved(), "claude-haiku-5-5", "anthropic is saved plain");
        let r = parse_ref("openrouter:openai/gpt-5:free").unwrap();
        assert_eq!((r.provider.id, r.model.as_str()), ("openrouter", "openai/gpt-5:free"));
        assert_eq!(r.saved(), "openrouter:openai/gpt-5:free");
        assert_eq!(parse_ref("ollama:llama3.2:3b").unwrap().model, "llama3.2:3b");
        assert_eq!(parse_ref(" custom:my-model ").unwrap().provider.id, "custom");
        for bad in ["", "gpt-5", "llama3.2:3b", "openai:", "openai:-rf", "openai:../x", "openai:a b", "openai:a\nb", "nope:gpt-5", "anthropic:gpt-5", "openai:/etc", "openai:é"] {
            assert!(parse_ref(bad).is_none(), "{bad:?}");
        }
        assert!(!is_valid_compat_model(&"a".repeat(201)));
    }

    #[test]
    fn the_default_is_the_chosen_providers_chosen_model() {
        let s = settings(json!({}));
        assert_eq!(default_ref(&s).unwrap().saved(), anthropic::DEFAULT_MODEL);
        let s = settings(json!({"model": "claude-haiku-5-5"}));
        assert_eq!(default_ref(&s).unwrap().saved(), "claude-haiku-5-5");
        let s = settings(json!({"provider": "openrouter", "model": "claude-haiku-5-5"}));
        assert!(default_ref(&s).is_none(), "no OpenRouter model chosen yet");
        let s = settings(json!({"provider": "openrouter", "providerModels": {"openrouter": "openai/gpt-5", "groq": "x"}}));
        assert_eq!(default_ref(&s).unwrap().saved(), "openrouter:openai/gpt-5");
        // Hand edits that aren't valid fall back, never break the whole settings file.
        let s = settings(json!({"provider": "nope", "providerModels": {"openrouter": 5}, "providerUrls": ["x"]}));
        assert_eq!(chosen(&s).id, ANTHROPIC);
        assert_eq!(chosen_model(&s, preset("openrouter").unwrap()), None);
        let s = settings(json!({"provider": "openai", "providerModels": {"openai": "--help"}}));
        assert!(default_ref(&s).is_none());
    }

    #[test]
    fn a_presets_address_is_fixed_and_only_local_or_own_servers_take_one() {
        let s = settings(json!({"providerUrls": {"openai": "https://evil.example/v1", "openrouter": "https://evil.example", "ollama": "http://192.168.1.9:11434/v1/", "custom": "https://llm.example.com/v1"}}));
        assert_eq!(base_url(&s, preset("openai").unwrap()).unwrap(), "https://api.openai.com/v1");
        assert_eq!(base_url(&s, preset("openrouter").unwrap()).unwrap(), "https://openrouter.ai/api/v1");
        assert_eq!(base_url(&s, preset("ollama").unwrap()).unwrap(), "http://192.168.1.9:11434/v1");
        assert_eq!(base_url(&s, preset("lmstudio").unwrap()).unwrap(), "http://127.0.0.1:1234/v1");
        assert_eq!(base_url(&s, preset("custom").unwrap()).unwrap(), "https://llm.example.com/v1");
        assert!(base_url(&settings(json!({})), preset("custom").unwrap()).is_err());
        let s = settings(json!({"providerUrls": {"custom": "file:///etc/passwd"}}));
        assert!(base_url(&s, preset("custom").unwrap()).is_err());
        for bad in ["", "ftp://x", "http://", "https://u:p@x.com", "https://x.com/?a=1", "https://x.com/#f", "javascript:alert(1)", "https://x .com", "x.com"] {
            assert!(check_base(bad).is_err(), "{bad:?}");
        }
        assert_eq!(check_base("http://localhost:1234/v1/").unwrap(), "http://localhost:1234/v1");
        assert!(is_loopback("http://127.0.0.1:11434/v1") && is_loopback("http://localhost:1/v1") && is_loopback("http://[::1]:1/v1"));
        assert!(!is_loopback("http://192.168.1.9:11434/v1") && !is_loopback("https://localhost.evil.com/v1"));
    }

    #[test]
    fn keys_go_only_to_their_own_provider() {
        let openai = preset("openai").unwrap();
        let custom = preset(CUSTOM).unwrap();
        assert!(key_problem(openai, openai.base, "sk-proj-abcdefghijkl").is_none());
        for (p, key) in [("openai", "sk-ant-api03-aaaaaaaaaa"), ("openai", "sk-or-v1-aaaaaaaaaaaa"), ("groq", "xai-aaaaaaaaaaaa"), ("openrouter", "gsk_aaaaaaaaaaaa"), ("anthropic", "sk-or-v1-aaaaaaaa")] {
            let pr = preset(p).unwrap();
            let msg = key_problem(pr, pr.base, key).unwrap_or_default();
            assert!(msg.contains("wasn’t sent anywhere"), "{p} {key}: {msg}");
        }
        assert!(key_problem(openai, openai.base, "short").is_some());
        assert!(key_problem(openai, openai.base, "sk-has space-aaaaaaa").is_some());
        // An own server may be a provider's address; then its key may go there.
        assert!(key_problem(custom, "https://openrouter.ai/api/v1", "sk-or-v1-aaaaaaaaaaaa").is_none());
        assert!(key_problem(custom, "https://my.example/v1", "sk-or-v1-aaaaaaaaaaaa").is_some());

        // An own server's key is bound to the origin it was saved for.
        let saved = bind_custom_key("https://llm.example.com/v1", "secret-key-1").unwrap();
        assert_eq!(unbind_custom_key(&saved, "https://llm.example.com/v2").unwrap(), "secret-key-1");
        let moved = unbind_custom_key(&saved, "https://evil.example/v1").unwrap_err();
        assert!(moved.contains("Save the key again") && !moved.contains("secret-key-1"), "{moved}");
        assert!(unbind_custom_key("secret-key-1", "https://llm.example.com/v1").is_err(), "a bare key isn't bound to anything");
        assert!(bind_custom_key("", "k").is_err());

        // Local servers never get a key, whatever the keychain holds.
        let ollama = preset("ollama").unwrap();
        assert_eq!(key_for(ollama, ollama.base, |_| panic!("the keychain is never read")).unwrap(), None);
        // A missing required key says what to do; an optional one is fine.
        assert!(key_for(openai, openai.base, |_| Ok(None)).unwrap_err().contains("Add your OpenAI API key"));
        assert_eq!(key_for(custom, "https://llm.example.com/v1", |_| Ok(None)).unwrap(), None);
        assert_eq!(key_for(custom, "https://llm.example.com/v1", |_| Ok(Some(saved.clone()))).unwrap().as_deref(), Some("secret-key-1"));
        assert!(key_for(custom, "https://evil.example/v1", |_| Ok(Some(saved.clone()))).is_err());
        // Never over plain http to another computer.
        let lan = bind_custom_key("http://192.168.1.9:8000/v1", "secret-key-2").unwrap();
        assert!(key_for(custom, "http://192.168.1.9:8000/v1", |_| Ok(Some(lan.clone()))).is_err());
        let here = bind_custom_key("http://127.0.0.1:8000/v1", "secret-key-3").unwrap();
        assert_eq!(key_for(custom, "http://127.0.0.1:8000/v1", |_| Ok(Some(here.clone()))).unwrap().as_deref(), Some("secret-key-3"));
    }

    #[test]
    fn building_a_provider_reads_only_its_own_key() {
        let s = settings(json!({"provider": "groq", "providerModels": {"groq": "llama-3.3-70b-versatile"}}));
        let r = default_ref(&s).unwrap();
        let mut asked = vec![];
        let p = build(&s, &r, |id| {
            asked.push(id.to_string());
            Ok(Some("gsk_test_key_123".into()))
        });
        assert!(matches!(p, Ok(AnyProvider::OpenAi(_))));
        assert_eq!(asked, vec!["groq"]);
        let r = parse_ref("ollama:llama3.2").unwrap();
        assert!(matches!(build(&s, &r, |_| panic!("no key for a local server")), Ok(AnyProvider::OpenAi(_))));
        let r = parse_ref("claude-opus-5-5").unwrap();
        assert!(build(&s, &r, |_| Ok(None)).err().unwrap().contains("Add your Anthropic API key in Settings to start."));
    }

    #[test]
    fn views_never_carry_a_key_and_say_what_is_ready() {
        let s = settings(json!({"provider": "openrouter", "providerModels": {"openrouter": "openai/gpt-5"}}));
        let v = views(&s, |id| id == "openrouter");
        let or = v.iter().find(|p| p.id == "openrouter").unwrap();
        assert!(or.has_key && or.ready && or.model.as_deref() == Some("openai/gpt-5"));
        let ollama = v.iter().find(|p| p.id == "ollama").unwrap();
        assert!(ollama.local && ollama.ready && !ollama.has_key && ollama.key == "none");
        let custom = v.iter().find(|p| p.id == CUSTOM).unwrap();
        assert!(!custom.ready && custom.base_url.is_empty());
        assert!(!v.iter().find(|p| p.id == "openai").unwrap().ready);
        assert_eq!(keyed_ids().collect::<Vec<_>>(), crate::secrets::PROVIDERS, "every key has its keychain namespace");
    }
}
