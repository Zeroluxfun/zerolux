// Read side: the floor (every agent with its on-chain record), one agent,
// the ERC-8004 card, and what a browser wallet needs to act on a wallet.
import { getAddress, toFunctionSelector } from 'viem';
import { reader, walletAbi, wallet3Abi, usdgAbi, registryAbi, factoryOf, operatorAddress, USDG, CHAIN_ID, EXPLORER, IDENTITY } from './chain.js';
import { json, MODELS, TOOLS, modelsFor, newAgentVersion } from './line.js';
import { RATES, NETWORK_COST, networkCost, RECEIPT_FORMULA } from './run.js';
import { luxConfig, wholeTokens } from './burn.js';

const address = (a) => String(a.wallet).toLowerCase();
const FRESH_MS = 60_000; // chain figures are re-read at most once a minute per agent

// One multicall for up to 40 wallets; everything a page shows about money.
async function refresh(env, rows) {
  const stale = rows.filter((a) => !a.stats_at || Date.now() - Date.parse(a.stats_at) > FRESH_MS).slice(0, 40);
  if (!stale.length) return;
  const c = reader(env);
  // A version 3 wallet keeps more books of its own: who paid it from outside, what it gave back, and who meters it.
  const V3_BOOKS = ['externalIncome', 'insiderIncome', 'payerCount', 'topPayerPaid', 'totalRefunded', 'customOperator', 'operator', 'payableCount'];
  const width = (a) => 10 + (a.v === 3 ? V3_BOOKS.length : 0);
  const calls = stale.flatMap((a) => {
    const address = getAddress(a.wallet);
    return [
      { address, abi: walletAbi, functionName: 'income' },
      { address, abi: walletAbi, functionName: 'totalCharged' },
      { address, abi: walletAbi, functionName: 'owner' },
      { address, abi: walletAbi, functionName: 'paused' },
      { address, abi: walletAbi, functionName: 'lien' },
      { address, abi: walletAbi, functionName: 'lienUnpaid' },
      { address, abi: walletAbi, functionName: 'withdrawable' },
      { address, abi: walletAbi, functionName: 'unsettled' },
      { address: USDG, abi: usdgAbi, functionName: 'balanceOf', args: [address] },
      // the payment wallet the identity registry holds for this agent, if it has an identity
      { address: IDENTITY, abi: registryAbi, functionName: 'getAgentWallet', args: [BigInt(a.identity_id || 0)] },
      ...(a.v === 3 ? V3_BOOKS.map((functionName) => ({ address, abi: wallet3Abi, functionName })) : []),
    ];
  });
  let out;
  try { out = await c.multicall({ contracts: calls, allowFailure: true }); } catch { return; }
  const at = new Date().toISOString();
  const writes = [], fresh = [];
  const lists = []; // version 3 wallets whose owner lets their runs pay other agents: the list is read below
  let at0 = 0;
  stale.forEach((a) => {
    const r = out.slice(at0, at0 + width(a)); at0 += width(a);
    if (r.slice(0, 9).some((x) => x.status !== 'success')) return;
    const [income, charged, owner, paused, lien, lienUnpaid, withdrawable, unsettled, balance] = r.map((x) => x.result);
    const named = r[9].status === 'success' && !!a.identity_id && String(r[9].result).toLowerCase() === address(a);
    const stats = {
      income: income.toString(), charged: charged.toString(), profit: (income - charged).toString(), balance: balance.toString(),
      withdrawable: withdrawable.toString(), unsettled: unsettled.toString(), paused, named,
      lien: /^0x0{40}$/i.test(lien[0]) ? null : { payee: lien[0], bps: lien[1], cap: lien[2].toString(), paid: lien[3].toString(), unpaid: lienUnpaid.toString() },
    };
    if (a.v === 3 && r.slice(10).every((x) => x.status === 'success')) {
      const [externalIncome, insiderIncome, payerCount, topPayerPaid, totalRefunded, customOperator, operator, payableCount] = r.slice(10).map((x) => x.result);
      if (payableCount > 0n) lists.push({ a, stats, n: Number(payableCount > 12n ? 12n : payableCount) }); else stats.payable = [];
      // Counted by the wallet contract itself as payments arrive through `pay`, net of refunds. customOperator is null while the factory's meter runs the wallet.
      Object.assign(stats, { externalIncome: externalIncome.toString(), insiderIncome: insiderIncome.toString(), payerCount: Number(payerCount), topPayerPaid: topPayerPaid.toString(), totalRefunded: totalRefunded.toString(), customOperator: /^0x0{40}$/i.test(customOperator) ? null : customOperator, operator });
    }
    let was = {}; try { was = JSON.parse(a.stats || '{}').payable_seen || {}; } catch {}
    a.stats = JSON.stringify(stats); a.stats_at = at; a.owner = owner;
    fresh.push({ a, stats, owner, was });
  });
  // The wallets each of those may pay (at most 12 are read), in one more multicall, only when some wallet has a list.
  if (lists.length) {
    const got = await c.multicall({ contracts: lists.flatMap(({ a, n }) => Array.from({ length: n }, (_, i) => ({ address: getAddress(a.wallet), abi: wallet3Abi, functionName: 'payableAt', args: [BigInt(i)] }))), allowFailure: true }).catch(() => null);
    let k = 0;
    for (const l of lists) { const part = got ? got.slice(k, k + l.n) : []; k += l.n; l.stats.payable = part.filter((x) => x.status === 'success').map((x) => String(x.result).toLowerCase()); l.a.stats = JSON.stringify(l.stats); }
  }
  // When each wallet on a list was first seen on it. A run may only hire agents that had been on the list, and so in
  // the terms customers read, for a while before its payment came in (see mayHire in run.js); a wallet that has just
  // appeared starts its wait now, and a list that could not be read keeps no times at all.
  for (const f of fresh) if (Array.isArray(f.stats.payable)) { f.stats.payable_seen = Object.fromEntries(f.stats.payable.map((w) => [w, f.was[w] || at])); f.a.stats = JSON.stringify(f.stats); }
  for (const { a, owner } of fresh) writes.push(env.DB.prepare('UPDATE agents SET stats = ?, stats_at = ?, owner = ? WHERE id = ?').bind(a.stats, at, owner, a.id));
  if (writes.length) await env.DB.batch(writes);
}

// A version 3 agent whose wallet is metered by someone other than us cannot be hired here: it is shown as 'self-run', not 'live'.
export const selfRun = (env, a, stats) => a.v === 3 && !!stats?.operator && String(stats.operator).toLowerCase() !== operatorAddress(env).toLowerCase();

function view(env, a, full) {
  const spec = JSON.parse(a.spec), stats = a.stats ? JSON.parse(a.stats) : null;
  if (a.status === 'live' && selfRun(env, a, stats)) a = { ...a, status: 'self-run' };
  const v = {
    id: a.id, name: a.name, tagline: spec.tagline, price: String(a.price), model: MODELS[spec.model]?.label, tools: spec.tools,
    wallet: a.wallet, owner: a.owner, status: a.status, identity: a.identity_id, created_at: a.created_at, version: a.v || 1,
    runs: a.runs ?? 0, stats, stats_at: a.stats_at, customers: a.customers || null,
    // Agents hiring agents: who this one may pay during a run (its owner's on-chain list), whom it has paid and who has paid it (billed sub-runs only).
    can_hire: a.can_hire || [], can_hire_agents: a.can_hire_agents || [], hires: a.hires || [], hired_by: a.hired_by || [],
    // Featured: someone burned $LUX to put this agent at the top of the market until this time (see src/feature.js).
    featured_until: a.featured_until || null, featured: !!a.featured_until && Date.parse(a.featured_until) > Date.now(),
  };
  if (a.lux_burned != null) v.lux_burned = a.lux_burned;
  if (full) Object.assign(v, { job: spec.job, instructions: spec.instructions, input_hint: spec.input_hint, spec_hash: a.spec_hash, create_tx: a.create_tx });
  return v;
}

// Who has paid each agent. An owner can pay their own agent to make its income look bigger, so the books say how
// much came from the owner, from whoever holds a pledge, and from Zero Lux's own test wallets, and how concentrated the rest is.
const PAID = "('ran', 'billed', 'unpaid')";
async function customers(env, rows) {
  const house = String(env.HOUSE_PAYERS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const paid = (await env.DB.prepare(`SELECT agent_id, payer, SUM(paid) AS total, COUNT(*) AS n FROM runs WHERE status IN ${PAID} GROUP BY agent_id, payer`).all()).results;
  for (const a of rows) {
    const mine = paid.filter((p) => p.agent_id === a.id);
    const stats = a.stats ? JSON.parse(a.stats) : null;
    const inside = new Set([String(a.owner).toLowerCase(), String(stats?.lien?.payee || '').toLowerCase(), ...house]);
    const all = mine.reduce((n, p) => n + p.total, 0);
    const own = mine.filter((p) => inside.has(String(p.payer).toLowerCase())).reduce((n, p) => n + p.total, 0);
    const outside = mine.filter((p) => !inside.has(String(p.payer).toLowerCase())).sort((x, y) => y.total - x.total);
    const ext = all - own;
    a.customers = {
      payers: mine.length, outside_payers: outside.length, paid: String(all), from_insiders: String(own), from_outside: String(ext),
      top_outside_share: ext ? Math.round((outside[0].total / ext) * 100) : null,
      top5_outside_share: ext ? Math.round((outside.slice(0, 5).reduce((n, p) => n + p.total, 0) / ext) * 100) : null,
    };
  }
}

// Who hires whom. `hires` and `hired_by` count billed sub-runs only: work that was delivered and charged on chain.
// `can_hire` turns the wallets on an agent's on-chain list into agent numbers (wallets that are not agents here are left out).
let PAIRS = { at: 0, rows: [] }; // who has paid whom, re-counted at most once a minute like the chain figures
async function relations(env, rows) {
  if (Date.now() - PAIRS.at > FRESH_MS) PAIRS = { at: Date.now(), rows: (await env.DB.prepare("SELECT p.agent_id AS boss, s.agent_id AS worker, COUNT(*) AS runs, SUM(s.paid) AS paid FROM runs s JOIN runs p ON p.id = s.parent WHERE s.status = 'billed' GROUP BY p.agent_id, s.agent_id").all()).results };
  const pairs = PAIRS.rows;
  const lists = new Map(rows.map((a) => { try { return [a.id, JSON.parse(a.stats || '{}').payable || []]; } catch { return [a.id, []]; } }));
  const wanted = [...new Set([...lists.values()].flat())];
  const byWallet = new Map(rows.map((a) => [address(a), a]));
  const missing = wanted.filter((w) => !byWallet.has(w)).slice(0, 40);
  if (missing.length) for (const x of (await env.DB.prepare(`SELECT id, wallet, name, price, v, status FROM agents WHERE lower(wallet) IN (${missing.map(() => '?').join(',')})`).bind(...missing).all()).results) byWallet.set(address(x), x);
  for (const a of rows) {
    a.hires = pairs.filter((p) => p.boss === a.id).map((p) => ({ agent_id: p.worker, runs: p.runs, paid: String(p.paid) }));
    a.hired_by = pairs.filter((p) => p.worker === a.id).map((p) => ({ agent_id: p.boss, runs: p.runs, paid: String(p.paid) }));
    const listed = lists.get(a.id).map((w) => byWallet.get(w)).filter(Boolean);
    a.can_hire = listed.map((x) => x.id);
    // The same list with what a customer needs to see before paying: during a run this agent may pay these agents.
    a.can_hire_agents = listed.map((x) => ({ agent_id: x.id, name: x.name, price: String(x.price), wallet: x.wallet }));
  }
}

const RECEIPT_COLS = 'r.id, r.agent_id, r.payer, r.paid, r.cost, r.status, r.pay_tx, r.charge_tx, r.attempts, r.tokens_in, r.tokens_out, r.input_hash, r.output_hash, r.created_at, r.finished_at, r.form, r.receipt_hash, r.model_id, r.refund_tx, r.refunded, r.parent, r.sub_paid, a.name, a.wallet, a.spec, a.spec_hash, a.v';
const SHOWN = "('ran', 'billed', 'unpaid', 'refunding', 'refunded')";

// GET /api/runs/{id}: the public receipt for one paid run. Anyone can recompute the charge from it.
// A version 3 run also shows the fingerprint its charge or refund carried on chain, and a refunded run shows what went back.
// A run that hired other agents lists each of those sub-runs as a receipt of its own; a sub-run names the run that paid for it.
export async function getRun(env, id) {
  if (!/^0x[0-9a-f]{64}$/i.test(id)) return null;
  const r = await env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.id = ? AND r.status IN ${SHOWN}`).bind(id.toLowerCase()).first();
  if (!r) return null;
  const out = receiptOf(env, r);
  if (r.v === 3 && !r.parent) {
    const subs = (await env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.parent = ? AND r.status IN ${SHOWN} ORDER BY r.created_at`).bind(r.id).all()).results;
    out.sub_runs = subs.map((x) => receiptOf(env, x));
  }
  return out;
}

function receiptOf(env, r) {
  const spec = JSON.parse(r.spec), model = spec.model in RATES ? spec.model : 'fast', markup = Number(env.MARKUP_BPS);
  const fee = r.cost == null ? null : Math.floor((r.cost * markup) / 1e4);
  return {
    run: r.id, status: r.status, agent: { id: r.agent_id, name: r.name, wallet: r.wallet, spec_hash: r.spec_hash },
    payer: r.payer, paid: String(r.paid), payment_tx: r.pay_tx, charge_tx: r.charge_tx, created_at: r.created_at, finished_at: r.finished_at,
    model: r.model_id || MODELS[model].id, attempts: r.attempts, tokens_in: r.tokens_in, tokens_out: r.tokens_out, rates: RATES[model],
    // cost = what the model calls cost (never less than tokens x rates) + the network charge; the wallet is charged cost + fee.
    network_cost: String(networkCost(r.v)), cost: r.cost == null ? null : String(r.cost), markup_bps: markup, fee: fee == null ? null : String(fee),
    charged_to_wallet: fee == null ? null : String(r.cost + fee), input_hash: r.input_hash, output_hash: r.output_hash,
    note: 'Amounts are USDG units (six decimals). Hashes are SHA-256 of the exact input and output text; the input hash is fixed when the payment is first presented. Runs made before receipts existed have no token counts or hashes.',
    ...(r.v === 3 ? {
      wallet_version: 3, payment_form: r.form === 'receive' ? 'ReceiveWithAuthorization' : 'TransferWithAuthorization',
      // The wallet contract publishes this value as `receipt` in the Charged event of the charge (or refund) transaction.
      receipt_hash: r.receipt_hash, receipt_formula: RECEIPT_FORMULA,
      receipt_fields: r.receipt_hash ? [r.id, r.model_id, r.tokens_in, r.tokens_out, r.cost ?? 0, r.input_hash ?? '', r.output_hash ?? ''].join('|') : null, // built from what was stored when the fingerprint was sealed
      // A refund: the run was charged what its attempts cost plus the network charge; `cost` and `fee` went to the treasury and `refunded` went back to the payer (or, if USDG would not deliver it, is parked in the wallet contract for the payer to claim with claimParked).
      refund_tx: r.refund_tx, refunded: r.refunded == null ? null : String(r.refunded),
      // What this run paid other agents and did not get back. It is charged to the wallet on chain as it is paid (no fee on top) and is not part of `cost`.
      paid_to_agents: String(r.sub_paid || 0),
      // On a sub-run: the run that paid for it. Its payer is the hiring agent's wallet and the payment came through that wallet's payAgent.
      ...(r.parent ? { parent: r.parent, payment_form: 'payAgent' } : {}),
    } : {}),
  };
}

const WITH_RUNS = "SELECT a.*, (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id AND r.status IN ('ran', 'billed', 'unpaid')) AS runs FROM agents a";

// GET /api/agents
export async function listAgents(env) {
  const rows = (await env.DB.prepare(WITH_RUNS + ' ORDER BY a.id DESC LIMIT 200').all()).results;
  await refresh(env, rows);
  await customers(env, rows);
  await relations(env, rows);
  const all = rows.map((a) => view(env, a, false));
  // A retired agent (replaced by a newer one) leaves the floor, but what it earned still counts. So does one its owner now meters.
  const agents = all.filter((a) => a.status !== 'retired' && a.status !== 'self-run');
  const sum = (k) => all.reduce((n, a) => n + BigInt(a.stats?.[k] || 0), 0n).toString();
  return json({ agents, totals: { agents: agents.length, runs: all.reduce((n, a) => n + a.runs, 0), income: sum('income'), profit: sum('profit') } }, 200, { 'cache-control': 'private, max-age=20' });
}

export const findAgent = (env, id) => /^\d{1,9}$/.test(id) ? env.DB.prepare(WITH_RUNS + ' WHERE a.id = ?').bind(Number(id)).first() : null;

// GET /api/agents/:id
export async function getAgent(env, a) {
  await refresh(env, [a]);
  await customers(env, [a]);
  await relations(env, [a]);
  // All the $LUX ever burned to feature this agent, in whole tokens. Amounts are kept in token units (18 decimals), as text.
  // (If the burns table is missing the agent's page must still load, so that reads as nothing burned.)
  const burns = (await env.DB.prepare('SELECT amount FROM burns WHERE agent_id = ?').bind(a.id).all().catch(() => ({ results: [] }))).results;
  a.lux_burned = wholeTokens(burns.reduce((n, b) => n + BigInt(b.amount), 0n));
  const runs =(await env.DB.prepare("SELECT id, payer, paid, cost, status, pay_tx, charge_tx, created_at FROM runs WHERE agent_id = ? AND status IN ('ran', 'billed', 'unpaid') ORDER BY created_at DESC LIMIT 20").bind(a.id).all()).results;
  return json({ agent: view(env, a, true), recent: runs }, 200, { 'cache-control': 'private, max-age=15' });
}

// GET /card/<specHash>.json: the ERC-8004 registration file an identity points at.
export async function card(env, hash) {
  const a = await env.DB.prepare('SELECT * FROM agents WHERE spec_hash = ?').bind(hash).first();
  if (!a) return json({ error: 'not found' }, 404);
  const spec = JSON.parse(a.spec);
  return json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: spec.name,
    description: spec.tagline || spec.job,
    image: 'https://zerolux.fun/media/lux-token-6.png',
    external_url: `https://zerolux.fun/a/${a.id}`,
    services: [
      { name: 'web', endpoint: `https://zerolux.fun/a/${a.id}` },
      // The layout other Robinhood Chain projects read to list an agent for hire: a price, the network and who is paid.
      { name: 'x402', endpoint: `https://zerolux.fun/a/${a.id}/run`, price: `${Number(a.price) / 1e6} USDG`, network: `eip155:${CHAIN_ID}`, payTo: a.wallet, docs: 'POST {"input": "..."} or GET ?input=...; https://zerolux.fun/skill.md' },
      { name: 'wallet', endpoint: `eip155:${CHAIN_ID}:${a.wallet}` },
      { name: 'MCP', endpoint: 'https://zerolux.fun/mcp', version: '2025-06-18' },
    ],
    x402Support: true,
    active: a.status === 'live' && !selfRun(env, a, a.stats ? JSON.parse(a.stats) : null),
    registrations: a.identity_id ? [{ agentId: Number(a.identity_id), agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY}` }] : [],
    supportedTrust: ['reputation'],
    zerolux: { agent: a.id, wallet: a.wallet, factory: factoryOf(env, a), price: String(a.price), asset: USDG, specHash: a.spec_hash },
  }, 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
}

// GET /api/config: addresses and the function selectors a browser wallet needs.
export function config(env) {
  const sel = (sig) => toFunctionSelector(sig);
  const version = newAgentVersion(env);
  const lux = luxConfig(env);
  return json({
    // $LUX: burning `featureAmount` whole tokens (a transfer to `burnAddress` with the agent's number as one extra word of calldata) features an agent on the market for `featureDays` days.
    // `open` is false until the first block burns may come from has been set; the endpoint accepts nothing before then.
    lux: { address: lux.address, burnAddress: lux.burnAddress, featureAmount: lux.featureAmount, featureDays: lux.featureDays, open: lux.open },
    // `factory` is where new agents are made and `newAgentVersion` its wallet version; `factories` is every factory an agent here may have come from.
    chainId: CHAIN_ID, chainName: 'Robinhood Chain', explorer: EXPLORER, usdg: USDG, factory: factoryOf(env, { v: version }), newAgentVersion: version,
    factories: [env.FACTORY, env.FACTORY2, env.FACTORY3].filter(Boolean), factoryByVersion: { 1: env.FACTORY || null, 2: env.FACTORY2 || null, 3: env.FACTORY3 || null }, treasury: env.TREASURY,
    markupBps: Number(env.MARKUP_BPS), identity: IDENTITY, models: modelsFor(version), tools: TOOLS,
    // What a run is charged: tokens in and out at these rates (USDG units, six decimals, per token), plus the network charge, plus the markup.
    // `networkCost` is the charge for the version new agents get; `networkCosts` lists it for every wallet version.
    rates: RATES, networkCost: networkCost(version), networkCosts: NETWORK_COST,
    selectors: {
      withdraw: sel('withdraw(address,address,uint256)'), setLimits: sel('setLimits(uint128,uint128)'), setPaused: sel('setPaused(bool)'),
      setLien: sel('setLien(address,uint16,uint128)'), settleLien: sel('settleLien()'), endLien: sel('endLien()'),
      setAgentWallet: sel('setAgentWallet(uint256,address,uint256,bytes)'), setPayable: sel('setPayable(address,bool)'),
    },
  }, 200, { 'cache-control': 'private, max-age=300' });
}
