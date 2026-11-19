import { scrypt, timingSafeEqual } from "node:crypto";
import { telemetrySignatureMessage, type TelemetryEnvelope } from "../../src/shared/telemetry.ts";

const encoder = new TextEncoder();
export function base64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}
export async function sha256(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("hex");
}
export function randomToken(): string { return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export async function verifyEnvelope(e: TelemetryEnvelope): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", Buffer.from(e.publicKey, "base64"), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, Buffer.from(e.signature, "base64"), encoder.encode(telemetrySignatureMessage(e)));
  } catch { return false; }
}

// OWASP scrypt option N=2^15, r=8, p=3 (~32 MiB). Uses maintained runtime implementation.
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
let passwordQueue: Promise<unknown> = Promise.resolve();
let passwordQueueSize = 0;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  // A Worker isolate shares its 128 MiB budget across concurrent requests. Keep
  // one memory-hard derivation active and bound the queue, including dummy work.
  if (passwordQueueSize >= 4) return Promise.reject(new Error("Password verification busy"));
  passwordQueueSize++;
  const result = passwordQueue.then(() => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key))));
  passwordQueue = result.catch(() => undefined);
  return result.finally(() => { passwordQueueSize--; });
}
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 14 || password.length > 256) throw new TypeError("Password must contain 14–256 characters");
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return `scrypt$32768$8$3$${base64(salt)}$${base64(await derive(password, salt))}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (password.length > 256) return false;
  const match = /^scrypt\$32768\$8\$3\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/.exec(hash);
  if (!match) throw new Error("Invalid provisioned password hash");
  return timingSafeEqual(await derive(password, Buffer.from(match[1], "base64")), Buffer.from(match[2], "base64"));
}
// Same expensive work for an unknown account. This is not a provisioned password.
export const DUMMY_PASSWORD_HASH = `scrypt$32768$8$3$${base64(new Uint8Array(16))}$${base64(new Uint8Array(32))}`;

export interface ArchiveReceipt { v: 1; id: string; receivedAt: string; envelopeHash: string; keyId: string; mac: string }
function receiptMessage(r: Omit<ArchiveReceipt, "mac">): Uint8Array<ArrayBuffer> {
  return encoder.encode(`phaethon.archive.v1\n${r.id}\n${r.receivedAt}\n${r.envelopeHash}\n${r.keyId}`);
}
export async function makeReceipt(secret: string, id: string, receivedAt: string, envelopeHash: string): Promise<ArchiveReceipt> {
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length < 32) throw new Error("Archive receipt key missing");
  const keyId = (await sha256(secret)).slice(0, 16);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = base64(await crypto.subtle.sign("HMAC", key, receiptMessage({ v: 1, id, receivedAt, envelopeHash, keyId })));
  return { v: 1, id, receivedAt, envelopeHash, keyId, mac };
}
export async function verifyReceipt(receipt: unknown, current: string, previous?: string): Promise<boolean> {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const r = receipt as ArchiveReceipt;
  if (Object.keys(r).sort().join(",") !== "envelopeHash,id,keyId,mac,receivedAt,v" || r.v !== 1
    || typeof r.id !== "string" || typeof r.receivedAt !== "string" || typeof r.envelopeHash !== "string"
    || !/^[0-9a-f]{64}$/.test(r.envelopeHash) || typeof r.keyId !== "string" || !/^[0-9a-f]{16}$/.test(r.keyId)
    || typeof r.mac !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(r.mac)) return false;
  const old: unknown = previous ? JSON.parse(previous) : [];
  if (!Array.isArray(old) || old.length > 10 || old.some(key => typeof key !== "string")) throw new Error("Invalid receipt keyring");
  for (const secret of [current, ...old] as string[]) {
    if ((await sha256(secret)).slice(0, 16) !== r.keyId) continue;
    const bytes = Buffer.from(secret, "base64");
    if (bytes.length < 32) throw new Error("Invalid receipt key");
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, Buffer.from(r.mac, "base64"), receiptMessage(r));
  }
  return false;
}
