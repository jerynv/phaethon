import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Refusal } from "../rpc/registry.ts";
import { byteLength } from "./fsx.ts";
import { vaultName } from "./vault.ts";

/**
 * The OS keychain, under the same service and account names the Rust core used
 * (`@napi-rs/keyring` binds the same `keyring` crate), so saved keys and course
 * sign-ins are read as they are. Keys never go to the renderer, the vault, a
 * log or an error message. `PHAETHON_KEYRING=memory` swaps in an in-memory
 * store for tests.
 *
 * On macOS entries go through `/usr/bin/security` instead (see SecurityToolStore).
 */

export const SERVICE = "phaethon";
const LEGACY_SERVICE = "steward";

export interface Store {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

class MemoryStore implements Store {
  readonly entries = new Map<string, string>();
  get(service: string, account: string) {
    return this.entries.get(`${service}\0${account}`) ?? null;
  }
  set(service: string, account: string, value: string) {
    this.entries.set(`${service}\0${account}`, value);
  }
  delete(service: string, account: string) {
    return this.entries.delete(`${service}\0${account}`);
  }
}

export class KeyringStore implements Store {
  #Entry: typeof import("@napi-rs/keyring").Entry | undefined;
  private entry(service: string, account: string) {
    if (!this.#Entry) {
      try {
        // Loaded on first use so a machine without a keychain still starts.
        this.#Entry = (createRequire(import.meta.url)("@napi-rs/keyring") as typeof import("@napi-rs/keyring")).Entry;
      } catch (e) {
        throw new Refusal(`keychain unavailable: ${(e as Error).message}`);
      }
    }
    return new this.#Entry(service, account);
  }
  get(service: string, account: string) {
    return this.entry(service, account).getPassword();
  }
  set(service: string, account: string, value: string) {
    this.entry(service, account).setPassword(value);
  }
  delete(service: string, account: string) {
    return this.entry(service, account).deletePassword();
  }
}

/** Marks an entry this store wrote, so it is read without asking. */
const MARK = "phaethon:security";
/** `errSecItemNotFound`, as the `security` tool's exit status. */
const NOT_FOUND = 44;

export type SecurityRun = (args: string[]) => { status: number; stdout: string; stderr: string };

const runSecurity: SecurityRun = (args) => {
  // Long timeout: a locked keychain makes macOS ask for the password first.
  const r = spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 120_000 });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

/**
 * macOS checks a keychain entry's access list against the code signature of
 * the program reading it. Phaethon's builds are signed ad hoc, so every build
 * has a new signature and macOS asked for the login password on each read and
 * each write after every update. Entries written by Apple's own `security`
 * tool list that tool, whose signature never changes, so later builds read
 * them without asking. The cost: any program running as this user can read
 * them the same way, as with `gh` and other command-line tools. A Developer ID
 * signature would let Phaethon keep entries to itself again.
 *
 * Entries an earlier build wrote through the keychain API are read through it
 * once (macOS asks one last time, naming Phaethon) and rewritten here.
 */
export class SecurityToolStore implements Store {
  constructor(
    private readonly run: SecurityRun = runSecurity,
    private readonly legacy: Store = new KeyringStore(),
  ) {}

  get(service: string, account: string): string | null {
    const attributes = this.run(["find-generic-password", "-s", service, "-a", account]);
    if (attributes.status === NOT_FOUND) return null;
    check(attributes);
    if (!attributes.stdout.includes(`"icmt"<blob>="${MARK}"`)) return this.adopt(service, account);
    const r = this.run(["find-generic-password", "-s", service, "-a", account, "-g"]);
    check(r);
    return parsePassword(r.stderr);
  }

  set(service: string, account: string, value: string): void {
    // Delete first: updating keeps the old entry's access list.
    this.delete(service, account);
    // Hex keeps any byte intact. Arguments are visible only to this user's programs, which can read the entry anyway.
    check(this.run(["add-generic-password", "-s", service, "-a", account, "-j", MARK, "-X", Buffer.from(value, "utf8").toString("hex")]));
  }

  delete(service: string, account: string): boolean {
    const r = this.run(["delete-generic-password", "-s", service, "-a", account]);
    if (r.status === NOT_FOUND) return false;
    check(r);
    return true;
  }

  private adopt(service: string, account: string): string | null {
    const value = this.legacy.get(service, account);
    if (value === null) return null;
    try {
      this.set(service, account, value);
    } catch {
      // Still readable through the keychain API; the next read tries again.
    }
    return value;
  }
}

function check(r: { status: number; stderr: string }): void {
  if (r.status !== 0) throw new Error(r.stderr.trim().replace(/^security: (\S+: )?/, "") || `security exited with ${r.status}`);
}

/** The secret from `security find-generic-password -g`: `password: 0x<hex>  "…"` when any byte isn't plain printable ASCII (a backslash counts), else `password: "…"` unescaped. */
export function parsePassword(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.startsWith("password:"));
  if (line === undefined) throw new Error("the keychain returned no password");
  const hex = /^password: 0x([0-9A-Fa-f]*)/.exec(line);
  if (hex) return Buffer.from(hex[1]!, "hex").toString("utf8");
  const start = line.indexOf('"');
  return start === -1 ? "" : line.slice(start + 1, line.lastIndexOf('"'));
}

let store: Store | undefined;
function backend(): Store {
  store ??= process.env.PHAETHON_KEYRING === "memory" ? new MemoryStore() : process.platform === "darwin" ? new SecurityToolStore() : new KeyringStore();
  return store;
}

/** Tests: start each case with an empty in-memory keychain. */
export function resetMemoryKeychain(): void {
  store = new MemoryStore();
}

/** Reads an entry, moving a legacy `steward` entry over to `phaethon` the first time. */
export function keychainGet(account: string): string | null {
  try {
    const value = backend().get(SERVICE, account);
    if (value !== null) return value;
    const legacy = backend().get(LEGACY_SERVICE, account);
    if (legacy === null) return null;
    backend().set(SERVICE, account, legacy);
    try {
      backend().delete(LEGACY_SERVICE, account);
    } catch {
      // The copy is saved; a leftover legacy entry is harmless.
    }
    return legacy;
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`could not read the keychain: ${(e as Error).message}`);
  }
}

export function keychainSet(account: string, value: string, failure = "could not save to the keychain"): void {
  try {
    backend().set(SERVICE, account, value);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`${failure}: ${(e as Error).message}`);
  }
}

export function keychainDelete(account: string, failure = "could not remove the key from the keychain"): void {
  try {
    backend().delete(SERVICE, account);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`${failure}: ${(e as Error).message}`);
  }
}

/** `{vault}/provider/{id}`. The caller checks the provider id is known. */
export function providerAccount(providerId: string): string {
  return `${vaultName()}/provider/${providerId}`;
}

/** Validates and normalizes an API key before saving. */
export function checkApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || byteLength(trimmed) > 512 || /\s/.test(trimmed)) throw new Refusal("That does not look like an API key.");
  return trimmed;
}

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UNKNOWN_CONNECTION = "That isn’t a course site connection Phaethon knows.";

/** `{vault}/lms/{connectionId}`: a vault's course-site sign-in. */
export function lmsVaultAccount(connectionId: string): string {
  const vault = vaultName();
  if (!CONNECTION_ID.test(connectionId) || !vault || vault.includes("/")) throw new Refusal(UNKNOWN_CONNECTION);
  return `${vault}/lms/${connectionId}`;
}

/** `{vault}/space/{spaceId}/lms/{connectionId}`: the old per-space family, read only by the migration. */
export function lmsLegacySpaceAccount(spaceId: string, connectionId: string): string {
  const vault = vaultName();
  if (!CONNECTION_ID.test(spaceId) || !CONNECTION_ID.test(connectionId) || !vault || vault.includes("/")) throw new Refusal(UNKNOWN_CONNECTION);
  return `${vault}/space/${spaceId}/lms/${connectionId}`;
}
