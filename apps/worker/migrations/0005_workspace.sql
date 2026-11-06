-- The automations a location should have (its desired state), edited in the web UI or set by
-- `seb apply`. Plan/apply compile these in the browser (ADR-006).
CREATE TABLE automations (
  installed_app_id TEXT NOT NULL,
  source_path      TEXT NOT NULL,      -- automations/<name>.ts
  source           TEXT NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT,
  PRIMARY KEY (installed_app_id, source_path)
);

-- The last /api/model per location: refreshing it costs the inventory calls (devices, hubs,
-- location, modes, rooms), and the editor needs it on every visit.
CREATE TABLE model_cache (
  installed_app_id TEXT PRIMARY KEY,
  model_json       TEXT NOT NULL,
  fetched_at       INTEGER NOT NULL
);
