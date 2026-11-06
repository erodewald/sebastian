-- Users (people who signed in through Access/PocketID), per-location membership, and personal
-- API tokens for the CLI. See ADR-005.
CREATE TABLE users (
  email        TEXT PRIMARY KEY,           -- lowercased Access identity email
  sub          TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0, -- the first user to sign in becomes admin
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE install_members (
  installed_app_id TEXT NOT NULL,
  email            TEXT NOT NULL,            -- may be invited before they first sign in
  role             TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_by         TEXT,
  added_at         INTEGER NOT NULL,
  PRIMARY KEY (installed_app_id, email)
);
CREATE INDEX install_members_email ON install_members (email);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,         -- sha256 hex; the token itself is shown once
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_tokens_email ON api_tokens (email);

ALTER TABLE installs ADD COLUMN location_name TEXT;
ALTER TABLE installs ADD COLUMN owner_email TEXT;
