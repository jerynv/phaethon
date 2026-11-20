# Phaethon telemetry backend

The app, private staff console, and Cloudflare collector are implemented together.
The initial hostname is `telemetry.phaethon.app`. Onboarding and Privacy settings
control collection. See [the implementation overview](../docs/TELEMETRY.md) for
the app's data boundaries and release configuration.

The TypeScript Worker uses D1 for indexed metadata, staff credentials, opaque sessions, replay reservations, and a temporary durable archive outbox. R2 holds private raw JSON envelopes and server receipts. There are no additional runtime packages: validation is plain TypeScript, and cryptography uses maintained Web Crypto and `node:crypto` implementations. The assets binding serves the parent's `telemetry/console/dist` for non-API paths. Every API response disables caching; missing or invalid staff sessions always receive `401`, including when an ingestion bearer credential is presented. Public ingestion has no administrative capability.

## Local setup without Cloudflare credentials

Use the repository's pnpm installation and Node 22.13+ or 24. Wrangler is pinned to `4.165.0` in the operational scripts. These commands run entirely locally. Generate configuration and private secrets outside the checkout; the generator refuses to overwrite files or put secrets in the repository.

```sh
pnpm install --frozen-lockfile
pnpm exec tsx telemetry/scripts/dev-config.ts /tmp/phaethon-telemetry-local
pnpm dlx wrangler@4.165.0 d1 migrations apply DB --local \
  --config /tmp/phaethon-telemetry-local/wrangler.json \
  --persist-to /tmp/phaethon-telemetry-local/state
pnpm exec tsx telemetry/scripts/staff.ts provision \
  --email staff@example.test --username staff --role owner \
  --config /tmp/phaethon-telemetry-local/wrangler.json \
  --persist-to /tmp/phaethon-telemetry-local/state
pnpm dlx wrangler@4.165.0 dev \
  --config /tmp/phaethon-telemetry-local/wrangler.json \
  --persist-to /tmp/phaethon-telemetry-local/state --test-scheduled
```

Provisioning prompts for a hidden password, 14–256 characters. It also accepts one password line through secure stdin from a secret manager; never put a password in a command argument, shell history, task output, or sample file. There are no built-in accounts, passwords, signup routes, or account recovery routes. The generated receipt key is random, stored in a mode-0600 `.dev.vars`, and never printed. Configuration and local state live in the specified private directory. The generated assets are a minimal backend placeholder; to test the real console, build the parent's console and change the generated config's asset directory to its absolute `telemetry/console/dist` path.

The local origin defaults to `http://localhost:8787`. Cookies always carry `Secure`, including local development. Use a browser that treats localhost as a trustworthy origin, or set the generated `CONSOLE_ORIGIN` to `https://localhost:8787` and start Wrangler with `--local-protocol https`, trusting its local certificate. Mutation `Origin` must exactly match `CONSOLE_ORIGIN`, without a trailing slash. The smoke script exercises HTTP cookies as an API client and does not simulate browser cookie policy.

`--test-scheduled` exposes Wrangler's local `/__scheduled` test hook; it is not an application route or deployed maintenance API.

## Staff access and operations

After the first super admin signs in, the **Staff** page manages accounts without
CLI access: add an account, change its email or username, choose **Super admin**
or **Viewer**, reset its password, disable/re-enable sign-in, or sign out all of
its sessions. Super admins are stored as role `owner`; viewers can read telemetry
but every staff-management endpoint rejects them. Account changes revoke the
affected account's sessions. A conditional database write prevents disabling or
demoting the last active super admin, including concurrent changes. Recent
changes are recorded in a transactional access audit without credentials.

The CLI's `--role owner` bootstraps the first super admin. New accounts default
to `viewer`; omitting the role when reprovisioning preserves an existing role.
There is no public bootstrap endpoint or email-based automatic elevation.

Staff can sign in with their provisioned email or username; the JSON field is named `email` in either case. Password hashes are salted scrypt with `N=32768`, `r=8`, `p=3`, 32-byte output, a 16-byte random salt, and 48 MiB maximum allocation. This is an [OWASP scrypt configuration](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); [Workers supports `node:crypto` scrypt](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/). A bounded isolate-local queue permits only one memory-hard password derivation at a time. Unknown accounts perform equivalent dummy password work and receive the same failure as wrong passwords or disabled accounts. Login is limited globally to 120 attempts per 15 minutes, per IP to 20, and per submitted email/username to 10. A saturated derivation queue returns generic `503` rather than exceeding the isolate's memory budget.

Successful login creates a random 256-bit opaque token. Only its SHA-256 hash is saved in D1. The host-only `__Host-phaethon_session` cookie has `Path=/; HttpOnly; Secure; SameSite=Strict`, and both browser/server expiry default to eight hours. `SESSION_TTL_SECONDS` accepts 60–86400. Re-login rotates the presented session; logout deletes it. Login/logout require the exact configured same origin, matching request origin, and a non-cross-site Fetch Metadata header when present. There is no permissive CORS response.

Provisioning an existing email replaces its password and username and revokes all its sessions atomically by rotating `auth_version`. The same CLI supports `revoke` (all sessions, account remains enabled) and `disable` (all sessions and subsequent login). These actions use the same email/config/state options as provisioning and do not ask for a password:

```sh
pnpm exec tsx telemetry/scripts/staff.ts revoke --email staff@example.test \
  --config /tmp/phaethon-telemetry-local/wrangler.json \
  --persist-to /tmp/phaethon-telemetry-local/state
pnpm exec tsx telemetry/scripts/staff.ts disable --email staff@example.test \
  --config /tmp/phaethon-telemetry-local/wrangler.json \
  --persist-to /tmp/phaethon-telemetry-local/state
```

The CLI defaults to `--local`. Remote writes require the explicit `--remote` flag, reject simultaneous local flags/state, and require the operator's Cloudflare authorization. The password never enters Wrangler argv: the CLI hashes it first, writes only the hash and account metadata to a temporary mode-0600 SQL file in a private directory, executes that file, and removes it. It prints no secrets. A separate read confirms the fresh account version because remote D1 imports return progress and summary metadata rather than SQL result rows. Both API and CLI writes preserve an active super admin.

For an authorized remote staff update after replacing the actual configuration values, use `pnpm exec tsx telemetry/scripts/staff.ts provision --email <real-email> --username <real-username> --remote`; the same hidden prompt/secure stdin applies. `revoke` and `disable` also require `--remote` to affect the remote database. Without an explicit local `--persist-to`, provisioning uses `.wrangler/state` next to the selected config.

## Wire contract and privacy

The exact allow-listed envelope is `{v:1,id:UUID,sentAt:ISO,publicKey:base64 DER SPKI Ed25519,payload:string,signature:base64}`. UUIDs use canonical lowercase spelling. Timestamps are valid UTC ISO timestamps with zero to three fractional digits. The signature covers the UTF-8 bytes of:

```text
phaethon.telemetry.v1\n${id}\n${sentAt}\n${payload}
```

The `\n` notation represents literal newline characters, with no trailing newline. Fresh ingestion accepts timestamps at most 24 hours old or five minutes ahead. Retained archive reads verify the signature without reapplying ingestion freshness. `src/shared/telemetry.ts` exports wire types, bounds, categories, payload/envelope parsers, and `telemetrySignatureMessage`; `parseStoredTelemetryEnvelope` is expressly for retained records and must not replace the fresh ingestion parser.

Clients generate an ephemeral Ed25519 key pair for **each envelope**, discard the private key, and use an event UUID only for that envelope/retries. The backend does not create or index any installation/user identifier. A self-signed signature provides integrity, **not app attestation or proof that the event is true**. Public clients can synthesize events. Ingestion has D1-backed atomic per-minute limits of 60 per transport IP and 2000 globally. Only keyed SHA-256 digests scoped to the time window are saved for IP/account rate buckets, and the ten-minute cron removes expired counters. No raw transport IP, HTTP headers, auth cookies, account identifier, URL/query field, preferences, or arbitrary attributes are copied into telemetry storage or archives. Cloudflare's own infrastructure-level processing is separate from application storage; Worker observability is disabled by default.

Payloads strictly allow only `category,event,appVersion,platform,data`, with unknown keys rejected at every structured level:

| Category | Event | Allowed data |
| --- | --- | --- |
| usage | `app_opened`, `view_opened`, `action_completed` | Optional `view`: chat/files/study/grades/plan/courses/settings; optional `action`: chat_sent/space_created/file_opened/search_used/study_started; optional integer `count`: 0–10000 |
| diagnostics | `turn_completed` | `backend`: phaethon/claude-cli/codex-cli/gemini-cli; `outcome`: completed/failed/cancelled; integer `durationMs`: 0–86400000; integer `steps`: 0–10000 |
| reports | `testing_report` | `text`: 1–4000 characters |
| traces | `chat_trace` | `backend` as above; 1–20 `messages`, each with role user/assistant and text of at most 8000 characters |

`appVersion` is 1–64 letters/digits/dots/plus/underscore/hyphen characters, beginning with a letter/digit. `platform` is darwin/win32/linux/other. Raw errors and custom model names are rejected. Payload JSON has a 192 KiB byte cap and the whole request a 256 KiB byte cap, enforced incrementally even without Content-Length. JSON must be valid UTF-8 with an application/json content type. Combined escaped message content must fit these byte caps even when each individual string meets its character bound.

**Reports and traces can contain personal content.** The client applies local best-effort redaction before signing, but this does not make them fully anonymous, and server-side schema validation cannot reliably detect sensitive prose. Each category must be enabled before the app collects anything for it. Preferences are saved separately by the app and never sent in envelopes.

## API responses

Every staff endpoint requires the session cookie. Unauthorized calls return `401 {"error":"Unauthorized"}` with no data. Failures otherwise use a generic `{error:string}`; malformed input is 400, wrong media type 415, oversized bodies 413, cross-origin mutations 403, rate limits 429, and storage/integrity failures 503. Rate/storage failures include `Retry-After`. No ingest credential can read staff data.

| Endpoint | Response |
| --- | --- |
| `POST /api/ingest` | Fresh valid envelope: `201 {id,receipt}` after R2 confirmation; already archived identical retry: `200` with the same receipt. Failed archive writes return 503 and preserve the outbox. Conflicting content for an existing UUID returns 409; an expired event's surviving tombstone returns 410. |
| `POST /api/login` | `{email,password}`; success `{email:string,role:'owner'\|'viewer'}` and session cookie |
| `GET /api/session` | `{email:string,role:'owner'\|'viewer'}` |
| `POST /api/logout` | `{ok:true}` and expired cookie |
| `GET /api/staff` | Super admin only; `{items:[{id,email,username,role,disabled}]}` without hashes or session data |
| `POST /api/staff` | Super admin only, same origin; `{email,username,role,password}` creates an account |
| `PATCH /api/staff/:id` | Super admin only, same origin; `{email,username,role,disabled,password?}` changes access and revokes existing sessions |
| `POST /api/staff/:id/revoke` | Super admin only, same origin; signs out every session for the account |
| `GET /api/staff/audit` | Super admin only; recent `{items:[{id,actorEmail,targetEmail,action,createdAt}]}` |
| `GET /api/overview?days=7\|30\|90` | `{totals:{usage,diagnostics,reports,traces},days:[{day:'YYYY-MM-DD',count}],events:[{event,count}],outcomes:[{outcome,count}]}`; absent categories have zero totals; day rows contain days with retained events and outcome rows contain diagnostics only |
| `GET /api/events?days=7&category=usage&before=...` | `{items:[{id,category,event,receivedAt,sentAt,appVersion,platform}],nextCursor:string\|null}` |
| `GET /api/events/:id` | `{envelope,payload,receivedAt,verification:'self-signed'}` with parsed payload; header `X-Archive-Receipt` contains base64url JSON receipt |
| `GET /api/export?days=7&category=usage&before=...` | NDJSON records `{envelope,payload,receivedAt,verification:'self-signed',receipt}`; headers `X-Result-Count`, `X-Has-More`, and `X-Next-Cursor` when another page exists |

Events and exports both honor the selected period, using server receipt time, and accept integer `days` from 1–3650 (default 7); overview accepts only 7/30/90. Category is optional. Each page has at most 50 records, ordered by receipt timestamp then UUID, descending. `before` is the opaque base64url JSON tuple `[receivedAt,id]`; pass the returned cursor unchanged with the same period/category until no cursor remains. Ties do not skip rows. Export consumers **must follow every X-Next-Cursor** to retrieve the selected period; the first response is a page, not a complete dump. Exports also have a 4 MiB response cap, so large traces produce smaller pages; count and cursor headers reflect the actual returned records. A page fails before returning content if any returned record fails integrity checks. Concurrent new arrivals sort ahead of an existing cursor; pagination does not provide a cross-request database snapshot.

## Archive consistency and receipts

A D1 transactional batch reserves a unique UUID/hash and installs its outbox only for the reservation winner. Identical retries cannot overwrite content or recreate expired events. The outbox contains only the validated canonical envelope and the original server receipt. [D1 batches are transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/). R2 writes use atomic create-once `If-None-Match: *`; on a duplicate, the Worker checks the existing object exactly before marking the D1 row archived and clearing its outbox. [R2 conditional operations are strongly consistent](https://developers.cloudflare.com/r2/reference/consistency/). Pending events are never returned by console reads, totals, or exports. A lost acknowledgment or D1 failure after R2 success is repaired by identical retry or cron without changing the original receipt.

The archive is `{envelope,receipt}`. Envelope hashing is SHA-256 over UTF-8 JSON serialized in field order `v,id,sentAt,publicKey,payload,signature`, preserving the payload string exactly. Receipts contain `{v:1,id,receivedAt,envelopeHash,keyId,mac}`. `keyId` is the first 16 hex characters of SHA-256 of the configured base64 secret string. `mac` is base64 HMAC-SHA256 under the decoded receipt key over:

```text
phaethon.archive.v1\n${id}\n${receivedAt}\n${envelopeHash}\n${keyId}
```

Read/export verifies the client signature, actual envelope hash, UUID/receipt-time binding, HMAC, and agreement with the D1 row. Rewriting R2 and D1 together without the receipt key still fails closed. The receipt establishes possession of the server archive key at the reported receipt time; it is not public-key notarization, app attestation, or proof of content truth. An operator who controls the receipt key can mint receipts, and neither signatures nor receipts prove completeness against deliberate deletion.

`ARCHIVE_RECEIPT_KEY` must be at least 32 cryptographically random bytes encoded as base64, installed through Wrangler's secret prompt or secure stdin. For rotation, preserve old keys in secret `ARCHIVE_RECEIPT_PREVIOUS_KEYS`, a JSON array of at most ten previous base64 keys, until their last archives expire. Install the old keyring before switching the signing key. Dropping a needed key makes those records fail closed. Never place either secret in tracked config or command arguments.

## Retention and production configuration

Defaults retain reports/traces for **90 days** and usage/diagnostics for **365 days**, including their raw envelopes. `CONTENT_RETENTION_DAYS` and `METADATA_RETENTION_DAYS` accept integers 1–3650; there is no forever setting. Expiry is calculated at first acceptance. Configuration changes apply to newly accepted events; changing existing retention requires a deliberate data migration and matching lifecycle adjustment. Replay tombstones contain UUID/hash/reservation only and live at least two days, or until original event expiry, so a fresh retry cannot resurrect deleted content.

Read paths hide expired records immediately. The ten-minute cron tries R2 deletion for up to 100 expired rows, deletes up to 20000 expired D1 event/outbox rows even during R2 outages, retries up to 50 pending archives, and removes expired sessions, rate counters, and unused tombstones. R2 keys are `events/content/<expiry-ms>/<uuid>.json` or `events/metrics/<expiry-ms>/<uuid>.json`; sorted-expiry sweeps delete up to 100 oldest expired objects per prefix, including objects orphaned by interrupted writes. Backlogs and service outages can delay physical removal; read-time expiry still applies. Monitor cron health, storage growth, and D1 capacity. There are no immutable bucket locks: deletions must stay possible.

`wrangler.jsonc` identifies the deployed `phaethon-telemetry` database, private `phaethon-telemetry-raw` bucket, console origin, and domain route. R2 `r2.dev` access is disabled and no public bucket domain is attached. Staff receive console access rather than bucket credentials. `pnpm telemetry:deploy` builds and updates the Worker while retaining its installed secrets. For a different environment, configure its actual resources, apply migrations, install its own receipt key through secure input, and provision its first super admin explicitly. The configured CPU budget and memory-hard login plus export/cron subrequests require a suitable **Workers Paid** deployment; do not weaken hashing to fit the Free plan's CPU allowance. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The production receipt key is installed as a Worker secret and backed up in the
operator's system keychain under service `app.phaethon.telemetry`, account
`archive-receipt-v1`. It is separate from staff passwords and app-vault secrets.
Use secure stdin or a private temporary secrets file when restoring it; never
put its value in source, logs, or command arguments. A newly uploaded Worker can
briefly return 10007 from its metadata lookup before propagation completes; if
the version upload succeeded, verify that version and finish its routes with
`wrangler triggers deploy --config telemetry/wrangler.jsonc`.

Configure these matching [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) as a second deletion mechanism when provisioning is explicitly authorized:

| Prefix | Delete objects after upload age |
| --- | --- |
| `events/content/` | 90 days (match `CONTENT_RETENTION_DAYS`) |
| `events/metrics/` | 365 days (match `METADATA_RETENTION_DAYS`) |

R2 lifecycle runs asynchronously and usually removes expired objects within 24 hours. Delayed outbox upload starts its R2 age later than server acceptance; the expiry encoded in its object key and cron handle that difference. D1's provider-managed [Time Travel](https://developers.cloudflare.com/d1/platform/limits/) retains deleted database history for the plan's recovery window (currently 30 days Paid / 7 days Free), including temporary outbox records. Account backups and downloaded exports need their own finite retention and access policy; deleting the online record does not remove a previously downloaded export. The production lifecycle rules match the table above.

## Verification

```sh
pnpm exec vitest run --config telemetry/worker/vitest.config.ts
pnpm exec tsc -p telemetry/tsconfig.json
pnpm dlx node@22 node_modules/vitest/vitest.mjs run --config telemetry/worker/vitest.config.ts
pnpm dlx node@24 node_modules/vitest/vitest.mjs run --config telemetry/worker/vitest.config.ts
pnpm exec tsx telemetry/scripts/smoke.ts
pnpm telemetry:test:pipeline
```

The backend tests use Vitest registration so the parent's `telemetry/**/*.test.ts` inclusion also runs them through normal `pnpm test`. SQLite executes the actual migration, constraints, indexes, transactions, and queries. Tests cover valid/invalid/tampered signatures, strict schemas and byte limits, freshness, concurrent duplicates/conflicts, R2 failure and retry, D1 finalization failure, archive/receipt corruption, retention/tombstones/orphans, generic login failures, username/email login, unauthorized endpoints, session expiry/rotation/revocation, cross-origin mutations, digest rate limiting, raw detail, filtered stable pagination, and multi-page NDJSON export. The standalone smoke script additionally boots real Wrangler/workerd, migrates local D1, provisions through secure stdin, exercises scrypt/Ed25519/R2 with concurrent requests, revokes through the CLI, invokes cron, and serves local assets without external credentials. It owns and terminates its process group and removes its temporary state on success; failed runs retain a private temp directory with local logs.

Verified on 2026-11-19: all 29 backend tests passed on Node 22 and Node 24;
CLI regression tests, repository typecheck, and the real workerd/browser pipeline
passed. The production super-admin account was provisioned through secure input;
browser login, staff access, cookie protections, logout, and remote CLI checks
passed. Credentials are not tracked in this repository.
