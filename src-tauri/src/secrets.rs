//! Provider API keys in the OS keychain, namespaced by vault. Never written to
//! the vault folder (it may sync) and never sent to the webview: the UI can set
//! or clear a key and ask whether one exists, but cannot read it back.

use keyring::Entry;

const SERVICE: &str = "phaethon";

pub const PROVIDERS: &[&str] = &["anthropic"];

fn entry(vault: &str, provider: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider \"{provider}\""));
    }
    Entry::new(SERVICE, &format!("{vault}/provider/{provider}"))
        .map_err(|e| format!("keychain unavailable: {e}"))
}

/// Keychain service used before the app was renamed to Phaethon.
const LEGACY_SERVICE: &str = "steward";

pub fn get(vault: &str, provider: &str) -> Result<Option<String>, String> {
    match entry(vault, provider)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => migrate_legacy(vault, provider),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

/// A key saved under the old name moves to the new one the first time it is read.
fn migrate_legacy(vault: &str, provider: &str) -> Result<Option<String>, String> {
    let Ok(old) = Entry::new(LEGACY_SERVICE, &format!("{vault}/provider/{provider}")) else {
        return Ok(None);
    };
    match old.get_password() {
        Ok(k) => {
            set(vault, provider, &k)?;
            let _ = old.delete_credential();
            Ok(Some(k))
        }
        Err(_) => Ok(None),
    }
}

pub fn set(vault: &str, provider: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("That does not look like an API key.".into());
    }
    entry(vault, provider)?
        .set_password(key)
        .map_err(|e| format!("could not save to the keychain: {e}"))
}

pub fn clear(vault: &str, provider: &str) -> Result<(), String> {
    match entry(vault, provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the key from the keychain: {e}")),
    }
}
