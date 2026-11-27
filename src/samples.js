// Free samples. An agent's owner can let each visitor try the agent once without paying.
//
// Nothing about a sample is free to run, so somebody pays for it: the owner. A sample is an ordinary paid run whose
// price comes out of the owner's own Zero Lux credit (the credit anyone buys by card, src/credits.js) instead of the
// visitor's. Zero Lux's paying wallet pays the agent's wallet the full price in USDG, the run is metered like any
// other, and what is left after its cost and the fee is the owner's profit again. So a sample costs its owner the
// run's cost, the fee on it and the card fee they paid on the credit.
//
//   POST /api/agents/:id/sample  x-credits: <the owner's credit code>, {"on", "per_day", "time", "signature"}
//        (with "prepare": true it returns the exact words for the owner's wallet to sign; no transaction, no gas)
//   POST /a/:id/run              x-sample: 1, {"input", "ticket"}   -> the visitor's one free run
//
// Limits: one sample per visitor network per agent, ever; `per_day` samples a day per agent (1 to 200), set by the
// owner; and never more than the owner's credit holds. Sample runs get no review (src/reviews.js).
import { recoverMessageAddress } from 'viem';
import { reader, walletAbi } from './chain.js';
import { json, allow, clientKey, readJson, today } from './line.js';
import { timeOk } from './profile.js';
import { cardOn, spendRun, balanceOf, sha, isAccount } from './credits.js';

const FOREVER = '9999-12-31'; // the day used in `limits` for rows that are flags, not daily counts
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const dayKey = (id) => 'samples:a' + id;
const GONE = 'The free sample for this agent is not available right now.';

export const sampleMessage = ({ id, on, per_day, account, time }) =>
  `Zero Lux: free sample for agent ${id}\nfree sample: ${on ? 'on' : 'off'}\nat most a day: ${per_day}\npaid from the credit account: ${account || 'none'}\ntime: ${time}`;

// Whether each agent in `rows` has a free sample to give right now, attached as row.sample. A missing table reads as none.
export async function samplesFor(env, rows) {
  if (!rows.length) return;
  const got = cardOn(env) ? (await env.DB.prepare(
    `SELECT s.agent_id, s.per_day, s.enabled, (SELECT COALESCE(SUM(amount), 0) FROM credit_events e WHERE e.account = s.account) AS bal,
       COALESCE((SELECT n FROM limits WHERE k = 'samples:a' || s.agent_id AND day = ?), 0) AS used FROM samples s`,
  ).bind(today()).all().catch(() => ({ results: [] }))).results : [];
  const by = new Map(got.map((s) => [s.agent_id, s]));
  for (const a of rows) {
    const s = by.get(a.id);
    a.sample = s ? { on: !!s.enabled, per_day: s.per_day, used_today: Math.min(s.used, s.per_day), funded: s.bal >= a.price, available: !!s.enabled && a.status === 'live' && s.bal >= a.price && s.used < s.per_day } : null;
  }
}

// A visitor's free run. Returns { pay } or { reply }, like a run paid from credit.
export async function samplePay(request, env, agent, body, input) {
  if (!cardOn(env)) return { reply: json({ error: GONE }, 503) };
  const ticket = String(body?.ticket || '');
  if (!/^[0-9a-f]{32,64}$/.test(ticket)) return { reply: json({ error: 'A free sample needs a "ticket" (32 to 64 hex characters) in the body.' }, 400) };
  const s = await env.DB.prepare('SELECT account, per_day FROM samples WHERE agent_id = ? AND enabled = 1').bind(agent.id).first().catch(() => null);
  if (!s || !isAccount(s.account)) return { reply: json({ error: 'This agent does not offer a free sample.', sample: 'off' }, 409) };
  const flag = `sample:${agent.id}:${clientKey(request)}`;
  const revoke = async () => {
    await env.DB.prepare('DELETE FROM limits WHERE k = ? AND day = ?').bind(flag, FOREVER).run();
    await env.DB.prepare('UPDATE limits SET n = MAX(0, n - 1) WHERE k = ? AND day = ?').bind(dayKey(agent.id), today()).run();
  };
  return spendRun(request, env, agent, input, {
    account: s.account, seed: `sample|${s.account}|${agent.id}|${ticket}`, meta: { sample: 1 }, revoke,
    admit: async () => {
      if (!(await allow(env, 'samplerun:' + clientKey(request), 20))) return json({ error: 'Too many free samples from this network today.' }, 429);
      // One per visitor, for good: the flag is only written the first time.
      const first = await env.DB.prepare('INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, ?, 1)').bind(flag, FOREVER).run();
      if (!first.meta.changes) return json({ error: 'You have already had the free sample for this agent. To run it again, pay for a run.', sample: 'used' }, 409);
      if (!(await allow(env, dayKey(agent.id), s.per_day))) {
        await revoke(); // the visitor keeps their one sample, and the refused try is not counted against the day
        return json({ error: 'Today\'s free samples for this agent are gone. Come back tomorrow, or pay for a run.', sample: 'gone' }, 429);
      }
      return null;
    },
    held: () => json({ error: GONE, sample: 'gone' }, 409),
    poor: async () => json({ error: GONE, sample: 'gone' }, 409),
  });
}

// The owner switches the free sample on or off. Proved the same way as a profile change: a message signed by the address
// the agent's wallet contract names as its owner. The credit code in x-credits says which credit pays for the samples;
// only its SHA-256 is kept, so the code itself is never stored.
export async function setSample(request, env, a) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  if (!(await allow(env, 'sampleset:' + clientKey(request), 60))) return json({ error: 'That is enough changes for today. Come back tomorrow.' }, 429);
  const on = body.on === true, per_day = Number(body.per_day ?? 10);
  if (!Number.isInteger(per_day) || per_day < 1 || per_day > 200) return json({ error: 'Choose between 1 and 200 free samples a day.' }, 400);
  let account = null;
  if (on) {
    if (!cardOn(env)) return json({ error: 'Free samples are paid from card credit, and card payment is not switched on.' }, 503);
    const secret = request.headers.get('x-credits') || '';
    if (!isAccount(secret)) return json({ error: 'Free samples are paid from your Zero Lux credit. Buy credit by card on this page first.' }, 400);
    account = await sha(secret);
    if ((await balanceOf(env, account)) < Number(a.price)) return json({ error: 'Your credit does not cover one run of this agent. Add credit by card first.' }, 400);
  }
  if (body.prepare === true) { const time = new Date().toISOString(); return json({ ok: true, time, on, per_day, message: sampleMessage({ id: a.id, on, per_day, account, time }) }); }
  if (!timeOk(body.time)) return json({ error: 'That signature is too old. Press save again.' }, 400);
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) return json({ error: 'The signature is missing.' }, 400);
  const prev = await env.DB.prepare('SELECT signed_at FROM samples WHERE agent_id = ?').bind(a.id).first();
  if (prev?.signed_at && body.time <= prev.signed_at) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);
  const message = sampleMessage({ id: a.id, on, per_day, account, time: body.time });
  const c = reader(env);
  let owner;
  try { owner = await c.readContract({ address: a.wallet, abi: walletAbi, functionName: 'owner' }); }
  catch { return json({ error: 'The chain is not answering. Nothing was saved: try again in a minute.' }, 502); }
  let ok = false;
  try { ok = signature.length === 132 && same(await recoverMessageAddress({ message, signature }), owner); } catch {}
  if (!ok) { try { ok = await c.verifyMessage({ address: owner, message, signature }); } catch { ok = false; } }
  if (!ok) return json({ error: 'That was not signed by the wallet that owns this agent (' + owner.slice(0, 6) + '…' + owner.slice(-4) + ').' }, 403);
  const done = await env.DB.prepare(
    `INSERT INTO samples (agent_id, account, per_day, enabled, signer, signed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (agent_id) DO UPDATE SET account = COALESCE(excluded.account, samples.account), per_day = excluded.per_day, enabled = excluded.enabled, signer = excluded.signer, signed_at = excluded.signed_at, updated_at = excluded.updated_at
     WHERE samples.signed_at IS NULL OR samples.signed_at < excluded.signed_at`,
  ).bind(a.id, account, per_day, on ? 1 : 0, owner, body.time, new Date().toISOString()).run();
  if (!done.meta.changes) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);
  return json({ ok: true, agent: a.id, on, per_day });
}
