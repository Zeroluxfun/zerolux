// Standing orders: an agent that works without being asked each time.
//
// A customer sets one up once, with the request it should work on and when: every hour, every day, every week, or when
// a coin's price crosses a line. From then on this Worker's timer runs the agent for them. Each run is an ordinary paid
// run, paid from the customer's Zero Lux credit (the credit bought by card, src/credits.js) at the agent's price, so the
// agent, its books and its owner cannot tell it from any other. Nobody is present to read the answer, so it is kept for
// the customer's inbox (/inbox) for 30 days and sent to wherever they asked (src/deliver.js): a Discord or Slack webhook, Telegram.
//
//   POST /api/subs       x-credits, {"agent", "input", "every": "hour"|"day"|"week"|"watch", "hour"?, "dow"?,
//                                    "watch"?: {"coin", "when": "above"|"below", "price"}, "webhook"?}
//   GET  /api/subs       x-credits                       -> the account's standing orders and their latest results
//   POST /api/subs/:id   x-credits, {"action": "pause"|"resume"|"cancel"}
//
// It stops by itself, and says why, when the credit no longer covers a run, when the agent's price rises above the
// price it was set up at, when the agent leaves the line, or after three runs in a row that did not deliver.
import { verifiedOnly } from './tap-api.js';
import { json, allow, clientKey, readJson } from './line.js';
import { cardOn, spendRun, afterCard, balanceOf, sha, isAccount } from './credits.js';
import { hire, safeUrl } from './run.js';
import { findAgent } from './api.js';
import { withReview } from './reviews.js';
import { coinPrices, WATCH_COINS } from './tools.js';
import { keepFiles } from './files.js';
import { deliver } from './deliver.js';

const MAX_ORDERS = 10; // standing orders one credit account may have switched on
const PER_TICK = 4; // runs started by one tick of the timer
const KEEP_DAYS = 30; // how long a result stays in the inbox
const MAX_FAILS = 3, MAX_TRIES = 8;
const EVERY = ['hour', 'day', 'week', 'watch'];
const now = () => new Date().toISOString();
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const dollars = (units) => '$' + (Number(units) / 1e6).toFixed(2);
const WHY = {
  credit: 'Stopped: your credit no longer covers a run. Add credit and switch it back on.',
  hold: 'Stopped: your credit is on hold.',
  price: 'Stopped: the agent\'s price went up. Switch it back on to accept the new price.',
  agent: 'Stopped: the agent is no longer taking runs.',
  failing: 'Stopped: three runs in a row did not deliver. Nothing was charged for them beyond what a failed run costs.',
};

// When a schedule next comes round, strictly after `from`. Hours are UTC; the page turns the customer's own time into them.
export function nextAt(s, from = Date.now()) {
  const d = new Date(from); d.setUTCMinutes(0, 0, 0);
  if (s.every === 'hour') { d.setUTCHours(d.getUTCHours() + 1); return d.toISOString(); }
  d.setUTCHours(Number(s.hour) || 0);
  for (let i = 0; i < 9; i++) { if (d.getTime() > from && (s.every !== 'week' || d.getUTCDay() === Number(s.dow))) break; d.setUTCDate(d.getUTCDate() + 1); }
  return d.toISOString();
}
const cleanWatch = (w) => {
  const coin = String(w?.coin || '').toLowerCase(), when = w?.when === 'below' ? 'below' : w?.when === 'above' ? 'above' : null, price = Number(w?.price);
  return WATCH_COINS.includes(coin) && when && Number.isFinite(price) && price > 0 && price < 1e9 ? { coin, when, price: Number(price.toPrecision(8)) } : null;
};
const view = (s) => ({
  id: s.id, agent_id: s.agent_id, agent: s.agent_name ?? null, input: s.input, every: s.every, hour: s.hour, dow: s.dow, watch: s.watch ? JSON.parse(s.watch) : null,
  status: s.status, note: s.reason ? WHY[s.reason] || null : null, price: String(s.max_price), webhook: !!s.webhook, runs: s.runs, next_at: s.status === 'on' && s.every !== 'watch' ? s.next_at : null, last_at: s.last_at, created_at: s.created_at,
});
async function who(request) { const secret = request.headers.get('x-credits') || ''; return isAccount(secret) ? sha(secret) : null; }

export async function createSub(request, env) {
  if (!cardOn(env)) return json({ error: 'Standing orders are paid from card credit, and card payment is not switched on.' }, 503);
  const account = await who(request), body = await readJson(request);
  if (!account || !body) return json({ error: 'Send JSON with your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'subnew:' + clientKey(request), 40))) return json({ error: 'That is enough new standing orders for today.' }, 429);
  const input = String(body.input ?? '').trim().slice(0, 4000), every = String(body.every || '');
  if (!input) return json({ error: 'Write what the agent should work on each time.' }, 400);
  if (!EVERY.includes(every)) return json({ error: 'Choose how often: hour, day, week or watch.' }, 400);
  const hour = Number(body.hour ?? 0), dow = Number(body.dow ?? 0), watch = every === 'watch' ? cleanWatch(body.watch) : null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(dow) || dow < 0 || dow > 6) return json({ error: 'That time is not valid.' }, 400);
  if (every === 'watch' && !watch) return json({ error: 'A price watch needs a coin from the list, "above" or "below", and a price.' }, 400);
  let webhook = null;
  if (body.webhook) { const u = safeUrl(String(body.webhook).trim().slice(0, 300)); if (!u) return json({ error: 'The webhook has to be a public https address.' }, 400); webhook = u.href; }
  const a = await findAgent(env, String(body.agent));
  if (!a || a.status !== 'live') return json({ error: 'That agent is not taking runs.' }, 409);
  if (await verifiedOnly(env, a.id)) return json({ error: 'That agent takes work only from verified agents, one signed request at a time.' }, 409);
  if ((await balanceOf(env, account)) < Number(a.price)) return json({ error: `Your credit does not cover one run (${dollars(a.price)}). Add credit by card first.`, topup: true }, 402);
  const id = hexOf(crypto.getRandomValues(new Uint8Array(16))), t = now();
  // A schedule runs once straight away, so its first result is there to read; a watch waits for its price.
  const made = await env.DB.prepare(
    `INSERT INTO subs (id, account, agent_id, input, every, hour, dow, watch, armed, max_price, webhook, status, fails, runs, next_at, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, 'on', 0, 0, ?11, ?11 WHERE (SELECT COUNT(*) FROM subs WHERE account = ?2 AND status = 'on') < ?12`,
  ).bind(id, account, a.id, input, every, hour, dow, watch ? JSON.stringify(watch) : null, Number(a.price), webhook, t, MAX_ORDERS).run();
  if (!made.meta.changes) return json({ error: `An account can have ${MAX_ORDERS} standing orders switched on. Cancel one first.` }, 400);
  await keepFiles(env, input, 366); // files the request names stay for a year of runs
  return json({ ok: true, sub: view({ ...(await env.DB.prepare('SELECT * FROM subs WHERE id = ?').bind(id).first()), agent_name: a.name }) });
}

export async function listSubs(request, env) {
  const account = await who(request); if (!account) return json({ error: 'Send your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'sublist:' + clientKey(request), 3000))) return json({ error: 'Too many requests.' }, 429);
  const subs = (await env.DB.prepare("SELECT s.*, a.name AS agent_name FROM subs s JOIN agents a ON a.id = s.agent_id WHERE s.account = ? AND s.status != 'ended' ORDER BY s.created_at DESC LIMIT 40").bind(account).all()).results;
  const got = (await env.DB.prepare("SELECT d.id, d.sub_id, d.agent_id, a.name AS agent, d.run_id, d.status, d.output, d.paid, d.error, d.note, d.review, d.created_at, d.finished_at, (SELECT 1 FROM reviews v WHERE v.run_id = d.run_id) AS reviewed FROM deliveries d JOIN agents a ON a.id = d.agent_id WHERE d.account = ? AND d.status != 'pending' ORDER BY d.created_at DESC LIMIT 30").bind(account).all()).results;
  return json({
    subs: subs.map(view), watch_coins: WATCH_COINS, keep_days: KEEP_DAYS,
    results: got.map((d) => ({ id: d.id, sub: d.sub_id, agent_id: d.agent_id, agent: d.agent, run: d.run_id, status: d.status, output: d.output, paid: d.paid == null ? null : String(d.paid), error: d.error, note: d.note, review: d.review && !d.reviewed ? { token: d.review } : null, at: d.finished_at || d.created_at })),
  });
}

export async function changeSub(request, env, id) {
  const account = await who(request), body = await readJson(request);
  if (!account || !body) return json({ error: 'Send JSON with your credit code in x-credits.' }, 400);
  const s = await env.DB.prepare("SELECT * FROM subs WHERE id = ? AND account = ? AND status != 'ended'").bind(id, account).first();
  if (!s) return json({ error: 'No standing order with that id under this credit code.' }, 404);
  if (body.action === 'cancel') await env.DB.prepare("UPDATE subs SET status = 'ended', reason = NULL WHERE id = ?").bind(id).run();
  else if (body.action === 'pause') await env.DB.prepare("UPDATE subs SET status = 'paused', reason = NULL WHERE id = ?").bind(id).run();
  else if (body.action === 'resume') {
    const a = await findAgent(env, String(s.agent_id));
    if (!a || a.status !== 'live') return json({ error: 'That agent is not taking runs.' }, 409);
    if ((await balanceOf(env, account)) < Number(a.price)) return json({ error: `Your credit does not cover one run (${dollars(a.price)}). Add credit by card first.`, topup: true }, 402);
    const on = await env.DB.prepare(`UPDATE subs SET status = 'on', reason = NULL, fails = 0, armed = 0, max_price = ?1, next_at = ?2 WHERE id = ?3 AND (SELECT COUNT(*) FROM subs WHERE account = ?4 AND status = 'on') < ?5`)
      .bind(Number(a.price), s.every === 'watch' ? now() : nextAt(s), id, account, MAX_ORDERS).run();
    if (!on.meta.changes) return json({ error: `An account can have ${MAX_ORDERS} standing orders switched on. Cancel one first.` }, 400);
  } else return json({ error: 'action is pause, resume or cancel.' }, 400);
  const row = await env.DB.prepare('SELECT s.*, a.name AS agent_name FROM subs s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?').bind(id).first();
  return json({ ok: true, sub: view(row) });
}

// ---- the timer ----
const stop = (env, id, reason) => env.DB.prepare("UPDATE subs SET status = 'paused', reason = ? WHERE id = ? AND status = 'on'").bind(reason, id).run();

// One slot of one standing order: the row that says a run is owed, written once. `slot` names it (the time it was due).
async function open(env, s, slot, note) {
  const id = s.id + ':' + slot;
  const ticket = hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zerolux standing order|' + id))).slice(0, 32);
  const input = note ? `${s.input}\n\n(${note})` : s.input;
  await env.DB.prepare("INSERT OR IGNORE INTO deliveries (id, sub_id, account, agent_id, ticket, input, note, status, tries, sent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)").bind(id, s.id, s.account, s.agent_id, ticket, input, note || null, now()).run();
  return id;
}

async function attempt(env, ctx, id) {
  const d = await env.DB.prepare("SELECT d.*, s.max_price, s.webhook, s.status AS sub_status FROM deliveries d JOIN subs s ON s.id = d.sub_id WHERE d.id = ? AND d.status = 'pending'").bind(id).first();
  if (!d) return;
  // `reason` stops the order and says why; `quiet` is a slot dropped without counting against the order.
  const fail = async (error, reason, quiet = false) => {
    await env.DB.prepare("UPDATE deliveries SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(error, now(), id).run();
    let why = reason;
    if (!reason && !quiet) { const f = await env.DB.prepare('UPDATE subs SET fails = fails + 1 WHERE id = ? RETURNING fails').bind(d.sub_id).first(); if (f && f.fails >= MAX_FAILS) why = 'failing'; }
    // The customer is told when an order stops by itself, since nothing else will tell them.
    if (why && (await stop(env, d.sub_id, why)).meta.changes) await deliver(env, d.account, { title: `${agent?.name || 'Your agent'}: standing order stopped`, body: WHY[why], link: 'https://zerolux.fun/inbox' }, d.webhook);
  };
  const later = async () => { const t = await env.DB.prepare('UPDATE deliveries SET tries = tries + 1 WHERE id = ? RETURNING tries').bind(id).first(); if (t && t.tries >= MAX_TRIES) await fail('The run did not finish. Anything charged for it comes back to your credit.'); };
  const agent = await findAgent(env, String(d.agent_id));
  // Checks made only before a run exists for this slot: once it is paid for, it is seen through.
  const begun = await env.DB.prepare('SELECT 1 FROM credit_events WHERE account = ? AND instr(meta, ?) > 0').bind(d.account, `"slot":"${id}"`).first();
  if (!begun) {
    if (d.sub_status !== 'on') return fail('The standing order was stopped before this run.', null, true);
    if (!agent || agent.status !== 'live') return fail(WHY.agent, 'agent');
    if (Number(agent.price) > d.max_price) return fail(WHY.price, 'price');
  }
  if (!agent) return fail(WHY.agent, 'agent');
  // The request the run path reads, made here rather than sent over the network. Its limits are counted per credit account.
  const request = new Request(`https://zerolux.fun/a/${agent.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': 'order-' + d.account.slice(0, 20) }, body: JSON.stringify({ input: d.input }) });
  let res;
  try {
    const paid = await spendRun(request, env, agent, d.input, {
      account: d.account, seed: `order|${d.account}|${agent.id}|${d.ticket}`, meta: { sub: d.sub_id, slot: id }, admit: async () => null,
      held: () => json({ stop: 'hold' }, 403), poor: async () => json({ stop: 'credit' }, 402),
    });
    if (paid.reply) {
      const why = await paid.reply.json().catch(() => ({}));
      return why.stop ? fail(WHY[why.stop], why.stop) : later();
    }
    res = await withReview(env, await hire(request, env, ctx, agent, { pay: paid.pay }));
    await afterCard(env, request);
  } catch { return later(); }
  const out = await res.json().catch(() => ({}));
  if (res.ok && typeof out.output === 'string') {
    await env.DB.prepare("UPDATE deliveries SET status = 'done', output = ?, paid = ?, run_id = ?, review = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(out.output, Number(out.paid) || 0, out.run || null, out.review?.token || null, now(), id).run();
    await env.DB.prepare('UPDATE subs SET runs = runs + 1, fails = 0, last_at = ? WHERE id = ?').bind(now(), d.sub_id).run();
    const sent = await deliver(env, d.account, { title: agent.name + (d.note ? ' · ' + d.note : ''), body: out.output, link: 'https://zerolux.fun/inbox' }, d.webhook);
    if (sent.webhook || sent.telegram) await env.DB.prepare('UPDATE deliveries SET sent = 1 WHERE id = ?').bind(id).run();
    return;
  }
  if (out.again) return later();
  return fail(String(out.error || 'The run did not deliver.').slice(0, 400));
}

export async function subsTick(env, ctx) {
  if (!cardOn(env)) return;
  const t = now(), due = [];
  // Runs already owed and not finished (a payment still confirming, a run still working) come first.
  for (const d of (await env.DB.prepare("SELECT id FROM deliveries WHERE status = 'pending' ORDER BY created_at LIMIT ?").bind(PER_TICK).all()).results) due.push(d.id);
  // Schedules whose time has come. The next time is set as the slot is opened, so a slot is never opened twice.
  const sched = (await env.DB.prepare("SELECT * FROM subs WHERE status = 'on' AND every != 'watch' AND next_at <= ? ORDER BY next_at LIMIT ?").bind(t, Math.max(0, PER_TICK - due.length)).all()).results;
  for (const s of sched) {
    const moved = await env.DB.prepare("UPDATE subs SET next_at = ? WHERE id = ? AND next_at = ? AND status = 'on'").bind(nextAt(s), s.id, s.next_at).run();
    if (moved.meta.changes) due.push(await open(env, s, s.next_at.slice(0, 16), null));
  }
  // Price watches. One fires when its price is on the far side of its line, then waits for the price to come back before it can fire again.
  const watches = (await env.DB.prepare("SELECT * FROM subs WHERE status = 'on' AND every = 'watch' LIMIT 300").all()).results;
  if (watches.length) {
    const prices = await coinPrices(watches.map((s) => JSON.parse(s.watch).coin)).catch(() => ({}));
    for (const s of watches) {
      const w = JSON.parse(s.watch), p = prices[w.coin]; if (p == null) continue;
      const hit = w.when === 'above' ? p >= w.price : p <= w.price;
      if (hit && s.armed && due.length < PER_TICK) {
        const moved = await env.DB.prepare('UPDATE subs SET armed = 0 WHERE id = ? AND armed = 1').bind(s.id).run();
        if (moved.meta.changes) due.push(await open(env, s, t.slice(0, 16), `Price watch: ${w.coin.toUpperCase()} is ${w.when} ${w.price} US dollars. It is ${Number(p.toPrecision(6))} now.`));
      } else if (!hit && !s.armed) await env.DB.prepare('UPDATE subs SET armed = 1 WHERE id = ?').bind(s.id).run();
    }
  }
  await env.DB.prepare('DELETE FROM deliveries WHERE created_at < ?').bind(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()).run();
  const done = await Promise.allSettled(due.map((id) => attempt(env, ctx, id)));
  for (let i = 0; i < done.length; i++) {
    if (done[i].status !== 'rejected') continue;
    console.error('standing order run failed', done[i].reason?.name, String(done[i].reason?.message || '').slice(0, 200));
    // Something broke on our side. It is tried again on later ticks, and given up on after a few, so it cannot go round for ever.
    await env.DB.prepare("UPDATE deliveries SET tries = tries + 1, status = CASE WHEN tries + 1 >= ?1 THEN 'failed' ELSE status END, error = CASE WHEN tries + 1 >= ?1 THEN 'The run did not finish. Anything charged for it comes back to your credit.' ELSE error END, finished_at = CASE WHEN tries + 1 >= ?1 THEN ?2 ELSE finished_at END WHERE id = ?3 AND status = 'pending'").bind(MAX_TRIES, now(), due[i]).run().catch(() => {});
  }
}
