-- Sebastian D1 schema (PLAN §5.5). Hot state (tokens, live counters) lives in DO SQLite, not here.

CREATE TABLE installs (
  installed_app_id TEXT PRIMARY KEY,
  location_id      TEXT NOT NULL,
  hub_id           TEXT,
  hub_model        TEXT,
  hub_fw           TEXT,
  scopes           TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,
  location_id      TEXT NOT NULL,
  room_id          TEXT,
  label            TEXT,
  integration_type TEXT NOT NULL,
  driver_id        TEXT,
  hub_id           TEXT,
  profile_json     TEXT,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX devices_location ON devices(location_id);

CREATE TABLE rules_managed (
  rule_id          TEXT PRIMARY KEY,
  installed_app_id TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  compiled_hash    TEXT NOT NULL,
  predicted_loc    TEXT,
  actual_loc       TEXT,
  applied_at       INTEGER NOT NULL,
  compiled_json    TEXT NOT NULL
);
CREATE UNIQUE INDEX rules_managed_source ON rules_managed(installed_app_id, source_path);

CREATE TABLE capabilities (
  capability_id    TEXT NOT NULL,
  version          INTEGER NOT NULL,
  definition_json  TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (capability_id, version)
);

CREATE TABLE probe_results (
  integration_type   TEXT NOT NULL,
  operation          TEXT NOT NULL,
  execution_location TEXT NOT NULL,
  hub_model          TEXT,
  hub_fw             TEXT,
  observed_at        INTEGER NOT NULL
);
CREATE INDEX probe_results_key ON probe_results(integration_type, operation, observed_at);

CREATE TABLE events (
  event_id     TEXT PRIMARY KEY,
  event_time   INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  type         TEXT NOT NULL,
  device_id    TEXT,
  capability   TEXT,
  attribute    TEXT,
  value_json   TEXT,
  state_change INTEGER,
  epoch        INTEGER
);
CREATE INDEX events_received ON events(received_at);
CREATE INDEX events_device ON events(device_id, event_time);

CREATE TABLE latency (
  rule_id          TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL,
  effect_event_id  TEXT NOT NULL,
  delta_ms         INTEGER NOT NULL,
  PRIMARY KEY (rule_id, trigger_event_id)
);

CREATE TABLE calls_daily (
  installed_app_id TEXT NOT NULL,
  day              TEXT NOT NULL,
  category         TEXT NOT NULL,
  route_template   TEXT NOT NULL,
  count            INTEGER NOT NULL,
  errors           INTEGER NOT NULL,
  PRIMARY KEY (installed_app_id, day, category, route_template)
);
