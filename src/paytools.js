// Paid tools: an owner gives an agent tools that charge per call over x402, and a run pays for them out of its own budget.
//
// A paid tool is an https endpoint that answers an unpaid request with 402 and its price (x402, either layout). During
// a run the agent may call it; Zero Lux pays the price in USDG on Robinhood Chain with the same signed payment any x402
// client sends, from a wallet Zero Lux funds (TOOL_PAYER_KEY, or the card wallet if that is not set), and the price
// goes on the run's books exactly like a model call or a search (run.js `paidTool`). The agent's wallet is then charged
// for it with the rest of the run's cost. No key is involved: the payment is the access.
//
// How it is kept:
//  - A paid tool is part of the agent's spec, and so of its public, signed version history (src/revise.js): a name, what
//    it does, its address and method, the most one call may cost (`max`, set by the owner), and the price and payee the
//    endpoint asked for WHEN IT WAS SAVED. A call pays only that payee: an endpoint that starts naming another one is
//    refused until the owner saves again.
//
// What keeps the money safe:
//  - Only USDG on Robinhood Chain, only the "exact" scheme, never more than the owner's ceiling, never more than
//    MAX_CEILING, at most MAX_PAID_CALLS calls a run, and never more in a day over all agents than DAY_CAP.
//  - The run must be able to afford the ceiling before anything is signed, and the ceiling is on its books before the
//    payment leaves. Only runs whose payment the agent's wallet holds may pay (run.js sets `pays`), so what Zero Lux
//    pays out is always covered by money already set aside for that run.
//  - A payment that was signed and sent is charged to the run whether or not the tool then delivered: a signed
//    payment can be collected until it expires, so it is never counted as unspent. Every payment is written to
//    `tool_payments` before it is sent, and a run's public receipt lists them.
import { getAddress, isAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { reader, usdgAbi, USDG, USDG_DOMAIN, CHAIN_ID } from './chain.js';
import { connUrl, RESULT_CHARS } from './connect.js';

export const MAX_PAID = 4; // paid tools per agent
export const MAX_PAID_CALLS = 4; // paid calls per run, over all of them
export const MIN_CEILING = 1_000; // $0.001
export const MAX_CEILING = 1_000_000; // $1.00 a call
const DAY_CAP = 25_000_000; // $25 a day over all agents, unless TOOL_DAY_CAP says otherwise
const BODY_BYTES = 300_000;
const NETWORKS = new Set(['eip155:' + CHAIN_ID, 'robinhood', 'robinhood-chain']);
const TRANSFER = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
];

const payerKey = (env) => env.TOOL_PAYER_KEY || env.CARD_PAYER_KEY || null;
export const paidOn = (env) => !!payerKey(env);
export const toolPayer = (env) => privateKeyToAccount(payerKey(env));
const dayCap = (env) => { const n = Number(env.TOOL_DAY_CAP); return Number.isInteger(n) && n >= 0 ? n : DAY_CAP; };

const line = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const usd = (units) => (Number(units) / 1e6).toFixed(Number(units) % 10_000 === 0 ? 2 : 4);
const b64 = (o) => { let bin = ''; for (const b of new TextEncoder().encode(JSON.stringify(o))) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = (s) => { const bin = atob(String(s).trim()), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new TextDecoder().decode(a); };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// The name the model calls a paid tool by.
export const paidName = (name) => ('paid_' + name).slice(0, 64);

// What the model is told about a paid tool. Its parameters are taken from the owner's example call, if there is one.
export function paidDef(t) {
  const props = {};
  for (const [k, v] of Object.entries(t.example || {})) {
    const type = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : 'string';
    props[k] = { type, description: 'For example: ' + line(typeof v === 'string' ? v : JSON.stringify(v), 120) };
  }
  return { type: 'function', function: {
    name: paidName(t.name),
    description: `[Paid tool: each call costs up to ${usd(t.max)} USDG out of this run's budget, whether or not the answer is useful. Call it only when the job needs it.] ${t.description}`.slice(0, 600),
    parameters: { type: 'object', properties: props, ...(Object.keys(props).length ? {} : { additionalProperties: true }) },
  } };
}

// ---- reading what an endpoint asks for ----

// The terms in a 402 answer, in either x402 layout: version 2 sends them in the PAYMENT-REQUIRED header, version 1 in
// the body. Returns { v, resource, accepts } or null.
export function readTerms(header, body) {
  let doc = null;
  if (header) { try { doc = JSON.parse(unb64(header)); } catch {} }
  if (!doc || typeof doc !== 'object') { try { doc = JSON.parse(body); } catch {} }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.accepts)) return null;
  return { v: Number(doc.x402Version) === 2 ? 2 : 1, resource: doc.resource && typeof doc.resource === 'object' ? doc.resource : null, accepts: doc.accepts.slice(0, 12) };
}

// The one offer in those terms this tool may be paid by: USDG on Robinhood Chain, exact, inside the owner's ceiling, to
// the payee on record (if one is). The cheapest, if several fit. { ok, value, payTo, req, timeout } or { ok: false, why }.
export function choose(terms, tool) {
  let why = 'it asks for payment on another chain or in another coin (only USDG on Robinhood Chain can be paid)', best = null;
  for (const a of terms.accepts) {
    if (!a || typeof a !== 'object' || a.scheme !== 'exact' || !NETWORKS.has(String(a.network).toLowerCase())) continue;
    if (String(a.asset).toLowerCase() !== USDG.toLowerCase()) continue;
    const amount = String(terms.v === 2 ? a.amount : a.maxAmountRequired ?? a.amount);
    if (!/^[1-9]\d{0,9}$/.test(amount) || !isAddress(String(a.payTo))) { why = 'its price or payee could not be read'; continue; }
    // We sign for the coin's real name and version. An endpoint that expects other ones would refuse the payment, so it is not sent.
    if ((a.extra?.name != null && a.extra.name !== USDG_DOMAIN.name) || (a.extra?.version != null && String(a.extra.version) !== USDG_DOMAIN.version)) { why = 'it expects a payment signed for a different coin contract'; continue; }
    const value = Number(amount);
    if (value > Math.min(tool.max, MAX_CEILING)) { why = `it asks ${usd(value)} USDG a call, which is more than the ${usd(Math.min(tool.max, MAX_CEILING))} its owner allows`; continue; }
    if (tool.pay_to && String(a.payTo).toLowerCase() !== String(tool.pay_to).toLowerCase()) { why = 'it now asks to be paid at a different address than when its owner saved it'; continue; }
    if (!best || value < best.value) best = { value, payTo: getAddress(a.payTo), req: a, timeout: Math.max(60, Math.min(600, Math.floor(Number(a.maxTimeoutSeconds)) || 60)) };
  }
  return best ? { ok: true, ...best } : { ok: false, why };
}

// The request a call makes: the arguments as a query string (GET) or a JSON body (POST).
function requestOf(env, tool, args) {
  const u = connUrl(env, tool.url); if (!u) return null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const headers = { accept: 'application/json, text/plain;q=0.8', 'user-agent': 'ZeroLuxAgent/1.0' };
  if (tool.method === 'POST') {
    const body = JSON.stringify(a); if (body.length > 8_000) return null;
    return { url: u, init: { method: 'POST', body }, headers: { ...headers, 'content-type': 'application/json' } };
  }
  for (const [k, v] of Object.entries(a).slice(0, 30)) { if (v != null) u.searchParams.set(k.slice(0, 60), (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 2_000)); }
  if (u.toString().length > 6_000) return null;
  return { url: u, init: { method: 'GET' }, headers };
}

async function bodyText(res) {
  if (!res.body) return '';
  const rd = res.body.getReader(), dec = new TextDecoder(); let text = '', size = 0;
  try { while (size < BODY_BYTES) { const { done, value } = await rd.read(); if (done) break; size += value.length; text += dec.decode(value, { stream: true }); } }
  finally { rd.cancel().catch(() => {}); }
  return text;
}

// The header that carries the payment: a USDG transferWithAuthorization signed by the paying wallet, in the layout the endpoint used.
export async function paymentHeader(account, terms, pick, nonce, nowS) {
  const authorization = { from: account.address, to: pick.payTo, value: String(pick.value), validAfter: String(nowS - 60), validBefore: String(nowS + pick.timeout), nonce };
  const signature = await account.signTypedData({
    domain: USDG_DOMAIN, types: { TransferWithAuthorization: TRANSFER }, primaryType: 'TransferWithAuthorization',
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
  });
  const payload = { signature, authorization };
  if (terms.v === 2) return { 'payment-signature': b64({ x402Version: 2, ...(terms.resource ? { resource: terms.resource } : {}), accepted: pick.req, payload }) };
  return { 'x-payment': b64({ x402Version: 1, scheme: 'exact', network: pick.req.network, payload }) };
}

// The transaction an endpoint says settled the payment, if it says so.
function settledTx(res) {
  try { const t = JSON.parse(unb64(res.headers.get('payment-response') || res.headers.get('x-payment-response') || '')).transaction; return /^0x[0-9a-fA-F]{64}$/.test(String(t)) ? String(t).toLowerCase() : null; } catch { return null; }
}

const clip = (text) => { const t = String(text || '').trim() || 'The tool returned nothing.'; return t.length > RESULT_CHARS ? t.slice(0, RESULT_CHARS) + `\n[Cut here: this is the first ${RESULT_CHARS} of ${t.length} characters. The rest was not read.]` : t; };

// Call one paid tool and pay for it. Never throws. Returns { cost, text }: `cost` is what the run is charged (USDG
// units; 0 if nothing was signed), `text` what the agent reads. `o` = { run, agentId, ms }. `deps` is for tests.
export async function callPaid(env, tool, args, o, deps = {}) {
  const f = deps.fetch || fetch, began = Date.now();
  const no = (why) => ({ cost: 0, text: `The paid tool was not used: ${why}. Nothing was paid. Carry on without it.` });
  try {
    if (!paidOn(env)) return no('paying for tools is switched off');
    const account = toolPayer(env);
    const rq = requestOf(env, tool, args); if (!rq) return no('its address is not allowed, or what was sent to it is too long');
    const ask = (extra, ms) => f(rq.url, { ...rq.init, redirect: 'manual', headers: { ...rq.headers, ...extra }, signal: AbortSignal.timeout(Math.max(2_000, ms)) });
    let res;
    try { res = await ask({}, Math.min(15_000, o.ms)); } catch (e) { return no(e?.name === 'TimeoutError' ? 'it took too long to answer' : 'it could not be reached'); }
    if (res.status !== 402) {
      const text = await bodyText(res).catch(() => '');
      // An endpoint that answers without asking for payment is simply a free answer.
      return res.ok ? { cost: 0, text: clip(text) } : no('it answered ' + res.status + ' before asking for any payment' + (text ? ' (' + line(text, 160) + ')' : ''));
    }
    const terms = readTerms(res.headers.get('payment-required'), await bodyText(res).catch(() => ''));
    if (!terms) return no('it asked for payment in a way that could not be read');
    const pick = choose(terms, tool); if (!pick.ok) return no(pick.why);

    const stamp = new Date().toISOString();
    const today = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM tool_payments WHERE at >= ?').bind(stamp.slice(0, 10)).first();
    if (Number(today?.n || 0) + pick.value > dayCap(env)) return no('Zero Lux has paid out as much for tools today as it allows');
    let balance;
    try { balance = await (deps.balance ? deps.balance(account.address) : reader(env).readContract({ address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [account.address] })); }
    catch { return no('the chain is not answering'); }
    if (BigInt(balance) < BigInt(pick.value)) return no('the wallet Zero Lux pays tools from needs topping up');

    // On record before it leaves. From here the price counts against the run.
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const row = await env.DB.prepare("INSERT INTO tool_payments (run, agent_id, tool, host, pay_to, amount, nonce, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?) RETURNING id")
      .bind(o.run, o.agentId, tool.name, rq.url.host, pick.payTo, pick.value, nonce, stamp).first();
    const header = await paymentHeader(account, terms, pick, nonce, Math.floor(Date.now() / 1000));
    let paid = null, text = '';
    try { paid = await ask(header, o.ms - (Date.now() - began)); text = await bodyText(paid); } catch {}
    const ok = !!paid && paid.ok;
    await env.DB.prepare('UPDATE tool_payments SET status = ?, tx = ? WHERE id = ?').bind(ok ? 'delivered' : 'not delivered', paid ? settledTx(paid) : null, row.id).run().catch(() => {});
    if (ok) return { cost: pick.value, text: clip(text) };
    return { cost: pick.value, text: `The paid tool was sent its payment of ${usd(pick.value)} USDG and then did not deliver (${paid ? 'it answered ' + paid.status : 'no answer in time'}). That payment counts against this run. Carry on without it.` };
  } catch { return no('it could not be called'); }
}

// ---- saving paid tools (called from src/revise.js) ----

// The paid tools an edit asks for, checked, as they will be stored in the spec. Each item:
// { name, description, url, method?, max_usd | max, example? } and, on the second step of a save, the `price` and
// `pay_to` the first step found. Without those the endpoint is asked now: it must answer 402 with terms a run can pay.
export async function buildPaid(env, raw, deps = {}) {
  if (!Array.isArray(raw)) throw fail('Paid tools must be a list.');
  if (raw.length > MAX_PAID) throw fail(`An agent can have at most ${MAX_PAID} paid tools.`);
  if (raw.length && !paidOn(env)) throw fail('Paid tools are not switched on here yet.', 503);
  const f = deps.fetch || fetch, list = [], names = new Set();
  for (const item of raw) {
    const name = String(item?.name ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(name)) throw fail('Give each paid tool a short name: lower-case letters, numbers and underscores, starting with a letter.');
    if (names.has(name)) throw fail(`Two paid tools are both called "${name}".`);
    names.add(name);
    const description = line(item?.description, 300);
    if (description.length < 10) throw fail(`Paid tool "${name}": say in a sentence what it does, so the agent knows when to use it.`);
    const u = connUrl(env, item?.url);
    if (!u) throw fail(`Paid tool "${name}": the address has to be a public https address.`);
    const method = String(item?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw fail(`Paid tool "${name}": the method is GET or POST.`);
    const max = item?.max != null ? Number(item.max) : Math.round(Number(item?.max_usd) * 1e6);
    if (!Number.isInteger(max) || max < MIN_CEILING || max > MAX_CEILING) throw fail(`Paid tool "${name}": the most a call may cost has to be between $${usd(MIN_CEILING)} and $${usd(MAX_CEILING)}.`);
    let example = null;
    if (item?.example != null && item.example !== '') {
      example = item.example;
      if (typeof example === 'string') { try { example = JSON.parse(example); } catch { throw fail(`Paid tool "${name}": the example call has to be JSON, like {"symbol": "AAPL"}.`); } }
      if (!example || typeof example !== 'object' || Array.isArray(example) || JSON.stringify(example).length > 600 || Object.keys(example).length > 12 || Object.keys(example).some((k) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(k))) throw fail(`Paid tool "${name}": the example call has to be a small JSON object of the parameters it takes.`);
    }
    const tool = { name, description, url: u.toString(), method, max, ...(example && Object.keys(example).length ? { example } : {}) };
    let price = Number(item?.price), payTo = String(item?.pay_to || '');
    if (!(Number.isInteger(price) && price > 0 && price <= max && isAddress(payTo))) {
      // Asked now, with no payment: what it wants has to be something a run can pay.
      const rq = requestOf(env, tool, example || {});
      let res;
      try { res = await f(rq.url, { ...rq.init, redirect: 'manual', headers: rq.headers, signal: AbortSignal.timeout(12_000) }); }
      catch (e) { throw fail(`Paid tool "${name}" could not be reached${e?.name === 'TimeoutError' ? ': it took too long to answer' : ''}.`, 502); }
      const text = await bodyText(res).catch(() => '');
      if (res.status !== 402) throw fail(`Paid tool "${name}" answered ${res.status}, not 402. A paid tool has to ask for payment when it is called without one. If it needs parameters first, give an example call.`, 422);
      const terms = readTerms(res.headers.get('payment-required'), text);
      if (!terms) throw fail(`Paid tool "${name}" asked for payment in a way that could not be read (x402 is the layout it has to use).`, 422);
      const pick = choose(terms, tool);
      if (!pick.ok) throw fail(`Paid tool "${name}" cannot be used: ${pick.why}.`, 422);
      price = pick.value; payTo = pick.payTo;
    }
    list.push({ ...tool, price, pay_to: getAddress(payTo) });
  }
  return list;
}

// What anyone may see of an agent's paid tools.
export const publicPaid = (spec) => (spec.paid || []).map((t) => {
  let host = ''; try { host = new URL(t.url).host; } catch {}
  return { name: t.name, description: t.description, url: t.url, host, method: t.method, max: String(t.max), price: String(t.price), pay_to: t.pay_to, ...(t.example ? { example: t.example } : {}) };
});

// The payments one run made to paid tools, for its receipt.
export async function paidBy(env, runId) {
  const rows = (await env.DB.prepare('SELECT tool, host, pay_to, amount, status, tx, at FROM tool_payments WHERE run = ? ORDER BY id').bind(runId).all().catch(() => ({ results: [] }))).results;
  return rows.map((r) => ({ tool: r.tool, host: r.host, pay_to: r.pay_to, amount: String(r.amount), status: r.status, settle_tx: r.tx, at: r.at }));
}
