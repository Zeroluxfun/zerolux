CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web'
);

-- Zero Lux runtime tables (D1). Dates are ISO-8601 UTC. Money is USDG units (6 decimals).
CREATE TABLE IF NOT EXISTS drafts (spec_hash TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, wallet TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, name TEXT NOT NULL,
  spec TEXT NOT NULL, spec_hash TEXT NOT NULL UNIQUE, price INTEGER NOT NULL, identity_id TEXT, create_tx TEXT,
  status TEXT NOT NULL DEFAULT 'live', stats TEXT, stats_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, payer TEXT NOT NULL, paid INTEGER NOT NULL, pay_tx TEXT NOT NULL UNIQUE,
  budget INTEGER NOT NULL, cost INTEGER, charge_tx TEXT, status TEXT NOT NULL, retry TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id, status);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, finished_at);
CREATE UNIQUE INDEX IF NOT EXISTS runs_retry ON runs (retry) WHERE retry IS NOT NULL;
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, payer TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_who ON memory (agent_id, payer);
CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, day));
