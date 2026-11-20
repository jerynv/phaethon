# Telemetry collector and console

One Cloudflare Worker at <https://telemetry.phaethon.app> receives events from
the app and serves the staff console. What the app collects, and why, is in
[docs/TELEMETRY.md](../docs/TELEMETRY.md).

| Path | |
| --- | --- |
| `worker/` | The Worker: ingestion, staff sign-in and accounts, event queries and export, the cleanup cron. |
| `migrations/` | The D1 schema. |
| `console/` | The staff console (React, built with the app's own components). |
| `scripts/staff.ts` | Creates and manages staff accounts from the command line. |
| `scripts/smoke.ts` | Runs the real Worker locally in workerd, end to end. |
| `scripts/dev-config.ts` | Writes a local-only Worker config and secret for development. |

## Storage

- **D1** holds an index row per event (category, event, version, platform,
  times), plus staff accounts, sessions, rate-limit counters and the access log.
- **R2** (`phaethon-telemetry-raw`, private) holds each event's full envelope and
  receipt as JSON. That's the long-term archive for analysis later.
- An event is written to D1 first, with its envelope held in an outbox column,
  then copied to R2 with a create-only write. Only archived events show in the
  console. The cron retries any that didn't reach R2.
- Every stored event gets a receipt: an HMAC under `ARCHIVE_RECEIPT_KEY` over its
  id, receipt time and envelope hash. Reads check the client signature, the
  receipt and the D1 row against each other and refuse a record that doesn't
  match.

Reports and traces are kept 90 days, usage and diagnostics 365
(`CONTENT_RETENTION_DAYS`, `METADATA_RETENTION_DAYS`, 1–3650). Reads hide
expired events at once; the cron every 10 minutes deletes them, and R2 lifecycle
rules on `events/content/` (90 days) and `events/metrics/` (365 days) back that
up.

## Ingestion

`POST /api/ingest` takes one envelope. The Worker checks its schema, size
(256 KiB), age (at most 24 hours old, 5 minutes ahead) and signature. A repeat of
an envelope already stored returns its original receipt; a different envelope
with the same id is refused. It's limited to 60 requests a minute per IP and 2000
overall; only keyed hashes of the IP are stored, for the minute they count. It
stores no IP address, header or cookie.

## Staff console

Staff sign in with an email or username and a password. There's no sign-up or
password reset: a super admin creates accounts.

- **Overview**: totals per category, events per day, and the most common events
  and outcomes for the last 7, 30 or 90 days.
- **Events**: filter by period and category, open an event to read its report or
  trace, and export as NDJSON.
- **Staff** (super admins only): add accounts, change email, username or role,
  reset passwords, disable sign-in, sign out every session, and see recent
  changes. The last active super admin can't be demoted or disabled.

Passwords are hashed with scrypt (N=32768, r=8, p=3). Sessions are random tokens
in a `__Host-` cookie (`HttpOnly; Secure; SameSite=Strict`), stored only as
hashes and valid for 8 hours. Any change to an account signs out its sessions.
Sign-in is limited per IP, per account and overall, and an unknown account takes
as long to fail as a wrong password.

## Running it

Production resources are named in `wrangler.jsonc`. It needs the Workers Paid
plan, for scrypt's CPU time.

```sh
pnpm telemetry:deploy            # build the console and deploy the Worker
pnpm telemetry:dev               # the console alone, proxying /api to :8790
pnpm telemetry:test:ui           # console browser tests (mocked API)
pnpm telemetry:smoke             # the real Worker in workerd
pnpm telemetry:test:pipeline     # the built app, the Worker and the console together
```

### Secrets

`ARCHIVE_RECEIPT_KEY` is at least 32 random bytes, base64, set with
`wrangler secret put`. A backup is in the operator's macOS keychain under service
`app.phaethon.telemetry`, account `archive-receipt-v1`. To rotate it, first add
the old key to `ARCHIVE_RECEIPT_PREVIOUS_KEYS` (a JSON array of up to ten), then
replace it. Records signed with a key that's no longer listed can't be read.

### Staff accounts

```sh
pnpm exec tsx telemetry/scripts/staff.ts provision --email you@example.com --username you --role owner --remote
pnpm exec tsx telemetry/scripts/staff.ts revoke  --email you@example.com --remote   # sign out every session
pnpm exec tsx telemetry/scripts/staff.ts disable --email you@example.com --remote   # and block sign-in
```

The password is asked for at a hidden prompt (or read from stdin), never taken
as an argument. Without `--remote` the script works on local state; add
`--config` and `--persist-to` to point it at a local setup. `--role owner` makes
a super admin; the first one has to be made this way.

### Locally

```sh
pnpm exec tsx telemetry/scripts/dev-config.ts /tmp/phaethon-telemetry-local
pnpm dlx wrangler@4.165.0 d1 migrations apply DB --local \
  --config /tmp/phaethon-telemetry-local/wrangler.json --persist-to /tmp/phaethon-telemetry-local/state
pnpm exec tsx telemetry/scripts/staff.ts provision --email staff@example.test --username staff --role owner \
  --config /tmp/phaethon-telemetry-local/wrangler.json --persist-to /tmp/phaethon-telemetry-local/state
pnpm dlx wrangler@4.165.0 dev \
  --config /tmp/phaethon-telemetry-local/wrangler.json --persist-to /tmp/phaethon-telemetry-local/state
```

The directory must be outside the repository. Its config serves a placeholder
page; point its `assets.directory` at `telemetry/console/dist` (after
`pnpm telemetry:build`) to use the real console. Session cookies are `Secure`,
so use a browser that treats `localhost` as secure.

## API

Every `/api/` route except ingest and login needs a session. Errors are
`{ "error": string }`: 400 malformed, 401 not signed in, 403 not allowed or
cross-origin, 409 conflict, 413 too large, 415 not JSON, 429 rate limited, 503
storage trouble. Writes must come from the console's own origin.

| Route | |
| --- | --- |
| `POST /api/ingest` | One envelope → `201 {id, receipt}`, or `200` for a repeat. |
| `POST /api/login` | `{email, password}` (email or username) → `{email, role}` and the session cookie. |
| `GET /api/session`, `POST /api/logout` | The current session; end it. |
| `GET /api/overview?days=7\|30\|90` | Totals, per-day counts, events and outcomes. |
| `GET /api/events?days=&category=&before=` | 50 events per page, newest first, with `nextCursor`. |
| `GET /api/events/:id` | The full envelope, parsed payload and receipt, verified. |
| `GET /api/export?days=&category=&before=` | NDJSON, up to 50 records or 4 MiB per page; follow `X-Next-Cursor` for the rest. |
| `GET/POST /api/staff`, `PATCH /api/staff/:id`, `POST /api/staff/:id/revoke`, `GET /api/staff/audit` | Staff accounts and their change log (super admins only). |
