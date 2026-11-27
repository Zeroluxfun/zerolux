// Paying by card. A visitor with no wallet buys credit through Stripe's hosted checkout and spends it on runs.
//
// Zero Lux takes the card money, so Zero Lux pays the agent: each run bought with credit is paid to the agent's wallet in
// USDG from a wallet Zero Lux funds (CARD_PAYER_KEY), with the same signed payment any customer would send. Everything
// after that is the ordinary paid-run path: the agent, its books and its owner cannot tell the two apart.
//
// A credit account is the SHA-256 of a secret the buyer's browser makes and keeps. There are no sign-ins: whoever holds
// the secret can spend the credit. A balance is never stored; it is the sum of the account's rows in credit_events
// (a top-up adds, a run subtracts, a run that did not happen adds back), so it cannot drift from its own history.
//
//   POST /api/credits/checkout  {"account", "pack", "back"}   -> {"url"}: Stripe's checkout page for that pack
//   POST /api/credits/confirm   {"session"}                   -> credits a paid checkout (also done by the webhook)
//   POST /api/stripe/webhook                                  -> Stripe's signed notices
//   GET  /api/credits           x-credits: <secret>           -> {"balance"}
//   POST /a/:id/run             x-credits: <secret>, {"input", "ticket"} -> a run paid from credit
//
// Secrets: STRIPE_KEY (Stripe secret key), STRIPE_WEBHOOK_SECRET, CARD_PAYER_KEY. Card payment is off unless the first
// and the last are set. Card data never reaches this Worker: Stripe's page collects it.
import { keccak256, concat, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { reader, usdgAbi, USDG, USDG_DOMAIN } from './chain.js';
import { json, allow, clientKey } from './line.js';

// What a buyer gets (USDG units, six decimals) and is charged (cents). The difference covers the card processor's fee.
const FEE_BPS = 400, FEE_FIXED = 30; // 4% + 30 cents on top of the credit
export const PACKS = [5, 10, 25].map((usd) => ({ id: String(usd), credit: usd * 1_000_000, charge: Math.ceil(usd * 100 * (1 + FEE_BPS / 10_000)) + FEE_FIXED }));
const MAX_BALANCE = 100_000_000; // an account may hold at most $100 of credit
const AUTH_FIELDS = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
];
const now = () => new Date().toISOString();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export const isAccount = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const dollars = (units) => '$' + (Number(units) / 1e6).toFixed(2);

export const cardOn = (env) => !!(env.STRIPE_KEY && env.CARD_PAYER_KEY);
export const cardPayer = (env) => privateKeyToAccount(env.CARD_PAYER_KEY);
export const cardConfig = (env) => ({ on: cardOn(env), packs: PACKS.map((p) => ({ id: p.id, credit: String(p.credit), charge_cents: p.charge })), max_balance: String(MAX_BALANCE) });

export const balanceOf = async (env, account) => Number((await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM credit_events WHERE account = ?').bind(account).first()).n);
const frozen = async (env, account) => !!(await env.DB.prepare("SELECT 1 FROM credit_events WHERE account = ? AND kind = 'freeze' LIMIT 1").bind(account).first());

// ---- Stripe ----
// Only when testing on this machine may the API be somewhere else (a stand-in server).
const stripeBase = (env) => (env.DEV === '1' && env.STRIPE_API ? env.STRIPE_API : 'https://api.stripe.com');
async function stripe(env, method, path, form) {
  const res = await fetch(stripeBase(env) + path, {
    method, headers: { authorization: 'Bearer ' + env.STRIPE_KEY, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('stripe ' + res.status + ' ' + (data.error?.code || data.error?.type || ''));
  return data;
}

// A paid checkout becomes credit exactly once: the row's key is the checkout's own id.
async function grant(env, session) {
  const account = session.client_reference_id, credit = Number(session.metadata?.credit);
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || !isAccount(account)) return { ok: false };
  const pack = PACKS.find((p) => p.credit === credit);
  // The amount Stripe says was paid has to be the price of the pack the session names.
  if (!pack || session.currency !== 'usd' || Number(session.amount_total) !== pack.charge) return { ok: false };
  const made = await env.DB.prepare("INSERT OR IGNORE INTO credit_events (id, account, kind, amount, ref, state, created_at) VALUES (?, ?, 'topup', ?, ?, 'closed', ?)")
    .bind('top:' + session.id, account, credit, String(session.payment_intent || ''), now()).run();
  return { ok: true, account, credit, fresh: made.meta.changes > 0 };
}

export async function checkout(request, env) {
  if (!cardOn(env)) return json({ error: 'Card payment is not switched on.' }, 503);
  const body = await request.json().catch(() => null);
  const pack = PACKS.find((p) => p.id === String(body?.pack));
  if (!body || !isAccount(body.account) || !pack) return json({ error: 'Choose an amount of credit to buy.' }, 400);
  // Where the buyer lands afterwards: an agent's page on this site and nowhere else.
  // (or the card payment window the button on another website opens).
  const back = /^\/a\/\d{1,9}$/.test(String(body.back || '')) || /^\/pay\?agent=\d{1,9}$/.test(String(body.back || '')) ? body.back : '/floor';
  const join = back.includes('?') ? '&' : '?';
  if (!(await allow(env, 'cardbuy:' + clientKey(request), 30))) return json({ error: 'Too many card checkouts from this network today.' }, 429);
  if (await frozen(env, body.account)) return json({ error: 'This credit is on hold because a card payment that funded it was disputed.' }, 403);
  if ((await balanceOf(env, body.account)) + pack.credit > MAX_BALANCE) return json({ error: `An account can hold at most ${dollars(MAX_BALANCE)} of credit. Spend some first.` }, 400);
  // Credit is not sold while Zero Lux's own wallet could not pay for even a small run.
  const float = await reader(env).readContract({ address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [cardPayer(env).address] }).catch(() => null);
  if (float == null || float < 1_000_000n) return json({ error: 'Card payment is paused for a moment. Nothing was charged. Try again later.' }, 503);
  // Where Stripe sends the buyer back: this site. (On a developer's machine, the address the page was opened at.)
  const origin = env.DEV === '1' && /^http:\/\/localhost:\d+$/.test(env.DEV_ORIGIN || '') ? env.DEV_ORIGIN : new URL(request.url).origin;
  let s;
  try {
    s = await stripe(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', client_reference_id: body.account,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(pack.charge),
      'line_items[0][price_data][product_data][name]': `Zero Lux credit: ${dollars(pack.credit)}`,
      'line_items[0][price_data][product_data][description]': `${dollars(pack.credit)} to spend on any agent at zerolux.fun. The price includes a card processing fee of $${((pack.charge - pack.credit / 10_000) / 100).toFixed(2)}.`,
      'metadata[credit]': String(pack.credit), 'metadata[account]': body.account,
      'payment_intent_data[metadata][account]': body.account,
      success_url: `${origin}${back}${join}card={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}${back}${join}card=cancelled`,
    });
  } catch { return json({ error: 'The card checkout could not be opened just now. Try again in a moment.' }, 502); }
  return s.url ? json({ url: s.url }) : json({ error: 'The card checkout could not be opened just now. Try again in a moment.' }, 502);
}

// The buyer's page calls this when Stripe sends them back, so the credit shows at once even if the webhook is slow.
// The session is read from Stripe with our own key; nothing the caller says is trusted.
export async function confirm(request, env) {
  if (!cardOn(env)) return json({ error: 'Card payment is not switched on.' }, 503);
  const body = await request.json().catch(() => null);
  const id = String(body?.session || '');
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return json({ error: 'That is not a checkout.' }, 400);
  if (!(await allow(env, 'cardconfirm:' + clientKey(request), 200))) return json({ error: 'Too many requests.' }, 429);
  let s; try { s = await stripe(env, 'GET', '/v1/checkout/sessions/' + id); } catch { return json({ error: 'The payment could not be checked just now. Reload this page in a moment.', again: true }, 502); }
  const g = await grant(env, s);
  if (!g.ok) return json({ error: 'That checkout was not paid.', paid: false }, 402);
  return json({ ok: true, credit: String(g.credit) });
}

const timingSafe = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !cardOn(env)) return json({ error: 'not configured' }, 503);
  const raw = await request.text();
  if (raw.length > 300_000) return json({ error: 'too large' }, 413);
  const head = Object.fromEntries((request.headers.get('stripe-signature') || '').split(',').map((kv) => kv.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(head.t);
  if (!t || !head.v1 || Math.abs(Date.now() / 1000 - t) > 300) return json({ error: 'bad signature' }, 400);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  if (!timingSafe(want, head.v1)) return json({ error: 'bad signature' }, 400);
  let ev; try { ev = JSON.parse(raw); } catch { return json({ error: 'bad body' }, 400); }
  const o = ev.data?.object || {};
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await grant(env, o);
  // A disputed or refunded card payment: the credit it bought is put on hold. What was already spent is Zero Lux's loss.
  if (ev.type === 'charge.dispute.created' || ev.type === 'charge.refunded') {
    const account = o.metadata?.account || (o.payment_intent ? (await env.DB.prepare("SELECT account FROM credit_events WHERE kind = 'topup' AND ref = ?").bind(String(o.payment_intent)).first())?.account : null);
    if (isAccount(account)) await env.DB.prepare("INSERT OR IGNORE INTO credit_events (id, account, kind, amount, ref, state, created_at) VALUES (?, ?, 'freeze', 0, ?, 'closed', ?)").bind('freeze:' + account, account, String(ev.id || ''), now()).run();
  }
  return json({ received: true });
}

export async function balance(request, env) {
  const secret = request.headers.get('x-credits') || '';
  if (!isAccount(secret)) return json({ error: 'Send the credit code in the x-credits header.' }, 400);
  if (!(await allow(env, 'cardbal:' + clientKey(request), 3000))) return json({ error: 'Too many requests.' }, 429);
  const account = await sha(secret);
  await settleCard(env, account);
  return json({ balance: String(await balanceOf(env, account)), on_hold: await frozen(env, account), card: cardOn(env) });
}

// ---- a run paid from credit ----
// Returns { pay } (a payment in the shape the run path reads from an X-PAYMENT header) or { reply } (a Response).
// The run's id depends only on the account, the agent and the buyer's ticket, so sending the same request again
// reaches the same run and is charged once.
export async function cardPay(request, env, agent, body, input) {
  if (!cardOn(env)) return { reply: json({ error: 'Card payment is not switched on.' }, 503) };
  const secret = request.headers.get('x-credits') || '', ticket = String(body?.ticket || '');
  if (!isAccount(secret) || !/^[0-9a-f]{32,64}$/.test(ticket)) return { reply: json({ error: 'A run paid from credit needs the credit code in x-credits and a "ticket" (32 to 64 hex characters) in the body.' }, 400) };
  const account = await sha(secret);
  return spendRun(request, env, agent, input, {
    account, seed: `card|${account}|${agent.id}|${ticket}`,
    admit: async () => ((await allow(env, 'cardrun:' + clientKey(request), 600)) ? null : json({ error: 'Too many runs from this network today. Nothing was charged.' }, 429)),
    held: () => json({ error: 'This credit is on hold because a card payment that funded it was disputed.' }, 403),
    poor: async (value) => json({ error: `Not enough credit: this run costs ${dollars(value)}.`, balance: String(await balanceOf(env, account)), price: String(value), topup: true }, 402),
  });
}
// One run paid out of a credit account: the visitor's own (a card run) or the agent owner's (a free sample, src/samples.js).
// `o.seed` names the run, `o.admit` may refuse a new one (it returns a Response, or null to go on), `o.revoke` undoes
// whatever `admit` counted when the run did not come to exist, and `o.held` / `o.poor` are the refusals for an account
// on hold and one without enough credit. `o.meta` is kept on the spend.
export async function spendRun(request, env, agent, input, o) {
  const account = o.account, payer = cardPayer(env), version = agent.v || 1;
  const nonce = keccak256(stringToHex(o.seed));
  const run = keccak256(concat([payer.address, nonce])), eventId = 'run:' + run;
  let ev = await env.DB.prepare('SELECT amount, meta FROM credit_events WHERE id = ? AND account = ?').bind(eventId, account).first();
  if (!ev) {
    if (!input) return { reply: json({ error: 'Nothing was charged: there was no work in the request.' }, 400) };
    if (agent.status !== 'live') return { reply: json({ error: 'This agent is off the line. Nothing was charged.' }, 409) };
    if (await frozen(env, account)) return { reply: o.held() };
    const value = Number(agent.price);
    if ((await balanceOf(env, account)) < value) return { reply: await o.poor(value) };
    // Zero Lux's own wallet has to be able to pay the agent, or the buyer's credit would be spent on nothing.
    const float = await reader(env).readContract({ address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [payer.address] }).catch(() => null);
    if (float == null) return { reply: json({ error: 'The chain is not answering. Nothing was charged. Try again in a few seconds.', again: false }, 503) };
    if (float < BigInt(value)) return { reply: json({ error: 'Paying from credit is paused for a moment. Nothing was charged, and your credit is untouched.' }, 503) };
    const refused = await o.admit(); if (refused) return { reply: refused };
    const meta = JSON.stringify({ value: String(value), validBefore: String(Math.floor(Date.now() / 1000) + 840), agent: agent.id, ...(o.meta || {}) });
    // One statement: the row is written only if the account's rows still add up to at least the price.
    const made = await env.DB.prepare(
      `INSERT INTO credit_events (id, account, kind, amount, ref, meta, state, created_at)
       SELECT ?1, ?2, 'spend', -?3, ?4, ?5, 'open', ?6 WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_events WHERE account = ?2) >= ?3
       ON CONFLICT (id) DO NOTHING`,
    ).bind(eventId, account, value, run, meta, now()).run();
    ev = await env.DB.prepare('SELECT amount, meta FROM credit_events WHERE id = ? AND account = ?').bind(eventId, account).first();
    if (!made.meta.changes && !ev) { if (o.revoke) await o.revoke().catch(() => {}); return { reply: await o.poor(value) }; }
  }
  const m = JSON.parse(ev.meta);
  const form = version >= 3 ? 'ReceiveWithAuthorization' : 'TransferWithAuthorization';
  const message = { from: payer.address, to: agent.wallet, value: BigInt(m.value), validAfter: 0n, validBefore: BigInt(m.validBefore), nonce };
  const signature = await payer.signTypedData({ domain: USDG_DOMAIN, types: { [form]: AUTH_FIELDS }, primaryType: form, message });
  seen.set(request, { account, run, revoke: o.revoke });
  return { pay: { ...message, nonce: nonce.toLowerCase(), signature }, account, run };
}
// After the run path has answered a request paid from credit: if it was refused before a run existed, the spend comes off at once.
const seen = new WeakMap();
export async function afterCard(env, request) { const card = seen.get(request); if (card) await undoCard(env, card).catch(() => {}); }

// Closes the account's open spends against what became of their runs. A run that never happened, or that was taken
// and then did not deliver, gives the credit back, once: the row that gives it back is keyed by the run.
//   no run row            -> the request was refused before anything was paid: the spend is simply removed
//   void                  -> the payment was never made: all of it back
//   forfeit, failed       -> paid, nothing delivered: all of it back
//   refunded              -> nothing delivered and the wallet sent money back: what it sent back
//   ran, unpaid, billed   -> delivered: nothing back
export async function settleCard(env, account) {
  const open = (await env.DB.prepare(
    `SELECT e.id, e.account, e.amount, e.ref, e.created_at, r.status, r.refunded, r.paid FROM credit_events e LEFT JOIN runs r ON r.id = e.ref
     WHERE e.kind = 'spend' AND e.state = 'open' ${account ? 'AND e.account = ?' : ''} ORDER BY e.created_at LIMIT 40`,
  ).bind(...(account ? [account] : [])).all()).results;
  for (const e of open) {
    const close = () => env.DB.prepare("UPDATE credit_events SET state = 'closed' WHERE id = ?").bind(e.id).run();
    const back = async (amount) => {
      if (amount > 0) await env.DB.prepare("INSERT OR IGNORE INTO credit_events (id, account, kind, amount, ref, state, created_at) VALUES (?, ?, 'back', ?, ?, 'closed', ?)").bind('back:' + e.ref, e.account, Math.min(amount, -e.amount), e.ref, now()).run();
      await close();
    };
    if (!e.status) {
      // Given a moment, in case the run row is still being written by the request that made this spend.
      if (Date.now() - Date.parse(e.created_at) > 20_000) await env.DB.prepare("DELETE FROM credit_events WHERE id = ? AND state = 'open' AND NOT EXISTS (SELECT 1 FROM runs WHERE id = ?)").bind(e.id, e.ref).run();
    } else if (['void', 'forfeit', 'failed'].includes(e.status)) await back(-e.amount);
    else if (e.status === 'refunded') { if (e.refunded != null) await back(Number(e.refunded)); else if (Date.now() - Date.parse(e.created_at) > 48 * 3600_000) await back(-e.amount); }
    else if (['ran', 'unpaid', 'billed'].includes(e.status)) await close();
  }
}
// Straight after a request that was refused before a run row existed: take the spend off now rather than in 20 seconds.
export async function undoCard(env, card) {
  const gone = await env.DB.prepare("DELETE FROM credit_events WHERE id = ? AND state = 'open' AND NOT EXISTS (SELECT 1 FROM runs WHERE id = ?)").bind('run:' + card.run, card.run).run();
  // Whatever was counted when this run was let in (a visitor's free sample) is given back with it.
  if (gone.meta.changes && card.revoke) await card.revoke().catch(() => {});
  await settleCard(env, card.account);
}

// For Zero Lux's own eyes (needs the build key): what the paying wallet holds against the credit customers still have.
export async function cardStatus(env) {
  const payer = cardPayer(env).address;
  const float = await reader(env).readContract({ address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [payer] }).catch(() => null);
  const row = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS owed, COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount ELSE 0 END), 0) AS sold, COALESCE(SUM(CASE WHEN kind = 'spend' THEN -amount ELSE 0 END), 0) AS spent, COUNT(DISTINCT account) AS accounts FROM credit_events").first();
  return json({ paying_wallet: payer, wallet_usdg: float == null ? null : String(float), credit_outstanding: String(row.owed), credit_sold: String(row.sold), credit_spent: String(row.spent), accounts: row.accounts, covered: float == null ? null : float >= BigInt(row.owed), low: float == null ? null : float < LOW_FLOAT || float < BigInt(row.owed), alerts: /^https:\/\//.test(env.ALERT_WEBHOOK || ''), live: String(env.STRIPE_KEY || '').includes('_live_') });
}

// Run by the timer. When the wallet that pays agents for card runs is low (under $5, or under the credit customers
// still hold), Zero Lux is told once a day, at the address in ALERT_WEBHOOK (a Discord or Slack incoming webhook).
const LOW_FLOAT = 5_000_000n;
export async function floatAlert(env) {
  // (Only when testing on this machine may the notice go to a plain local address.)
  const hook = String(env.ALERT_WEBHOOK || '');
  if (!cardOn(env) || !(/^https:\/\//.test(hook) || (env.DEV === '1' && /^http:\/\/localhost:\d+\//.test(hook)))) return { sent: false };
  const payer = cardPayer(env).address;
  const float = await reader(env).readContract({ address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [payer] }).catch(() => null);
  if (float == null) return { sent: false };
  const owed = BigInt((await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM credit_events').first()).n);
  if (float >= LOW_FLOAT && float >= owed) return { sent: false, low: false };
  const day = now().slice(0, 10);
  const first = await env.DB.prepare('INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, ?, 1)').bind('floatalert', day).run();
  if (!first.meta.changes) return { sent: false, low: true };
  const text = `Zero Lux: the wallet that pays agents for card runs is low. It holds ${dollars(float)} in USDG and customers hold ${dollars(owed)} of unspent credit. Card runs stop when it is empty. Send USDG on Robinhood Chain to ${payer}.`;
  const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  // A notice that did not go out is tried again on the next tick.
  if (!res || !res.ok) await env.DB.prepare('DELETE FROM limits WHERE k = ? AND day = ?').bind('floatalert', day).run();
  return { sent: !!res?.ok, low: true };
}
