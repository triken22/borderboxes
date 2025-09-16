-- d1/schema.sql
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  seed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  run_id TEXT,
  player_id TEXT,
  kills INTEGER DEFAULT 0,
  damage INTEGER DEFAULT 0,
  loot_value INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, player_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_id TEXT,
  archetype TEXT,     -- pistol | smg | rifle
  rarity TEXT,        -- common | rare | epic | legendary
  dps REAL,
  mag INTEGER,
  reload_ms INTEGER,
  seed TEXT           -- for deterministic reroll/replication
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  player_id TEXT,
  payload TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
