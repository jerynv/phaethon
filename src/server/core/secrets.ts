import { createRequire } from "node:module";
import { Refusal } from "../rpc/registry.ts";
import { byteLength } from "./fsx.ts";
import { vaultName } from "./vault.ts";
import { ChunkedSecretStore, type SecretStore } from "./chunked-secrets.ts";

/**
 * The OS keychain, under the same service and account names the Rust core used
 * (`@napi-rs/keyring` binds the same `keyring` crate), so saved keys and course
 * sign-ins are read as they are. Keys never go to the renderer, the vault, a
 * log or an error message. `PHAETHON_KEYRING=memory` swaps in an in-memory
 * store for tests.
 */

export const SERVICE = "phaethon";
const LEGACY_SERVICE = "steward";

type Store = SecretStore;

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

class KeyringStore implements Store {
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

let store: Store | undefined;
function backend(): Store {
  if (!store) {
    const native = process.env.PHAETHON_KEYRING === "memory" ? new MemoryStore() : new KeyringStore();
    store = process.platform === "win32" ? new ChunkedSecretStore(native) : native;
  }
  return store;
}

/** Tests: start each case with an empty in-memory keychain. */
export function resetMemoryKeychain(): void {
  const memory = new MemoryStore();
  store = process.platform === "win32" ? new ChunkedSecretStore(memory) : memory;
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
