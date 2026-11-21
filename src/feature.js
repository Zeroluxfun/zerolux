// POST /api/agents/:id/feature {tx}: anyone may burn $LUX to put an agent at the top of the market.
// The page (or anyone) sends the hash of a transaction that transferred $LUX to the dead address; the
// burn is checked on chain here and recorded once. The Worker never holds the tokens.
// A burn belongs to one agent: the transaction's calldata must end with that agent's number (see checkInput
// in burn.js), so a burn seen on chain cannot be claimed for a different agent. And nothing is accepted until
// FEATURE_FROM_BLOCK is set, so burns made before featuring opened cannot be used at all.
import { reader } from './chain.js';
import { json, allow, clientKey, readJson } from './line.js';
import { checkBurn, checkInput, luxConfig, wholeTokens } from './burn.js';
import { selfRun } from './api.js';

const amount = (n) => Number(n).toLocaleString('en-US');

export async function feature(request, env, a) {
  const cfg = luxConfig(env);
  if (!cfg.open) return json({ error: 'Featuring is not open yet. Nothing was recorded.' }, 503);
  const body = await readJson(request, 2000); if (!body) return json({ error: 'Send JSON.' }, 400);
  const tx = String(body?.tx || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return json({ error: 'Send the hash of the burn transaction: 0x followed by 64 characters.' }, 400);
  // Only an agent that is on the market can be featured: not a retired one, and not one its owner now runs elsewhere.
  let stats = null; try { stats = a.stats ? JSON.parse(a.stats) : null; } catch {}
  if (a.status !== 'live' || selfRun(env, a, stats)) return json({ error: 'This agent is off the market, so it cannot be featured.' }, 409);
  if (!(await allow(env, 'feature:' + clientKey(request), 40))) return json({ error: 'That is enough tries for today. Come back tomorrow.' }, 429);
  if (!(await allow(env, 'feature:all', 4000))) return json({ error: 'Featuring is at capacity today. Your burn is safe: send its hash again tomorrow.' }, 429);

  const used = () => json({ error: 'That burn has already been used to feature an agent.' }, 409);
  const seen = () => env.DB.prepare('SELECT 1 FROM burns WHERE tx = ?').bind(tx).first();
  if (await seen()) return used();

  // The transaction (who it was sent to, and its calldata) and its receipt (what it did), read together.
  const c = reader(env), gone = (e, name) => e?.name === name || !!e?.walk?.((x) => x?.name === name);
  const again = () => json({ again: true, error: 'That transaction is not confirmed on Robinhood Chain yet. Try again in a few seconds.' }, 409);
  let sent, receipt;
  try {
    [sent, receipt] = await Promise.all([
      c.getTransaction({ hash: tx }).catch((e) => { if (gone(e, 'TransactionNotFoundError')) return null; throw e; }),
      c.getTransactionReceipt({ hash: tx }).catch((e) => { if (gone(e, 'TransactionReceiptNotFoundError')) return null; throw e; }),
    ]);
  } catch { return json({ error: 'The chain is not answering. Nothing was recorded: try again in a minute.' }, 502); }
  if (sent && String(sent.hash || '').toLowerCase() !== tx) sent = null;
  if (receipt && String(receipt.transactionHash || '').toLowerCase() !== tx) receipt = null;
  // Not on chain yet: nothing is recorded, and the page asks again in a few seconds.
  if (!sent) return again();
  const made = checkInput(sent, cfg, a.id);
  if (!made.ok) {
    const plain = 'A burn has to be made from the page of the agent it is for.';
    const why = {
      route: 'That transaction was not sent straight to the $LUX token, so it cannot be used. ' + plain,
      selector: 'That transaction is not a transfer of $LUX. ' + plain,
      unbound: 'That burn does not say which agent it is for, so it cannot be used. ' + plain,
      length: 'That transaction carries more than a burn for one agent, so it cannot be used. ' + plain,
      recipient: 'That transaction did not send $LUX to the burn address ' + cfg.burnAddress + '.',
      agent: 'That burn was made for a different agent, so it cannot be used for this one.',
    }[made.reason];
    return json({ error: why }, 422);
  }
  const burn = checkBurn(receipt, cfg);
  if (!burn.ok) {
    if (burn.reason === 'missing') return again();
    const why = {
      failed: 'That transaction failed on chain, so nothing was burned.',
      early: 'That burn was made before featuring opened, so it cannot be used.',
      none: 'That transaction did not burn any $LUX. A burn is a transfer of $LUX to ' + cfg.burnAddress + '.',
      small: `That transaction burned ${wholeTokens(burn.value ?? 0n)} $LUX. Featuring takes at least ${amount(cfg.featureAmount)}.`,
    }[burn.reason];
    return json({ error: why }, 422);
  }

  // One transaction, one use: the burn is written first and its hash is the primary key. Both statements
  // run as one batch, so a second request with the same hash fails on the insert and moves no date.
  // The new date is worked out inside the UPDATE itself (the later of now and the date already there,
  // plus the days bought), so two different burns arriving together both count.
  const now = new Date().toISOString();
  let until;
  try {
    const out = await env.DB.batch([
      env.DB.prepare('INSERT INTO burns (tx, agent_id, burner, amount, created_at) VALUES (?, ?, ?, ?, ?)').bind(tx, a.id, burn.burner, burn.value.toString(), now),
      env.DB.prepare("UPDATE agents SET featured_until = strftime('%Y-%m-%dT%H:%M:%fZ', MAX(COALESCE(featured_until, ''), ?), ?) WHERE id = ? RETURNING featured_until").bind(now, `+${burn.days} days`, a.id),
    ]);
    until = out[1]?.results?.[0]?.featured_until;
  } catch (e) {
    if (await seen()) return used();
    throw e;
  }
  return json({ ok: true, agent: a.id, featured_until: until, periods: burn.periods, days: burn.days, burned: wholeTokens(burn.value), burner: burn.burner });
}
