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
  v INTEGER NOT NULL DEFAULT 1, chain_id INTEGER, featured_until TEXT, rev INTEGER NOT NULL DEFAULT 1);
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
  parent TEXT, sub_paid INTEGER NOT NULL DEFAULT 0, may_hire TEXT, rev INTEGER, tap TEXT);
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
-- Agent profiles (added 2026-11-21). One row per agent whose owner has set one: a picture (kept here as bytes, 300 KB at most,
-- JPEG, PNG or WebP), a tagline shown in place of the built one, an X handle and a website. photo_hash is the SHA-256 of the
-- picture in hex. signed_at is the time inside the owner's last signed change (a change signed at or before it is refused),
-- updated_by the owner address that signed, or 'zerolux' when Zero Lux took the profile down. locked = 1 stops further changes.
-- See src/profile-api.js.
CREATE TABLE IF NOT EXISTS profiles (
  agent_id INTEGER PRIMARY KEY, photo BLOB, photo_type TEXT, photo_hash TEXT, tagline TEXT, x TEXT, site TEXT,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, signed_at TEXT, locked INTEGER NOT NULL DEFAULT 0);

-- Pictures an agent made during a run (the make_image tool). Served from /api/images/<id>, an address nobody can guess,
-- and deleted after 30 days. run_id and agent_id say which run made it, so a picture can be traced and taken down.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  body BLOB NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Editable agents (added 2026-11-23). An owner can change what an agent does; each change is a new version. agents.rev
-- is the version that is live (1 = as built) and agents.spec, name and price are that version's. agents.spec_hash stays
-- the fingerprint of version 1, the one the factory contract recorded, and the address of the agent's identity card.
-- revisions has one row per version of an agent that has been changed at least once (version 1 is copied in at the
-- first change): the spec as JSON text, its fingerprint, its price, and for every version after the first the owner
-- address that signed it, the time inside the signed message and the signature. runs.rev is the version a run was
-- admitted under and works by; NULL on a row from before this existed, which means version 1. See src/revise.js.
-- A database made before these existed needs, before the code that uses them is deployed:
--   ALTER TABLE agents ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
--   ALTER TABLE runs ADD COLUMN rev INTEGER;
CREATE TABLE IF NOT EXISTS revisions (
  agent_id INTEGER NOT NULL, rev INTEGER NOT NULL, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, price INTEGER NOT NULL,
  signer TEXT, signed_at TEXT, signature TEXT, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, rev));

-- Bring your own tools (added 2026-11-23). An agent's connections to outside tool servers are part of its spec; the key
-- a connection is called with is not. conn_keys holds each key encrypted (AES-GCM under a key derived from a Worker
-- secret), found by the fingerprint the spec carries (`k:` and 16 hex characters of an HMAC). Rows are kept when a
-- connection changes, so a run admitted under an older version can still finish. See src/connect.js.
CREATE TABLE IF NOT EXISTS conn_keys (agent_id INTEGER NOT NULL, fp TEXT NOT NULL, enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, fp));

-- Card credit. An account is the SHA-256 of a secret kept in the buyer's browser. Its balance is the sum of its rows:
-- 'topup' (a paid Stripe checkout, id top:<session>), 'spend' (a run, id run:<run id>, negative, open until the run closes),
-- 'back' (credit returned for a run that did not deliver, id back:<run id>), 'freeze' (a disputed card payment, amount 0).
CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT, meta TEXT,
  state TEXT NOT NULL DEFAULT 'closed', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS credit_events_account ON credit_events (account);
CREATE INDEX IF NOT EXISTS credit_events_open ON credit_events (state, kind);

-- Reviews (added 2026-11-24). One row per paid run its buyer rated: one to five stars and up to 280 characters of plain
-- text. Whoever posts one proves the purchase with a token that came with the run's answer. hidden = 1 is a review
-- Zero Lux took down. See src/reviews.js.
CREATE TABLE IF NOT EXISTS reviews (run_id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, stars INTEGER NOT NULL, body TEXT, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_agent ON reviews (agent_id, hidden);
-- Free samples (added 2026-11-24). One row per agent whose owner has set it: whether visitors may try the agent once for
-- free, how many a day at most, and the credit account (src/credits.js) the price of each sample is taken from. signer and
-- signed_at are the owner address and the time inside the signed message that last changed it. See src/samples.js.
CREATE TABLE IF NOT EXISTS samples (agent_id INTEGER PRIMARY KEY, account TEXT, per_day INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT, updated_at TEXT NOT NULL);

-- Standing orders (added 2026-11-24). subs has one row per order: whose credit pays (account), which agent, the request it
-- works on each time, how often (every: hour, day, week, or watch with a coin, a side and a price in `watch`; hours are UTC),
-- the price it was set up at (max_price: a dearer agent stops it), an optional webhook for results, and where it stands
-- (status: on, paused, ended; reason says why it stopped by itself). armed is a price watch that may fire.
-- deliveries has one row per run an order owed: its request, the run it became, and the result, kept 30 days for the
-- customer's inbox. `review` is the review code that came with the answer. See src/subs.js.
CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, account TEXT NOT NULL, agent_id INTEGER NOT NULL, input TEXT NOT NULL, every TEXT NOT NULL, hour INTEGER NOT NULL DEFAULT 0, dow INTEGER NOT NULL DEFAULT 0, watch TEXT, armed INTEGER NOT NULL DEFAULT 0, max_price INTEGER NOT NULL, webhook TEXT, status TEXT NOT NULL DEFAULT 'on', reason TEXT, fails INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS subs_account ON subs (account, status);
CREATE INDEX IF NOT EXISTS subs_due ON subs (status, every, next_at);
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, account TEXT NOT NULL, agent_id INTEGER NOT NULL, run_id TEXT, ticket TEXT NOT NULL, input TEXT NOT NULL, note TEXT, status TEXT NOT NULL, output TEXT, paid INTEGER, error TEXT, review TEXT, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS deliveries_account ON deliveries (account, created_at);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries (status, created_at);

-- Long jobs: one agent run in steps on one big piece of work. jobs has one row per job; job_steps one row per step it
-- owed (a working step leaves notes, the last step writes the result). Kept 30 days. See src/jobs.js.
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, agent_id INTEGER NOT NULL, goal TEXT NOT NULL, max_steps INTEGER NOT NULL, max_price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'working', reason TEXT, next TEXT, wrap INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, report TEXT, run_id TEXT, review TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS job_steps (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, n INTEGER NOT NULL, round INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, ticket TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, title TEXT, output TEXT, paid INTEGER, run_id TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS jobs_account ON jobs (account, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated_at);
CREATE INDEX IF NOT EXISTS job_steps_job ON job_steps (job_id, seq);

-- Files a customer attached to a request: the text their browser read out of a document, or a small JPEG. The id is
-- the only key. Deleted once keep_until has passed. See src/files.js.
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, size INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, text TEXT, data BLOB, created_at TEXT NOT NULL, keep_until TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS files_keep ON files (keep_until);

-- Where a credit account's results are sent when nobody is on the site (src/deliver.js), and small facts the Worker keeps.
CREATE TABLE IF NOT EXISTS routes (account TEXT PRIMARY KEY, webhook TEXT, tg_chat TEXT, tg_code TEXT, tg_code_at TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS routes_code ON routes (tg_code);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Whether an agent's owner has stopped others starting a new agent from it (src/templates-api.js). No row means allowed.
CREATE TABLE IF NOT EXISTS copying (agent_id INTEGER PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- Verified agents (src/tap-api.js). tap_only: whether an agent's owner takes work only by a request a verified agent
-- signed; no row means anyone. tap_nonces: each signature's key and nonce, with the run it was used for, so one
-- signature buys one run. runs.tap (added by ALTER TABLE on 2026-11-26): who signed the request that paid for a run.
CREATE TABLE IF NOT EXISTS tap_only (agent_id INTEGER PRIMARY KEY, required INTEGER NOT NULL DEFAULT 0, signer TEXT, signed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tap_nonces (id TEXT PRIMARY KEY, run TEXT NOT NULL, expires INTEGER NOT NULL);

-- Paid tools (src/paytools.js): every payment a run made to an outside tool over x402, written before it is sent.
-- amount is USDG units; status is 'sent', 'delivered' or 'not delivered'; tx is the settlement the tool reported, if any.
CREATE TABLE IF NOT EXISTS tool_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, agent_id INTEGER NOT NULL, tool TEXT NOT NULL, host TEXT NOT NULL, pay_to TEXT NOT NULL, amount INTEGER NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, tx TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tool_payments_run ON tool_payments (run);
CREATE INDEX IF NOT EXISTS tool_payments_at ON tool_payments (at);

-- The tool shelf (src/shelf.js): paid tools listed for any builder to add, each signed by the wallet it is paid at.
-- price is USDG units as last checked; fails counts checks in a row that did not pass; status is 'listed' or 'removed'.
CREATE TABLE IF NOT EXISTS shelf (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL, example TEXT, price INTEGER NOT NULL, pay_to TEXT NOT NULL, host TEXT NOT NULL, lister TEXT NOT NULL, signature TEXT, signed_at TEXT, status TEXT NOT NULL DEFAULT 'listed', fails INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, checked_at TEXT NOT NULL);
