# Telemetry implementation

## Acceptance and ownership

The prerequisite is the completed model/settings thread and its changes merged to
GitHub main. PR #17 merged as `807d2e0`; the thread also opened #18 for signing.
Final integration must include that thread's finished work. The shared checkout
is owned by that thread. Telemetry integration is isolated at
`/Users/jeryn/Documents/GitHub/phaethon-telemetry`, branch `feat/telemetry`.

- Client worker: prepared T3 worktree `telemetry-consent-client`; owns client,
  consent/onboarding, Privacy settings, and app instrumentation.
- Backend worker: prepared T3 worktree `cloudflare-telemetry-backend`; owns Worker,
  migrations, staff provisioning, storage, shared event schema, security tests.
- Parent: console, packaging, integration, end-to-end and visual verification.

Complete when:

1. No collection before preferences are saved. Every category can be disabled
   independently, including anonymous usage. Revocation discards queued events.
2. Usage has only allow-listed coarse events and no account or persistent device
   identifier. Text reports and new-turn chat traces have separate controls and
   local best-effort redaction. Content is never described as fully anonymous.
3. The collector verifies signatures, rejects malformed/tampered/stale data, and
   handles retries idempotently. Its public ingestion endpoint grants no read
   access. Accepted events have a durable private backup for later analysis.
4. Provisioned staff can sign in, view counts and trends, inspect event details,
   filter and paginate, export records, and revoke their session by signing out.
   Unauthenticated and expired sessions cannot read records.
   Super admins can manage staff accounts, roles, credentials, and sessions;
   viewers cannot access those APIs. Concurrent changes preserve an active super
   admin, and an access audit keeps the identities recorded at the time of change.
5. Client and collector interoperate in a local end-to-end exercise. Relevant
   unit, type, build, browser, and rendered-state checks pass after integration.

## Data choices

Four controls start checked during onboarding, but nothing is collected until
the person saves their choices. Existing installations must also review them.
Anonymous usage is a separate control and can be turned off. Telemetry must not
be necessary for the application to work.

Usage measures event counts, not unique people, because envelopes contain no
stable identity. Diagnostics exclude raw errors, prompts, paths, provider URLs,
and custom model names. The `turn_completed` diagnostic describes a backend
attempt; automatic fallback can create several attempts for one chat send.
The console labels these as attempt outcomes. Reports are submitted explicitly. Traces contain only
newly shared user/assistant turn text, excluding tools and system prompts.
Redaction removes common identifiers and credentials but cannot remove all
personal information from arbitrary prose.

Every envelope uses a fresh Ed25519 key. A verified signature demonstrates
payload integrity, not installation authenticity or the truth of the event.
The console must not label self-signed data as attested. Long-term backups allow
new analyses without adding persistent account tracking. Content retention is
bounded separately from anonymous measurements.

## References

- [PostHog collection controls](https://posthog.com/docs/privacy/data-collection):
  distinct controls for collection, identifiers, masking, and opt-out.
- [Langfuse masking](https://langfuse.com/docs/observability/features/masking):
  remove sensitive text before export, and distinguish app masking from
  filtering after data has left the device.
- [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/):
  standards-based Ed25519 verification in Workers.
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
  and [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/):
  indexed analysis alongside independent raw storage and retention.

Deployment and staff provisioning require the owner's target Cloudflare account,
hostname and authorized staff email addresses. No production resource is created
by building or running the tests.

Once the collector is deployed, build desktop releases with
`PHAETHON_TELEMETRY_BUILD_ENDPOINT=https://<console-host>/api/ingest pnpm build`.
The public HTTPS address is embedded in the core, so people launching the
installed application normally need no environment setup. An explicit
`PHAETHON_TELEMETRY_ENDPOINT` overrides it at runtime; an empty override disables
the endpoint. Source/dev/test runs stay offline unless a loopback collector is
explicitly enabled with `PHAETHON_TELEMETRY_ALLOW_LOCAL=1` for a local exercise.
Neither option bypasses saved per-category choices.
The release workflow supplies the chosen public collector URL when it builds
installers; ordinary CI and development builds do not.

The chosen initial console origin is `https://telemetry.phaethon.app`. Super-admin
access is provisioned separately from source configuration. Staff accounts can be
managed from the console; changing the hostname is a Cloudflare route and origin
configuration change, followed by rebuilding releases with the new collector URL.

Local joined verification is `pnpm telemetry:test:pipeline`: it builds the app
and console, creates disposable local D1/R2 state, provisions a temporary super
admin through secure stdin, and runs the real app and browser against workerd.
It exercises consent, signing, redaction, independent opt-out, trace inspection,
staff creation, viewer access, session revocation, the last-super-admin guard,
and logout. Credentials and temporary state are removed on success; screenshots
are kept in the evidence directory printed by the script.
