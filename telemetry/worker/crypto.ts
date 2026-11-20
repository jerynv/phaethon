import { scrypt, timingSafeEqual } from "node:crypto";
import { telemetrySignatureMessage, type TelemetryEnvelope } from "../../src/shared/telemetry.ts";

const encoder = new TextEncoder();

export const MIN_PASSWORD_LENGTH = 14;
export const MAX_PASSWORD_LENGTH = 256;

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(view).toString("base64");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Buffer.from(digest).toString("hex");
}

/** 32 random bytes as unpadded base64url: 43 characters. */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export async function verifyEnvelope(e: TelemetryEnvelope): Promise<boolean> {
  try {
    const publicKey = Buffer.from(e.publicKey, "base64");
    const key = await crypto.subtle.importKey("spki", publicKey, "Ed25519", false, ["verify"]);
    const message = encoder.encode(telemetrySignatureMessage(e));
    return await crypto.subtle.verify("Ed25519", key, Buffer.from(e.signature, "base64"), message);
  } catch {
    return false;
  }
}

// OWASP's scrypt profile: N=2^15, r=8, p=3, about 32 MiB per derivation.
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const HASH_PREFIX = "scrypt$32768$8$3$";
const HASH_FORMAT = /^scrypt\$32768\$8\$3\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/;
const MAX_QUEUED_DERIVATIONS = 4;

// A Worker isolate shares its 128 MiB budget across concurrent requests, so only one
// memory-hard derivation runs at a time and the queue, dummy work included, is bounded.
let derivations: Promise<unknown> = Promise.resolve();
let queuedDerivations = 0;

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (queuedDerivations >= MAX_QUEUED_DERIVATIONS) {
    return Promise.reject(new Error("Password verification busy"));
  }
  queuedDerivations++;
  const result = derivations.then(() => scryptKey(password, salt));
  derivations = result.catch(() => undefined);
  return result.finally(() => {
    queuedDerivations--;
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new TypeError("Password must contain 14–256 characters");
  }
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const key = await derive(password, salt);
  return `${HASH_PREFIX}${base64(salt)}$${base64(key)}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const match = HASH_FORMAT.exec(hash);
  if (!match) throw new Error("Invalid provisioned password hash");
  const key = await derive(password, Buffer.from(match[1], "base64"));
  return timingSafeEqual(key, Buffer.from(match[2], "base64"));
}

const ZERO_SALT = base64(new Uint8Array(16));
const ZERO_KEY = base64(new Uint8Array(32));

/** Well-formed but matches no password; verifying against it costs the same as a real account. */
export const DUMMY_PASSWORD_HASH = `${HASH_PREFIX}${ZERO_SALT}$${ZERO_KEY}`;

export interface ArchiveReceipt {
  v: 1;
  id: string;
  receivedAt: string;
  envelopeHash: string;
  keyId: string;
  mac: string;
}

const RECEIPT_KEYS = "envelopeHash,id,keyId,mac,receivedAt,v";

function receiptMessage(r: Omit<ArchiveReceipt, "mac">): Uint8Array<ArrayBuffer> {
  return encoder.encode(`phaethon.archive.v1\n${r.id}\n${r.receivedAt}\n${r.envelopeHash}\n${r.keyId}`);
}

async function receiptKeyId(secret: string): Promise<string> {
  return (await sha256(secret)).slice(0, 16);
}

async function receiptKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length < 32) throw new Error("Invalid archive receipt key");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function isReceipt(value: unknown): value is ArchiveReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).sort().join(",") === RECEIPT_KEYS &&
    r.v === 1 &&
    typeof r.id === "string" &&
    typeof r.receivedAt === "string" &&
    typeof r.envelopeHash === "string" &&
    /^[0-9a-f]{64}$/.test(r.envelopeHash) &&
    typeof r.keyId === "string" &&
    /^[0-9a-f]{16}$/.test(r.keyId) &&
    typeof r.mac === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(r.mac)
  );
}

export async function makeReceipt(
  secret: string,
  id: string,
  receivedAt: string,
  envelopeHash: string,
): Promise<ArchiveReceipt> {
  const key = await receiptKey(secret, "sign");
  const keyId = await receiptKeyId(secret);
  const message = receiptMessage({ v: 1, id, receivedAt, envelopeHash, keyId });
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return { v: 1, id, receivedAt, envelopeHash, keyId, mac: base64(signature) };
}

/** `previous` is a JSON array of retired keys, kept until every receipt they signed has expired. */
export async function verifyReceipt(receipt: unknown, current: string, previous?: string): Promise<boolean> {
  if (!isReceipt(receipt)) return false;
  const retired: unknown = previous ? JSON.parse(previous) : [];
  if (!Array.isArray(retired) || retired.length > 10 || retired.some(key => typeof key !== "string")) {
    throw new Error("Invalid receipt keyring");
  }
  for (const secret of [current, ...(retired as string[])]) {
    if ((await receiptKeyId(secret)) !== receipt.keyId) continue;
    const key = await receiptKey(secret, "verify");
    return crypto.subtle.verify("HMAC", key, Buffer.from(receipt.mac, "base64"), receiptMessage(receipt));
  }
  return false;
}
