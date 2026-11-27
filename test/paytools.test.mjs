// Paid tools (src/paytools.js): reading an endpoint's x402 terms, choosing what may be paid, signing the payment, and a
// whole run that calls one. The endpoint, the model, the chain and the database are stand-ins: nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { verifyTypedData, encodeAbiParameters, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The Workers runtime module the chain code imports does not exist in Node; a stand-in class is enough to load it.
registerHooks({ resolve(spec, ctx, next) { return spec === 'cloudflare:workers' ? { url: 'data:text/javascript,export class DurableObject{constructor(c,e){this.ctx=c;this.env=e}}', shortCircuit: true } : next(spec, ctx); } });
const { readTerms, choose, paymentHeader, callPaid, buildPaid, publicPaid, paidDef, paidName, paidBy, MAX_CEILING } = await import('../src/paytools.js');
const { USDG, USDG_DOMAIN } = await import('../src/chain.js');
const { work, requirements } = await import('../src/run.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());
const PAYEE = getAddress('0x00000000000000000000000000000000000000a1'), OTHER = getAddress('0x00000000000000000000000000000000000000b2');
const key = generatePrivateKey(), payer = privateKeyToAccount(key);
const TRANSFER = [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }];
const TX = '0x' + 'ab'.repeat(32);

const offer = (o = {}) => ({ scheme: 'exact', network: 'eip155:4663', amount: '30000', asset: USDG, payTo: PAYEE, maxTimeoutSeconds: 120, extra: { name: 'Global Dollar', version: '1' }, ...o });
const v2 = (accepts) => ({ x402Version: 2, error: 'Payment required', resource: { url: 'https://tools.example/backtest', description: 'Backtest', mimeType: 'application/json' }, accepts });
const v1 = (accepts) => ({ x402Version: 1, error: 'Payment required', accepts: accepts.map(({ amount, ...a }) => ({ ...a, maxAmountRequired: amount, resource: 'https://tools.example/backtest' })) });
const tool = (o = {}) => ({ name: 'backtest', description: 'Backtests a strategy on a stock and returns the results.', url: 'https://tools.example/backtest', method: 'GET', max: 30_000, example: { symbol: 'AAPL', days: 90 }, price: 30_000, pay_to: PAYEE, ...o });

// A database that behaves like the Worker's, holding the real schema.
function database() {
  const db = new DatabaseSync(':memory:');
  for (const s of readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/^\s*--.*$/gm, '').split(';')) { if (s.trim()) try { db.exec(s); } catch {} }
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
  });
  return { raw: db, prepare: (sql) => stmt(sql, []), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}
const env = (o = {}) => ({ DB: database(), CARD_PAYER_KEY: key, OPENROUTER_KEY: 'none', RPC_URL: 'http://rpc.test', ...o });

// A stand-in paid endpoint. It asks for payment in either layout, checks the signature like a real one would, and
// answers. `seen` records every request it got.
function endpoint({ layout = 2, accepts = [offer()], after = 200, body = { sharpe: 1.4, trades: 37 } } = {}) {
  const seen = [];
  const serve = async (url, init = {}) => {
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const sent = h['payment-signature'] || h['x-payment'];
    seen.push({ url: String(url), method: init.method, paid: !!sent, redirect: init.redirect, body: init.body });
    if (!sent) return layout === 2 ? new Response('{}', { status: 402, headers: { 'payment-required': b64(v2(accepts)) } }) : new Response(JSON.stringify(v1(accepts)), { status: 402 });
    const p = unb64(sent), a = p.payload.authorization, nowS = Math.floor(Date.now() / 1000);
    assert.equal(p.x402Version, layout);
    assert.equal(h[layout === 2 ? 'payment-signature' : 'x-payment'], sent);
    const good = await verifyTypedData({ address: a.from, domain: USDG_DOMAIN, types: { TransferWithAuthorization: TRANSFER }, primaryType: 'TransferWithAuthorization', signature: p.payload.signature,
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
    seen.at(-1).auth = a; seen.at(-1).good = good && Number(a.validAfter) <= nowS && Number(a.validBefore) > nowS;
    if (!seen.at(-1).good) return new Response('{}', { status: 402 });
    if (after !== 200) return new Response('broken', { status: after });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'payment-response': b64({ success: true, transaction: TX, network: 'eip155:4663', payer: a.from }) } });
  };
  return { serve, seen };
}
const rich = async () => 10_000_000n;
const rows = (e) => e.DB.raw.prepare('SELECT * FROM tool_payments ORDER BY id').all();

test('terms are read in both x402 layouts', () => {
  const two = readTerms(b64(v2([offer()])), '{}'), one = readTerms(null, JSON.stringify(v1([offer()])));
  assert.equal(two.v, 2); assert.equal(two.accepts[0].amount, '30000'); assert.equal(two.resource.url, 'https://tools.example/backtest');
  assert.equal(one.v, 1); assert.equal(one.accepts[0].maxAmountRequired, '30000');
  assert.equal(readTerms(null, 'not json'), null); assert.equal(readTerms('@@', '{"accepts":"x"}'), null);
});

test('only USDG on Robinhood Chain, inside the ceiling, to the payee on record, is chosen', () => {
  const pick = (accepts, t = tool(), layout = v2) => choose(readTerms(null, JSON.stringify(layout(accepts))), t);
  const ok = pick([offer()]);
  assert.equal(ok.ok, true); assert.equal(ok.value, 30_000); assert.equal(ok.payTo, PAYEE); assert.equal(ok.timeout, 120);
  assert.equal(pick([offer()], tool(), v1).value, 30_000);
  assert.equal(pick([offer({ amount: '50000' }), offer({ amount: '20000' })]).value, 20_000, 'the cheapest that fits');
  assert.match(pick([offer({ network: 'eip155:8453' })]).why, /another chain/);
  assert.match(pick([offer({ asset: OTHER })]).why, /another chain or in another coin/);
  assert.match(pick([offer({ scheme: 'upto' })]).why, /another chain/);
  assert.match(pick([offer({ amount: '30001' })]).why, /more than the 0.03/);
  assert.match(pick([offer({ payTo: OTHER })]).why, /different address/);
  assert.equal(pick([offer({ payTo: OTHER })], tool({ pay_to: undefined })).ok, true, 'no payee on record yet: any is taken');
  assert.match(pick([offer({ extra: { name: 'USD Coin', version: '2' } })]).why, /different coin contract/);
  for (const amount of ['0', '-5', '1.5', 'abc', '99999999999']) assert.equal(pick([offer({ amount })]).ok, false, amount);
  assert.equal(pick([offer({ amount: String(MAX_CEILING + 1) })], tool({ max: MAX_CEILING * 5 })).ok, false, 'never above the hard ceiling');
  assert.equal(pick([offer({ maxTimeoutSeconds: 99999 })]).timeout, 600);
});

test('the payment is a USDG authorization from the paying wallet that verifies', async () => {
  const terms = readTerms(b64(v2([offer()])), ''), pick = choose(terms, tool()), nonce = '0x' + '11'.repeat(32), nowS = 1_800_000_000;
  const p = unb64((await paymentHeader(payer, terms, pick, nonce, nowS))['payment-signature']), a = p.payload.authorization;
  assert.deepEqual(a, { from: payer.address, to: PAYEE, value: '30000', validAfter: String(nowS - 60), validBefore: String(nowS + 120), nonce });
  assert.deepEqual(p.accepted, offer()); assert.equal(p.resource.url, 'https://tools.example/backtest');
  assert.equal(await verifyTypedData({ address: payer.address, domain: { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: USDG }, types: { TransferWithAuthorization: TRANSFER }, primaryType: 'TransferWithAuthorization', signature: p.payload.signature,
    message: { ...a, value: 30000n, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } }), true);
  const t1 = readTerms(null, JSON.stringify(v1([offer()])));
  const old = unb64((await paymentHeader(payer, t1, choose(t1, tool()), nonce, nowS))['x-payment']);
  assert.equal(old.x402Version, 1); assert.equal(old.scheme, 'exact'); assert.equal(old.network, 'eip155:4663'); assert.equal(old.payload.authorization.value, '30000');
});

test('a call pays the price, records it, and hands back the answer', async () => {
  for (const layout of [2, 1]) {
    const e = env(), ep = endpoint({ layout });
    const r = await callPaid(e, tool(), { symbol: 'TSLA', days: 30 }, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich });
    assert.equal(r.cost, 30_000); assert.deepEqual(JSON.parse(r.text), { sharpe: 1.4, trades: 37 });
    assert.equal(ep.seen.length, 2); assert.equal(ep.seen[0].paid, false); assert.equal(ep.seen[1].good, true);
    assert.equal(ep.seen[1].url, 'https://tools.example/backtest?symbol=TSLA&days=30'); assert.equal(ep.seen[1].redirect, 'manual');
    assert.equal(ep.seen[1].auth.from, payer.address); assert.equal(ep.seen[1].auth.to, PAYEE); assert.equal(ep.seen[1].auth.value, '30000');
    const [row] = rows(e);
    assert.equal(row.run, '0xrun'); assert.equal(row.agent_id, 7); assert.equal(row.tool, 'backtest'); assert.equal(row.host, 'tools.example');
    assert.equal(row.pay_to, PAYEE); assert.equal(row.amount, 30_000); assert.equal(row.status, 'delivered'); assert.equal(row.tx, TX); assert.equal(row.nonce, ep.seen[1].auth.nonce);
    assert.deepEqual(await paidBy(e, '0xrun'), [{ tool: 'backtest', host: 'tools.example', pay_to: PAYEE, amount: '30000', status: 'delivered', settle_tx: TX, at: row.at }]);
  }
});

test('a POST tool gets its arguments as JSON', async () => {
  const ep = endpoint();
  await callPaid(env(), tool({ method: 'POST' }), { symbol: 'TSLA' }, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich });
  assert.equal(ep.seen[1].method, 'POST'); assert.equal(ep.seen[1].body, '{"symbol":"TSLA"}'); assert.equal(ep.seen[1].url, 'https://tools.example/backtest');
});

test('nothing is signed when the terms cannot be paid, the day is spent, or the paying wallet is empty', async () => {
  const cases = [
    [endpoint({ accepts: [offer({ amount: '90000' })] }), {}, { balance: rich }, /more than the 0.03/],
    [endpoint({ accepts: [offer({ payTo: OTHER })] }), {}, { balance: rich }, /different address/],
    [endpoint({ accepts: [offer({ network: 'eip155:1' })] }), {}, { balance: rich }, /another chain/],
    [endpoint(), { TOOL_DAY_CAP: '20000' }, { balance: rich }, /as much for tools today/],
    [endpoint(), {}, { balance: async () => 29_999n }, /needs topping up/],
    [endpoint(), {}, { balance: async () => { throw new Error('rpc'); } }, /chain is not answering/],
    [endpoint(), { CARD_PAYER_KEY: undefined }, { balance: rich }, /switched off/],
  ];
  for (const [ep, extra, deps, why] of cases) {
    const e = env(extra), r = await callPaid(e, tool(), {}, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: ep.serve, ...deps });
    assert.equal(r.cost, 0, String(why)); assert.match(r.text, why); assert.match(r.text, /Nothing was paid/);
    assert.equal(ep.seen.filter((s) => s.paid).length, 0); assert.equal(rows(e).length, 0);
  }
  // The day's limit counts what was already paid out today.
  const e = env({ TOOL_DAY_CAP: '50000' }), ep = endpoint();
  assert.equal((await callPaid(e, tool(), {}, { run: '0xa', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich })).cost, 30_000);
  assert.equal((await callPaid(e, tool(), {}, { run: '0xb', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich })).cost, 0);
});

test('an endpoint that answers without asking is free; one that fails before asking costs nothing', async () => {
  const free = async () => new Response('{"ok":true}', { status: 200 }), down = async () => new Response('nope', { status: 500 }), gone = async () => { throw new Error('dns'); };
  assert.deepEqual(await callPaid(env(), tool(), {}, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: free, balance: rich }), { cost: 0, text: '{"ok":true}' });
  for (const f of [down, gone]) { const r = await callPaid(env(), tool(), {}, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: f, balance: rich }); assert.equal(r.cost, 0); assert.match(r.text, /Nothing was paid/); }
});

test('a payment that was sent is charged even when the tool then fails, and says so', async () => {
  const e = env(), ep = endpoint({ after: 500 });
  const r = await callPaid(e, tool(), {}, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich });
  assert.equal(r.cost, 30_000); assert.match(r.text, /did not deliver \(it answered 500\)/); assert.match(r.text, /counts against this run/);
  assert.equal(rows(e)[0].status, 'not delivered'); assert.equal(rows(e)[0].tx, null);
});

test('a long answer is cut and says so', async () => {
  const ep = endpoint({ body: { data: 'x'.repeat(20_000) } });
  const r = await callPaid(env(), tool(), {}, { run: '0xrun', agentId: 7, ms: 20_000 }, { fetch: ep.serve, balance: rich });
  assert.match(r.text, /\[Cut here: this is the first 8000 of 200\d\d characters/);
});

test('saving a paid tool asks the endpoint what it charges and keeps the payee', async () => {
  const e = env(), ep = endpoint();
  const item = { name: 'Backtest', description: 'Backtests a strategy on a stock and returns the results.', url: 'https://tools.example/backtest', max_usd: 0.05, example: '{"symbol": "AAPL", "days": 90}' };
  const [t] = await buildPaid(e, [item], { fetch: ep.serve });
  assert.deepEqual(t, { name: 'backtest', description: item.description, url: 'https://tools.example/backtest', method: 'GET', max: 50_000, example: { symbol: 'AAPL', days: 90 }, price: 30_000, pay_to: PAYEE });
  assert.equal(ep.seen.length, 1); assert.equal(ep.seen[0].paid, false); assert.equal(ep.seen[0].url, 'https://tools.example/backtest?symbol=AAPL&days=90');
  // The second step of a save sends back what the first found: the endpoint is not asked again, and the result is the same.
  const again = endpoint();
  assert.deepEqual(await buildPaid(e, [t], { fetch: again.serve }), [t]); assert.equal(again.seen.length, 0);
  assert.deepEqual(publicPaid({ paid: [t] }), [{ name: 'backtest', description: item.description, url: t.url, host: 'tools.example', method: 'GET', max: '50000', price: '30000', pay_to: PAYEE, example: { symbol: 'AAPL', days: 90 } }]);
  const def = paidDef(t).function;
  assert.equal(def.name, 'paid_backtest'); assert.equal(paidName('backtest'), 'paid_backtest'); assert.match(def.description, /costs up to 0\.05 USDG/);
  assert.deepEqual(Object.keys(def.parameters.properties), ['symbol', 'days']); assert.equal(def.parameters.properties.days.type, 'number');
});

test('a paid tool that cannot be paid is refused when saving', async () => {
  const e = env(), base = { name: 'scan', description: 'Scans the market for unusual moves.', url: 'https://tools.example/scan', max_usd: 0.02 };
  const bad = async (item, f, why, list) => assert.rejects(buildPaid(e, list || [{ ...base, ...item }], { fetch: f || endpoint().serve }), (x) => { assert.match(x.message, why); assert.ok(x.status); return true; });
  await bad({}, null, /asks 0\.03 USDG a call, which is more than the 0\.02/);
  await bad({ max_usd: 0.05 }, endpoint({ accepts: [offer({ network: 'base' })] }).serve, /another chain/);
  await bad({ max_usd: 0.05 }, async () => new Response('hi', { status: 200 }), /answered 200, not 402/);
  await bad({ max_usd: 0.05 }, async () => new Response('hi', { status: 402 }), /could not be read/);
  await bad({ max_usd: 0.05 }, async () => { throw new Error('x'); }, /could not be reached/);
  await bad({ name: 'Bad Name' }, null, /short name/);
  await bad({ description: 'short' }, null, /what it does/);
  await bad({ url: 'http://tools.example/scan' }, null, /public https/);
  await bad({ url: 'https://zerolux.fun/a/1/run' }, null, /public https/);
  await bad({ url: 'https://127.0.0.1/scan' }, null, /public https/);
  await bad({ method: 'DELETE' }, null, /GET or POST/);
  await bad({ max_usd: 5 }, null, /between/);
  await bad({ max_usd: 0 }, null, /between/);
  await bad({ example: '[1]' }, null, /small JSON object/);
  await bad({ example: 'nope' }, null, /has to be JSON/);
  await bad({}, null, /both called/, [{ ...base, max_usd: 0.05 }, { ...base, max_usd: 0.05 }]);
  await bad({}, null, /at most 4/, Array.from({ length: 5 }, (_, i) => ({ ...base, name: 'scan' + i })));
  await assert.rejects(buildPaid(env({ CARD_PAYER_KEY: undefined }), [base], { fetch: endpoint().serve }), /not switched on/);
  assert.deepEqual(await buildPaid(e, []), []);
});

test('a customer is told about paid tools before paying, on a wallet that can pay them', () => {
  const agent = (v) => ({ id: 3, name: 'Quant', price: 200_000, wallet: PAYEE, v, spec: JSON.stringify({ paid: [tool()] }) });
  const terms = requirements(agent(4), 'https://zerolux.fun/a/3/run');
  assert.deepEqual(terms.paid_tools, [{ name: 'backtest', host: 'tools.example', max: '30000', pay_to: PAYEE }]); assert.match(terms.paid_tools_note, /nothing more/);
  assert.equal(requirements(agent(2), 'https://zerolux.fun/a/3/run').paid_tools, undefined);
});

// ---- a whole run ----

// The model: it asks for the paid tool once, then answers with what came back. `asked` records what it was sent.
function model(calls = [{ name: 'paid_backtest', arguments: '{"symbol":"TSLA","days":30}' }]) {
  const asked = [];
  const serve = async (init) => {
    const body = JSON.parse(init.body); asked.push(body);
    const last = body.messages.at(-1);
    const message = last.role === 'tool' ? { role: 'assistant', content: 'Result: ' + last.content } : { role: 'assistant', content: '', tool_calls: calls.map((c, i) => ({ id: 'call' + i, type: 'function', function: c })) };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), { status: 200 });
  };
  return { serve, asked };
}
// The chain: every read answers with a USDG balance, alone or inside a multicall.
const chainAnswer = (balance) => async (init) => {
  const one = (q) => { const word = encodeAbiParameters([{ type: 'uint256' }], [balance]); return { jsonrpc: '2.0', id: q.id, result: q.method === 'eth_chainId' ? '0x1237' : String(q.params?.[0]?.to).toLowerCase() === USDG.toLowerCase() ? word : encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }], [[[true, word]]]) }; };
  const q = JSON.parse(init.body);
  return new Response(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)), { status: 200, headers: { 'content-type': 'application/json' } });
};
async function runOnce({ room = 300_000, pays = true, ep = endpoint(), balance = 10_000_000n, spec = {} } = {}) {
  const e = env(), m = model(), real = globalThis.fetch;
  const cols = e.DB.raw.prepare('PRAGMA table_info(runs)').all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
  e.DB.raw.prepare(`INSERT INTO runs (id, ${cols.map((c) => c.name).join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run('0xrun', ...cols.map((c) => (c.name === 'status' ? 'running' : /INT/i.test(c.type) ? 0 : '')));
  globalThis.fetch = async (url, init) => { const u = String(url); return u.startsWith('https://openrouter.ai/') ? m.serve(init) : u.startsWith('http://rpc.test') ? chainAnswer(balance)(init) : ep.serve(url, init); };
  let output, error;
  try { output = await work(e, { id: 7 }, { name: 'Quant', instructions: 'Backtest what the customer asks for.', model: 'fast', tools: [], paid: [tool()], ...spec }, '0xpayer', 'Backtest TSLA over 30 days', { id: '0xrun', room, pays }); }
  catch (x) { error = x; } finally { globalThis.fetch = real; }
  return { e, m, ep, output, error, row: e.DB.raw.prepare('SELECT spent, tokens_in FROM runs WHERE id = ?').get('0xrun') };
}

test('a run calls a paid tool, pays for it, and the price is on the run\'s books', async () => {
  const { e, m, ep, output, error, row } = await runOnce();
  assert.equal(error, undefined);
  assert.match(output, /^Result: <connected>\n\{"sharpe":1\.4,"trades":37\}\n<\/connected>$/);
  assert.equal(m.asked[0].tools.map((t) => t.function.name).join(), 'paid_backtest');
  assert.equal(ep.seen.length, 2); assert.equal(ep.seen[1].good, true); assert.equal(ep.seen[1].url, 'https://tools.example/backtest?symbol=TSLA&days=30');
  const [p] = rows(e);
  assert.equal(p.status, 'delivered'); assert.equal(p.amount, 30_000); assert.equal(p.run, '0xrun'); assert.equal(p.agent_id, 7);
  // What the run spent is the two model calls plus exactly the tool's price.
  const models = row.spent - 30_000;
  assert.ok(models > 0 && models < 30_000, 'spent ' + row.spent); assert.equal(row.tokens_in, 1800);
});

test('a run with too little budget left does not pay, and says so to the agent', async () => {
  const { e, m, ep, output } = await runOnce({ room: 32_000 });
  assert.match(output, /does not have the budget left for that paid tool/);
  assert.equal(ep.seen.length, 0); assert.equal(rows(e).length, 0); assert.equal(m.asked.length, 2);
});

test('a run whose payment is not held is not offered paid tools at all', async () => {
  const { m, ep, error } = await runOnce({ pays: false });
  assert.equal(m.asked[0].tools, undefined); assert.equal(ep.seen.length, 0);
  assert.equal(error, undefined); // the model asked for a tool that does not exist and was told so
});

test('an empty paying wallet stops the payment and the run carries on, charged nothing for the tool', async () => {
  const { e, ep, output, row } = await runOnce({ balance: 100n });
  assert.match(output, /needs topping up\. Nothing was paid/);
  assert.equal(ep.seen.filter((s) => s.paid).length, 0); assert.equal(rows(e).length, 0); assert.ok(row.spent < 30_000, 'spent ' + row.spent);
});

test('at most four paid calls a run, two a step', async () => {
  const e = env(), ep = endpoint({ accepts: [offer({ amount: '1000' })] }), real = globalThis.fetch;
  const cols = e.DB.raw.prepare('PRAGMA table_info(runs)').all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
  e.DB.raw.prepare(`INSERT INTO runs (id, ${cols.map((c) => c.name).join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run('0xrun', ...cols.map((c) => (c.name === 'status' ? 'running' : /INT/i.test(c.type) ? 0 : '')));
  let step = 0; const told = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://rpc.test')) return chainAnswer(10_000_000n)(init);
    if (!u.startsWith('https://openrouter.ai/')) return ep.serve(url, init);
    const body = JSON.parse(init.body); told.push(...body.messages.filter((x) => x.role === 'tool').slice(-2).map((x) => x.content));
    const message = ++step <= 3 ? { role: 'assistant', content: '', tool_calls: [0, 1].map((i) => ({ id: 's' + step + i, type: 'function', function: { name: 'paid_backtest', arguments: '{}' } })) } : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 500, completion_tokens: 20 } }), { status: 200 });
  };
  try { assert.equal(await work(e, { id: 7 }, { name: 'Quant', instructions: 'x', model: 'fast', tools: [], paid: [tool({ max: 1_000, price: 1_000 })] }, '0xpayer', 'go', { id: '0xrun', room: 400_000, pays: true }), 'done'); }
  finally { globalThis.fetch = real; }
  assert.equal(rows(e).length, 4); assert.equal(ep.seen.filter((s) => s.paid).length, 4);
  assert.ok(told.some((t) => /as often as this run allows/.test(t)));
});
