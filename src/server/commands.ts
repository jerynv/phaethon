/**
 * Loads every module that registers commands or lifecycle tasks. Each line is
 * owned by the module it imports; keep them in this order (storage first, since
 * later modules' startup tasks read the vault).
 */
import "./spaces/storage.ts";
import "./system/commands.ts";
import "./latex/commands.ts";
import "./voice/commands.ts";
import "./diagnostics/commands.ts";
import "./updater/commands.ts";
import "./study/commands.ts";
import "./agent/commands.ts";
import "./cli/commands.ts";
import "./lms/commands.ts";
