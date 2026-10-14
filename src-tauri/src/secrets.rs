//! Provider API keys in the OS keychain, namespaced by vault. Never written to
//! the vault folder (it may sync) and never sent to the webview: the UI can set
//! or clear a key and ask whether one exists, but cannot read it back.

use keyring::Entry;

const SERVICE: &str = "phaethon";

/// Every provider that takes a key (providers.rs); local servers take none.
pub const PROVIDERS: &[&str] = &["anthropic", "openai", "openrouter", "groq", "together", "mistral", "deepseek", "xai", "custom"];

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

// ---- Course site sessions ---------------------------------------------------
//
// A separate family from the provider keys above: one entry per connection.
// The value is the credential as JSON (cookies and CSRF token); like the keys,
// it never leaves the core. Before course sites moved to the vault, entries
// were namespaced by vault and space (`<vault>/space/<space>/lms/<id>`).

/// The keychain account for a course site connection. Refuses names that could
/// step into another namespace (a `/`, or anything but letters, digits, `-`, `_`).
pub fn lms_account(vault: &str, space: &str, connection: &str) -> Result<String, String> {
    let plain = |s: &str| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain(space) || !plain(connection) || vault.is_empty() || vault.contains('/') {
        return Err("That isn’t a course site connection Phaethon knows.".into());
    }
    Ok(format!("{vault}/space/{space}/lms/{connection}"))
}

fn lms_entry(vault: &str, space: &str, connection: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &lms_account(vault, space, connection)?).map_err(|e| format!("keychain unavailable: {e}"))
}

pub fn lms_get(vault: &str, space: &str, connection: &str) -> Result<Option<String>, String> {
    match lms_entry(vault, space, connection)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

pub fn lms_set(vault: &str, space: &str, connection: &str, secret: &str) -> Result<(), String> {
    lms_entry(vault, space, connection)?
        .set_password(secret)
        .map_err(|e| format!("could not save to the keychain: {e}"))
}

pub fn lms_clear(vault: &str, space: &str, connection: &str) -> Result<(), String> {
    match lms_entry(vault, space, connection)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the sign-in from the keychain: {e}")),
    }
}

// Since course sites belong to the vault, a connection's session is one entry
// per vault (`<vault>/lms/<id>`); the per-space entries above are only read
// once more, to move them here (lms/migrate.rs).

pub fn lms_vault_account(vault: &str, connection: &str) -> Result<String, String> {
    let plain = !connection.is_empty() && connection.len() <= 100 && connection.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain || vault.is_empty() || vault.contains('/') {
        return Err("That isn’t a course site connection Phaethon knows.".into());
    }
    Ok(format!("{vault}/lms/{connection}"))
}

fn lms_vault_entry(vault: &str, connection: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &lms_vault_account(vault, connection)?).map_err(|e| format!("keychain unavailable: {e}"))
}

pub fn lms_vault_get(vault: &str, connection: &str) -> Result<Option<String>, String> {
    match lms_vault_entry(vault, connection)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

pub fn lms_vault_set(vault: &str, connection: &str, secret: &str) -> Result<(), String> {
    lms_vault_entry(vault, connection)?
        .set_password(secret)
        .map_err(|e| format!("could not save to the keychain: {e}"))
}

pub fn lms_vault_clear(vault: &str, connection: &str) -> Result<(), String> {
    match lms_vault_entry(vault, connection)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the sign-in from the keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_course_site_sessions_have_their_own_namespace() {
        assert_eq!(lms_vault_account("default", "canvas-iu-instructure-com").unwrap(), "default/lms/canvas-iu-instructure-com");
        assert_ne!(lms_vault_account("default", "x").unwrap(), lms_vault_account("other", "x").unwrap());
        // Never a space's entry or a provider key.
        let a = lms_vault_account("default", "x").unwrap();
        assert!(!a.contains("/space/") && !a.contains("/provider/"));
        for bad in ["../x", "a/b", "", "x y", "space/school/lms/x"] {
            assert!(lms_vault_account("default", bad).is_err(), "{bad}");
        }
        assert!(lms_vault_account("", "x").is_err());
        assert!(lms_vault_account("a/b", "x").is_err());
    }

    #[test]
    fn course_site_sessions_are_namespaced_by_vault_and_space() {
        assert_eq!(
            lms_account("default", "school", "canvas-iu-instructure-com").unwrap(),
            "default/space/school/lms/canvas-iu-instructure-com"
        );
        assert_ne!(lms_account("default", "school", "x").unwrap(), lms_account("default", "work", "x").unwrap());
        assert_ne!(lms_account("default", "school", "x").unwrap(), lms_account("other", "school", "x").unwrap());
        // Never the provider keys' namespace, never a way into another space's.
        assert!(!lms_account("default", "school", "x").unwrap().contains("/provider/"));
        for bad in ["../work", "a/b", "", "x y", "work/lms/x"] {
            assert!(lms_account("default", bad, "x").is_err(), "{bad}");
            assert!(lms_account("default", "school", bad).is_err(), "{bad}");
        }
        assert!(lms_account("", "school", "x").is_err());
    }
}
