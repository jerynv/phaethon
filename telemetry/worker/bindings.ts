// Narrow structural binding types keep this backend independent of generated global types.
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export interface Bucket {
  put(key: string, value: string, options?: { onlyIf?: Headers; httpMetadata?: { contentType: string } }): Promise<unknown | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number }): Promise<{ objects: Array<{ key: string }> }>;
}
export interface Env {
  DB: Database;
  RAW: Bucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Canonical console origin, without path/trailing slash. Mandatory outside localhost. */
  CONSOLE_ORIGIN: string;
  /** At least 32 random bytes, base64. No hardcoded/default production secret. */
  ARCHIVE_RECEIPT_KEY: string;
  /** JSON array of previous base64 keys; keep until all receipts signed by them expire. */
  ARCHIVE_RECEIPT_PREVIOUS_KEYS?: string;
  SESSION_TTL_SECONDS?: string;
  CONTENT_RETENTION_DAYS?: string;
  METADATA_RETENTION_DAYS?: string;
}
