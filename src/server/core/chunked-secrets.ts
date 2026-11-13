import { createHash, randomBytes } from "node:crypto";

export interface SecretStore {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

const PREFIX = "phaethon:chunked-secret:v1:";
// Stay below even the older 2560-byte CredentialBlob limit with UTF-16 data.
export const CHUNK_UNITS = 1000;
const MAX_CHUNKS = 1024;
type Manifest = { id: string; count: number; hash: string };

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const chunkAccount = (account: string, id: string, index: number) => `${account}/chunk/${id}/${index}`;

function manifest(value: string | null): Manifest | null {
  if (!value?.startsWith(PREFIX)) return null;
  try {
    const m = JSON.parse(value.slice(PREFIX.length)) as Manifest;
    if (/^[0-9a-f]{32}$/.test(m.id) && Number.isInteger(m.count) && m.count > 0 && m.count <= MAX_CHUNKS && /^[0-9a-f]{64}$/.test(m.hash)) return m;
  } catch {
    // A damaged manifest must never be used as a credential.
  }
  throw new Error("The saved sign-in is incomplete. Sign in again.");
}

/** Large Windows credentials stay in Credential Manager, never in plain files. */
export class ChunkedSecretStore implements SecretStore {
  constructor(private readonly store: SecretStore) {}

  get(service: string, account: string): string | null {
    const raw = this.store.get(service, account);
    const m = manifest(raw);
    if (!m) return raw;
    const parts: string[] = [];
    for (let i = 0; i < m.count; i++) {
      const part = this.store.get(service, chunkAccount(account, m.id, i));
      if (part === null) throw new Error("The saved sign-in is incomplete. Sign in again.");
      parts.push(part);
    }
    const value = parts.join("");
    if (digest(value) !== m.hash) throw new Error("The saved sign-in is incomplete. Sign in again.");
    return value;
  }

  set(service: string, account: string, value: string): void {
    const oldRaw = this.store.get(service, account);
    // Allow a fresh sign-in to repair a damaged manifest, too.
    let old: Manifest | null = null;
    try { old = manifest(oldRaw); } catch { /* no reliable chunk names */ }
    if (value.length <= CHUNK_UNITS && !value.startsWith(PREFIX)) {
      this.store.set(service, account, value);
    } else {
      const parts: string[] = [];
      for (let start = 0; start < value.length;) {
        let end = Math.min(start + CHUNK_UNITS, value.length);
        // Do not split a surrogate pair across entries: keyring encodes UTF-16.
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
        parts.push(value.slice(start, end));
        start = end;
      }
      if (parts.length > MAX_CHUNKS) throw new Error("This sign-in is too large to save.");
      const next = { id: randomBytes(16).toString("hex"), count: parts.length, hash: digest(value) };
      try {
        for (let i = 0; i < parts.length; i++) this.store.set(service, chunkAccount(account, next.id, i), parts[i]!);
        // Commit last. Until this succeeds, the previous credential stays readable.
        this.store.set(service, account, PREFIX + JSON.stringify(next));
      } catch (e) {
        this.cleanup(service, account, next);
        throw e;
      }
    }
    this.cleanup(service, account, old);
  }

  delete(service: string, account: string): boolean {
    let old: Manifest | null = null;
    try { old = manifest(this.store.get(service, account)); } catch { /* still remove the primary entry */ }
    const deleted = this.store.delete(service, account);
    this.cleanup(service, account, old);
    return deleted;
  }

  private cleanup(service: string, account: string, m: Manifest | null): void {
    if (!m) return;
    for (let i = 0; i < m.count; i++) {
      try { this.store.delete(service, chunkAccount(account, m.id, i)); } catch { /* best effort after commit */ }
    }
  }
}
