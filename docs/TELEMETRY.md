# Telemetry

Phaethon can send its developers four kinds of data. Each is a separate switch,
and the team reads what arrives in a private console at
<https://telemetry.phaethon.app>. How the collector and console are run is in
[telemetry/README.md](../telemetry/README.md).

## What people choose

| Switch | What it sends |
| --- | --- |
| Anonymous usage | App opens, views opened, and counts of actions (chat sent, space created, file opened, search, study session). |
| Diagnostics | For each reply attempt: which assistant, how long, how many tool steps, and whether it completed, failed or was cancelled. |
| Testing reports | Text the person writes, reviews after redaction, and sends from Settings → Privacy. |
| Chat traces | The new prompt and the streamed reply of each completed turn. Never tool calls, reasoning, system prompts, files or earlier messages. |

- Onboarding shows all four switched on. Nothing is sent until the person saves
  their choices, and each switch can be turned off then or later in
  Settings → Privacy. Installs that finished onboarding before telemetry existed
  get the same screen once, before the app opens.
- Turning a switch off drops that category's queued events and cancels its
  upload in flight. A trace needs the switch on from the start of the turn to its
  end.
- Choices live in `<app data>/telemetry-consent.json`: outside the vault, never
  synced. Missing or malformed means no choice yet, so nothing is sent.
- The app works the same with everything off.

## What makes it anonymous, and what doesn't

- No account, installation or device identifier is sent or stored. The console
  counts events, not people.
- Usage and diagnostics carry only values from fixed lists (see
  `src/shared/telemetry.ts`); both the app and the collector reject anything else.
- Reports and traces are free text. The app redacts email addresses, common API
  keys and tokens, private keys, URLs and home-folder paths before signing
  (`src/server/telemetry/redact.ts`), but names and other details in prose can
  remain. The Privacy screen says so.

## Signing

Each event is sent as an envelope signed with an Ed25519 key made for that
envelope alone and then discarded:

```text
{ v: 1, id, sentAt, publicKey, payload, signature }
signature = Ed25519(publicKey, "phaethon.telemetry.v1\n" + id + "\n" + sentAt + "\n" + payload)
```

A valid signature shows the payload wasn't altered after it was signed. It
doesn't show which app sent it: anyone can sign an envelope, and a per-install
key would be a persistent identifier. When the collector stores an event it also
signs a receipt with its own secret key, so a stored record can't be edited
later without detection.

## Sending

Events wait in a memory queue (at most 64 events / 512 KiB) and are sent one at a
time. A network error, 429 or 5xx is retried twice, after 1 s and 5 s, with the
same envelope so the collector can recognise a repeat. Nothing is kept across a
restart.

Only installed release builds have a collector. The release workflow builds with
`PHAETHON_TELEMETRY_BUILD_ENDPOINT=https://telemetry.phaethon.app/api/ingest`;
dev, test and CI builds have none. `PHAETHON_TELEMETRY_ENDPOINT` overrides the
address at runtime (empty disables it), and a dev run can send to a loopback
collector with `PHAETHON_TELEMETRY_ALLOW_LOCAL=1`.

## Code

| Path | |
| --- | --- |
| `src/shared/telemetry.ts` | Wire format and validation, shared by app and collector. |
| `src/server/telemetry/` | Consent, queue and signing (`client.ts`), chat-turn recording (`turn.ts`), redaction, IPC commands. |
| `src/web/src/features/telemetry/Privacy.tsx` | Onboarding step, first-choice gate, Settings → Privacy, report form. |
| `telemetry/` | The Cloudflare Worker collector, D1 schema, staff console, and operator scripts. |

Tests: `src/server/telemetry/*.test.ts` (unit and an end-to-end flow through real
turns), `e2e/telemetry.spec.ts` (the app against a local collector),
`telemetry/worker/backend.test.ts`, `telemetry/console/tests/`, and
`pnpm telemetry:test:pipeline` (the built app, the real Worker in workerd, and
the console in a browser).
