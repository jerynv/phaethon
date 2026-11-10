import { onStart } from "../lifecycle.ts";
import { ensureVault } from "../core/vault.ts";
import { migrateApp, migrateLegacyRoot } from "./identity.ts";

/**
 * The storage half of the Rust setup, in its order: app folders move from the
 * old identifier, `~/Steward` becomes `~/Phaethon`, then the vault skeleton is
 * made. Later modules' startup tasks (LMS migration, CLI import) read the vault,
 * so this file is imported first.
 */
onStart("app identifier migration", () => migrateApp());
onStart("~/Steward migration", () => migrateLegacyRoot());
onStart("vault skeleton", () => ensureVault());
