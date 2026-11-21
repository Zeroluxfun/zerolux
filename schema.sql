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
  status TEXT NOT NULL DEFAULT 'live', stats TEXT, stats_at TEXT, created_at TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1, chain_id INTEGER, featured_until TEXT);
-- One row per signed payment, written before the payment is submitted. id = keccak256(payer, nonce).
-- status: paying -> paid -> running -> ran -> billed; or void (no money moved), unpaid (wallet refused the
-- charge), forfeit (paid, and its buyer did not come back in time), failed (out of tries with nothing spent).
-- Version 3 wallets only: refunding (paid, nothing delivered, on its way back to the payer) -> refunded.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, payer TEXT NOT NULL, nonce TEXT NOT NULL, paid INTEGER NOT NULL,
  budget INTEGER NOT NULL, valid_before INTEGER NOT NULL, from_block INTEGER NOT NULL, pay_tx TEXT, status TEXT NOT NULL,
  attempt TEXT, attempts INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, cost INTEGER, output TEXT,
  charge_tx TEXT, bill_tries INTEGER NOT NULL DEFAULT 0, bucket TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT, paid_at TEXT,
  started_at TEXT, finished_at TEXT, held INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, input_hash TEXT, output_hash TEXT,
  form TEXT, receipt_hash TEXT, refund_tx TEXT, refunded INTEGER, model_id TEXT,
  parent TEXT, sub_paid INTEGER NOT NULL DEFAULT 0, may_hire TEXT);
CREATE INDEX IF NOT EXISTS runs_parent ON runs (parent);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id, status);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, finished_at);
CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, payer TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_who ON memory (agent_id, payer);
CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, day));
-- agents.v is the wallet version (1 or 2), agents.chain_id the agent's number at its own factory, runs.held whether a
-- version 2 wallet has the run's cost set aside. Databases made before these existed got them by ALTER TABLE ADD COLUMN.
-- runs.tokens_in / tokens_out / input_hash / output_hash feed the public receipt at /api/runs/{id}; added by ALTER TABLE on 2026-11-20.
-- Version 3 wallets (added 2026-11-20). agents.v may be 3. On a version 3 run, runs.held is 1 when the wallet holds the whole
-- payment with its payer on record (taken through `pay`; it can be refunded) and 2 when the hold was opened from the wallet's own
-- money for a payment that did not come through `pay` (it cannot). runs.form is the EIP-3009 form the customer signed ('receive' or
-- 'transfer'), runs.receipt_hash the fingerprint the charge or refund carried on chain (see receiptHash in src/run.js),
-- runs.model_id the model id that fingerprint was worked out with, runs.refund_tx the refund transaction and runs.refunded the
-- USDG units that went back to the payer (NULL on a refund the wallet confirms but whose events could not be read).
-- runs.held = -1 marks a closed version 3 row that was checked a day later and has nothing left held on chain.
-- A database made before these existed needs, before the code that uses them is deployed:
--   ALTER TABLE runs ADD COLUMN form TEXT;
--   ALTER TABLE runs ADD COLUMN receipt_hash TEXT;
--   ALTER TABLE runs ADD COLUMN refund_tx TEXT;
--   ALTER TABLE runs ADD COLUMN refunded INTEGER;
--   ALTER TABLE runs ADD COLUMN model_id TEXT;
-- Agents hiring agents (version 3 wallets, added 2026-11-21). A sub-run is a row like any other: its id is the id the hired
-- wallet files it under (subRunKey = keccak256(abi.encode(paying wallet, sub-run id)), the sub-run id is kept in runs.nonce),
-- its payer is the hiring agent's wallet, its bucket is 'sub' (its money is part of its parent's seat) and runs.parent is the
-- run that paid for it. runs.sub_paid, on the parent, is what that run has paid other agents and not had back; the parent's
-- own cost never includes it. runs.held = 3 on a sub-run means its refund could not be handed back and is owed (retryReturn).
--   ALTER TABLE runs ADD COLUMN parent TEXT;
--   ALTER TABLE runs ADD COLUMN sub_paid INTEGER NOT NULL DEFAULT 0;
--   CREATE INDEX IF NOT EXISTS runs_parent ON runs (parent);
-- runs.may_hire (added 2026-11-21): the agent ids this run may hire, as a JSON list, fixed when its payment was admitted from
-- the list its customer had been shown in the 402 terms. A run hires nobody outside it. NULL or [] means nobody.
--   ALTER TABLE runs ADD COLUMN may_hire TEXT;
-- Featuring by burning $LUX (added 2026-11-21). agents.featured_until is the time (ISO-8601 UTC) an agent stops being shown
-- first on the market, or NULL. burns has one row per burn transaction that was accepted: its hash can be used once, amount is
-- $LUX token units (18 decimals) as text, burner the address the tokens left. See src/feature.js.
-- A database made before these existed needs, before the code that uses them is deployed:
--   ALTER TABLE agents ADD COLUMN featured_until TEXT;
CREATE TABLE IF NOT EXISTS burns (tx TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, burner TEXT NOT NULL, amount TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS burns_agent ON burns (agent_id);
