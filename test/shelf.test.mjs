// The tool shelf (src/shelf.js): listing a paid tool signed by its payee, reading the shelf, building an agent's paid
// tools from it, taking a listing off, and the re-check that drops a tool that changed. Stand-ins only: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

registerHooks({ resolve(spec, ctx, next) { return spec === 'cloudflare:workers' ? { url: 'data:text/javascript,export class DurableObject{constructor(c,e){this.ctx=c;this.env=e}}', shortCircuit: true } : next(spec, ctx); } });
const { getShelf, listTool, removeTool, shelfTools, shelfTick, shelfId, listMessage } = await import('../src/shelf.js');
const { USDG } = await import('../src/chain.js');

const seller = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function database() {
  const db = new DatabaseSync(':memory:');
  for (const s of readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/^\s*--.*$/gm, '').split(';')) { if (s.trim()) try { db.exec(s); } catch {} }
  const stmt = (sql, args) => ({ bind: (...a) => stmt(sql, a), async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; } });
  return { raw: db, prepare: (sql) => stmt(sql, []) };
}
const env = (o = {}) => ({ DB: database(), CARD_PAYER_KEY: generatePrivateKey(), RPC_URL: 'http://127.0.0.1:9', ...o });
// A stand-in paid endpoint: it asks for `amount` to be paid to `payTo`.
const endpoint = (o = {}) => { const st = { amount: '30000', payTo: seller.address, status: 402, calls: 0, ...o }; st.fetch = async () => { st.calls++; return st.status === 402 ? new Response('{}', { status: 402, headers: { 'payment-required': b64({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:4663', amount: st.amount, asset: USDG, payTo: st.payTo, maxTimeoutSeconds: 60 }] }) } }) : new Response('down', { status: st.status }); }; return st; };
const item = (o = {}) => ({ name: 'backtest', description: 'Backtests a strategy on a stock and returns the results.', url: 'https://tools.example/backtest', method: 'GET', example: { symbol: 'AAPL' }, ...o });
const post = (body, headers = {}) => new Request('https://zerolux.fun/api/shelf', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers }, body: JSON.stringify(body) });
const fine = async () => null;
const read = async (res) => ({ s: res.status, d: await res.json() });
async function list(e, ep, o = {}, signer = seller) {
  const first = await read(await listTool(post({ prepare: true, ...item(o) }), e, { fetch: ep.fetch, review: fine }));
  if (first.s !== 200) return first;
  return read(await listTool(post({ ...item(o), time: first.d.time, signature: await signer.signMessage({ message: first.d.message }) }), e, { fetch: ep.fetch, review: fine }));
}

test('a tool is listed when the wallet it is paid at signs for it', async () => {
  const e = env(), ep = endpoint();
  const first = await read(await listTool(post({ prepare: true, ...item() }), e, { fetch: ep.fetch, review: fine }));
  assert.equal(first.s, 200); assert.equal(first.d.sign_with, seller.address); assert.equal(first.d.tool.price, 30_000);
  assert.equal(first.d.message, listMessage({ tool: first.d.tool, time: first.d.time }));
  assert.match(first.d.message, /Price now: \$0\.03 a call, paid to 0x/); assert.match(first.d.message, /moves no money/);
  assert.equal((await read(await getShelf(e))).d.tools.length, 0, 'nothing is listed until it is signed');
  const done = await list(e, ep);
  assert.equal(done.s, 200); assert.equal(done.d.id, await shelfId('https://tools.example/backtest', 'GET'));
  const { tools } = (await read(await getShelf(e))).d;
  assert.equal(tools.length, 1);
  assert.deepEqual({ ...tools[0], listed_at: 0, checked_at: 0 }, { id: done.d.id, name: 'backtest', description: item().description, url: 'https://tools.example/backtest', host: 'tools.example', method: 'GET', example: { symbol: 'AAPL' }, price: '30000', pay_to: seller.address, listed_by: seller.address, listed_at: 0, checked_at: 0 });
});

test('nobody else can list it, and an old or missing signature is refused', async () => {
  const e = env(), ep = endpoint();
  const wrong = await list(e, ep, {}, stranger);
  assert.equal(wrong.s, 403); assert.match(wrong.d.error, /signed by the wallet the tool is paid at/);
  const first = await read(await listTool(post({ prepare: true, ...item() }), e, { fetch: ep.fetch, review: fine }));
  const sig = await seller.signMessage({ message: first.d.message });
  assert.equal((await read(await listTool(post({ ...item(), time: '2020-01-01T00:00:00.000Z', signature: sig }), e, { fetch: ep.fetch, review: fine }))).s, 400);
  assert.equal((await read(await listTool(post({ ...item(), time: first.d.time }), e, { fetch: ep.fetch, review: fine }))).s, 403);
  // What was signed is what the endpoint said: a price that moved between the two steps does not pass.
  ep.amount = '40000';
  assert.equal((await read(await listTool(post({ ...item(), time: first.d.time, signature: sig }), e, { fetch: ep.fetch, review: fine }))).s, 403);
  assert.equal((await read(await getShelf(e))).d.tools.length, 0);
});

test('a listing that cannot be paid, or whose wording is refused, is not listed', async () => {
  const e = env();
  assert.equal((await list(e, endpoint({ status: 200 }))).s, 422);
  assert.equal((await list(e, endpoint({ amount: '5000000' }))).s, 422);
  assert.equal((await list(e, endpoint(), { url: 'http://tools.example/x' })).s, 400);
  assert.equal((await list(e, endpoint(), { name: 'Bad Name' })).s, 400);
  const no = await read(await listTool(post({ prepare: true, ...item() }), e, { fetch: endpoint().fetch, review: async () => 'That is not something a tool here may do.' }));
  assert.equal(no.s, 422); assert.match(no.d.error, /not something/);
  assert.equal((await read(await listTool(post({ prepare: true, ...item() }), env({ CARD_PAYER_KEY: undefined }), { fetch: endpoint().fetch, review: fine }))).s, 503);
});

test('listing the same endpoint again updates it', async () => {
  const e = env(), ep = endpoint();
  await list(e, ep); ep.amount = '20000';
  const again = await list(e, ep, { description: 'Backtests any strategy on any stock token and returns the results.' });
  assert.equal(again.s, 200);
  const { tools } = (await read(await getShelf(e))).d;
  assert.equal(tools.length, 1); assert.equal(tools[0].price, '20000'); assert.match(tools[0].description, /any strategy/);
});

test('shelf tools go into a new agent as paid tools, capped at the listed price', async () => {
  const e = env(), ep = endpoint();
  const { d } = await list(e, ep), calls = ep.calls;
  assert.deepEqual(await shelfTools(e, [d.id, d.id]), [{ name: 'backtest', description: item().description, url: 'https://tools.example/backtest', method: 'GET', max: 30_000, example: { symbol: 'AAPL' }, price: 30_000, pay_to: seller.address }]);
  assert.equal(ep.calls, calls, 'the endpoint is not asked again');
  assert.deepEqual(await shelfTools(e, []), []);
  await assert.rejects(shelfTools(e, ['0123456789abcdef']), /no longer on the shelf/);
  await assert.rejects(shelfTools(e, ['nope']), /not a tool on the shelf/);
});

test('only the lister, or the build key, takes a listing off', async () => {
  const e = env({ BUILD_KEY: 'k'.repeat(40) }), ep = endpoint();
  const { d } = await list(e, ep);
  const first = await read(await removeTool(post({ prepare: true }), e, d.id));
  assert.equal(first.d.sign_with, seller.address);
  const bad = await read(await removeTool(post({ time: first.d.time, signature: await stranger.signMessage({ message: first.d.message }) }), e, d.id));
  assert.equal(bad.s, 403); assert.equal((await read(await getShelf(e))).d.tools.length, 1);
  const ok = await read(await removeTool(post({ time: first.d.time, signature: await seller.signMessage({ message: first.d.message }) }), e, d.id));
  assert.equal(ok.s, 200); assert.equal((await read(await getShelf(e))).d.tools.length, 0);
  assert.equal((await read(await removeTool(post({ prepare: true }), e, d.id))).s, 404);
  await assert.rejects(shelfTools(e, [d.id]), /no longer on the shelf/);
});

test('a listing that changes its payee or stops answering drops off after three checks, and a healthy one keeps its price current', async () => {
  const e = env(), ep = endpoint();
  const { d } = await list(e, ep);
  const stale = () => e.DB.raw.prepare("UPDATE shelf SET checked_at = '2020-01-01T00:00:00.000Z'").run();
  const row = () => e.DB.raw.prepare('SELECT price, fails FROM shelf WHERE id = ?').get(d.id);
  await shelfTick(e, { fetch: ep.fetch }); assert.equal(ep.calls, 2, 'a fresh listing is not asked again yet');
  stale(); ep.amount = '25000'; await shelfTick(e, { fetch: ep.fetch });
  assert.deepEqual({ ...row() }, { price: 25_000, fails: 0 });
  ep.payTo = stranger.address;
  for (let i = 1; i <= 3; i++) { stale(); await shelfTick(e, { fetch: ep.fetch }); assert.equal(row().fails, i); assert.equal((await read(await getShelf(e))).d.tools.length, i < 3 ? 1 : 0); }
  await assert.rejects(shelfTools(e, [d.id]), /no longer on the shelf/);
  // Its lister lists it again, signed by the wallet it is paid at now, and it is back.
  ep.payTo = seller.address; assert.equal((await list(e, ep)).s, 200); assert.equal((await read(await getShelf(e))).d.tools.length, 1);
});
