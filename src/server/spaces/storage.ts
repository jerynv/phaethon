/**
 * Every storage module that registers commands or startup tasks, in one import
 * for `src/server/commands.ts`. The startup tasks come first: they move old
 * folders into place and make the vault skeleton before anything reads it.
 */
import "../identity/startup.ts";
import "../settings/commands.ts";
import "./commands.ts";
import "../threads/commands.ts";
import "../memory/commands.ts";
import "../search/commands.ts";
import "../grants/commands.ts";
import "../fullaccess/commands.ts";
import "../workspace/commands.ts";
import "../files/commands.ts";
import "./model-commands.ts";
