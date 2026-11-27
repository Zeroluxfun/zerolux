#!/bin/sh
# Gets the live database ready for the code being deployed (safe to run twice), then deploys the site.
set -e
cd "$(dirname "$0")"
export CLOUDFLARE_ACCOUNT_ID=6cd157ce9109ca2e0c6735747df64590
# (the pictures table already exists)
# Editable agents: two new columns and one new table in the live database, added before the code that uses them.
# Each step is safe to run twice: a column that is already there is left alone.
add() {
  if ! out=$(npx wrangler d1 execute zerolux --remote --yes --command "$1" 2>&1); then
    echo "$out" | grep -qi 'duplicate column' || { echo "$out"; exit 1; }
  fi
}
add "ALTER TABLE agents ADD COLUMN rev INTEGER NOT NULL DEFAULT 1"
add "ALTER TABLE runs ADD COLUMN rev INTEGER"
add "CREATE TABLE IF NOT EXISTS revisions (agent_id INTEGER NOT NULL, rev INTEGER NOT NULL, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, price INTEGER NOT NULL, signer TEXT, signed_at TEXT, signature TEXT, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, rev))"
# Bring your own tools: where connection keys are kept, encrypted.
add "CREATE TABLE IF NOT EXISTS conn_keys (agent_id INTEGER NOT NULL, fp TEXT NOT NULL, enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, fp))"
# Paying by card: the rows a credit balance is the sum of.
add "CREATE TABLE IF NOT EXISTS credit_events (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT, meta TEXT, state TEXT NOT NULL DEFAULT 'closed', created_at TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS credit_events_account ON credit_events (account)"
add "CREATE INDEX IF NOT EXISTS credit_events_open ON credit_events (state, kind)"
# Reviews and free samples.
add "CREATE TABLE IF NOT EXISTS reviews (run_id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, stars INTEGER NOT NULL, body TEXT, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS reviews_agent ON reviews (agent_id, hidden)"
add "CREATE TABLE IF NOT EXISTS samples (agent_id INTEGER PRIMARY KEY, account TEXT, per_day INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT, updated_at TEXT NOT NULL)"
# Standing orders: scheduled runs and price watches.
add "CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, account TEXT NOT NULL, agent_id INTEGER NOT NULL, input TEXT NOT NULL, every TEXT NOT NULL, hour INTEGER NOT NULL DEFAULT 0, dow INTEGER NOT NULL DEFAULT 0, watch TEXT, armed INTEGER NOT NULL DEFAULT 0, max_price INTEGER NOT NULL, webhook TEXT, status TEXT NOT NULL DEFAULT 'on', reason TEXT, fails INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_at TEXT, created_at TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS subs_account ON subs (account, status)"
add "CREATE INDEX IF NOT EXISTS subs_due ON subs (status, every, next_at)"
add "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, account TEXT NOT NULL, agent_id INTEGER NOT NULL, run_id TEXT, ticket TEXT NOT NULL, input TEXT NOT NULL, note TEXT, status TEXT NOT NULL, output TEXT, paid INTEGER, error TEXT, review TEXT, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT)"
add "CREATE INDEX IF NOT EXISTS deliveries_account ON deliveries (account, created_at)"
add "CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries (status, created_at)"
# Long jobs: an agent run in steps on one piece of work.
add "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, agent_id INTEGER NOT NULL, goal TEXT NOT NULL, max_steps INTEGER NOT NULL, max_price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'working', reason TEXT, next TEXT, wrap INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, report TEXT, run_id TEXT, review TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)"
add "CREATE TABLE IF NOT EXISTS job_steps (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, n INTEGER NOT NULL, round INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, ticket TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, title TEXT, output TEXT, paid INTEGER, run_id TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT)"
add "CREATE INDEX IF NOT EXISTS jobs_account ON jobs (account, created_at)"
add "CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated_at)"
add "CREATE INDEX IF NOT EXISTS job_steps_job ON job_steps (job_id, seq)"
# Files a customer attaches to a request.
add "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, size INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, text TEXT, data BLOB, created_at TEXT NOT NULL, keep_until TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS files_keep ON files (keep_until)"
# Where results are sent: a webhook or Telegram, per credit account.
add "CREATE TABLE IF NOT EXISTS routes (account TEXT PRIMARY KEY, webhook TEXT, tg_chat TEXT, tg_code TEXT, tg_code_at TEXT, updated_at TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS routes_code ON routes (tg_code)"
add "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
add "CREATE TABLE IF NOT EXISTS copying (agent_id INTEGER PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
# Verified agents: who signed the request that paid for a run, the owner's switch, and used signatures.
add "ALTER TABLE runs ADD COLUMN tap TEXT"
add "CREATE TABLE IF NOT EXISTS tap_only (agent_id INTEGER PRIMARY KEY, required INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
add "CREATE TABLE IF NOT EXISTS tap_nonces (id TEXT PRIMARY KEY, run TEXT NOT NULL, expires INTEGER NOT NULL)"
# Paid tools (src/paytools.js): payments runs made to outside tools over x402.
add "CREATE TABLE IF NOT EXISTS tool_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, agent_id INTEGER NOT NULL, tool TEXT NOT NULL, host TEXT NOT NULL, pay_to TEXT NOT NULL, amount INTEGER NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, tx TEXT, at TEXT NOT NULL)"
add "CREATE INDEX IF NOT EXISTS tool_payments_run ON tool_payments (run)"
add "CREATE INDEX IF NOT EXISTS tool_payments_at ON tool_payments (at)"
# The tool shelf (src/shelf.js): paid tools listed for any builder to add.
add "CREATE TABLE IF NOT EXISTS shelf (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL, example TEXT, price INTEGER NOT NULL, pay_to TEXT NOT NULL, host TEXT NOT NULL, lister TEXT NOT NULL, signature TEXT, signed_at TEXT, status TEXT NOT NULL DEFAULT 'listed', fails INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, checked_at TEXT NOT NULL)"
echo "Database ready."
npx wrangler deploy
