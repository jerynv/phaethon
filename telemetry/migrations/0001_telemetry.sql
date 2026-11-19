PRAGMA foreign_keys = ON;

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  auth_version TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  auth_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_staff ON sessions(staff_id);

-- Short lived counters contain hashes only: no IP/account identifiers or request data.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);

-- Tombstones prevent resurrecting deleted content while a signed timestamp is still fresh.
CREATE TABLE replays (
  id TEXT PRIMARY KEY,
  envelope_hash TEXT NOT NULL,
  reservation_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX replays_expiry ON replays(expires_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY REFERENCES replays(id),
  category TEXT NOT NULL CHECK(category IN ('usage','diagnostics','reports','traces')),
  event TEXT NOT NULL,
  received_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  outcome TEXT,
  expires_at INTEGER NOT NULL,
  archive_key TEXT NOT NULL UNIQUE,
  envelope_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  -- Durable outbox: erased only after confirmed R2 write. Never exposed before archival.
  pending_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);
CREATE INDEX events_received ON events(archived, received_at DESC, id DESC);
CREATE INDEX events_category_received ON events(archived, category, received_at DESC, id DESC);
CREATE INDEX events_event_received ON events(archived, event, received_at);
CREATE INDEX events_outcome_received ON events(archived, outcome, received_at);
CREATE INDEX events_expiry ON events(expires_at);
CREATE INDEX events_outbox ON events(archived, expires_at);
