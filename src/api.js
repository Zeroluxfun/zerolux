// Read side: the floor (every agent with its on-chain record), one agent,
// the ERC-8004 card, and what a browser wallet needs to act on a wallet.
import { getAddress, toFunctionSelector } from 'viem';
import { reader, walletAbi, usdgAbi, registryAbi, USDG, CHAIN_ID, EXPLORER, IDENTITY } from './chain.js';
import { json, MODELS, TOOLS } from './line.js';

const address = (a) => String(a.wallet).toLowerCase();
const FRESH_MS = 60_000; // chain figures are re-read at most once a minute per agent

// One multicall for up to 40 wallets; everything a page shows about money.
async function refresh(env, rows) {
  const stale = rows.filter((a) => !a.stats_at || Date.now() - Date.parse(a.stats_at) > FRESH_MS).slice(0, 40);
  if (!stale.length) return;
  const c = reader(env);
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
    ];
  });
  let out;
  try { out = await c.multicall({ contracts: calls, allowFailure: true }); } catch { return; }
  const at = new Date().toISOString();
  const writes = [];
  stale.forEach((a, i) => {
    const r = out.slice(i * 10, i * 10 + 10);
    if (r.slice(0, 9).some((x) => x.status !== 'success')) return;
    const [income, charged, owner, paused, lien, lienUnpaid, withdrawable, unsettled, balance] = r.map((x) => x.result);
    const named = r[9].status === 'success' && !!a.identity_id && String(r[9].result).toLowerCase() === address(a);
    const stats = {
      income: income.toString(), charged: charged.toString(), profit: (income - charged).toString(), balance: balance.toString(),
      withdrawable: withdrawable.toString(), unsettled: unsettled.toString(), paused, named,
      lien: /^0x0{40}$/i.test(lien[0]) ? null : { payee: lien[0], bps: lien[1], cap: lien[2].toString(), paid: lien[3].toString(), unpaid: lienUnpaid.toString() },
    };
    a.stats = JSON.stringify(stats); a.stats_at = at; a.owner = owner;
    writes.push(env.DB.prepare('UPDATE agents SET stats = ?, stats_at = ?, owner = ? WHERE id = ?').bind(a.stats, at, owner, a.id));
  });
  if (writes.length) await env.DB.batch(writes);
}

function view(a, full) {
  const spec = JSON.parse(a.spec);
  const v = {
    id: a.id, name: a.name, tagline: spec.tagline, price: String(a.price), model: MODELS[spec.model]?.label, tools: spec.tools,
    wallet: a.wallet, owner: a.owner, status: a.status, identity: a.identity_id, created_at: a.created_at, version: a.v || 1,
    runs: a.runs ?? 0, stats: a.stats ? JSON.parse(a.stats) : null, stats_at: a.stats_at,
  };
  if (full) Object.assign(v, { job: spec.job, instructions: spec.instructions, input_hint: spec.input_hint, spec_hash: a.spec_hash, create_tx: a.create_tx });
  return v;
}

const WITH_RUNS = "SELECT a.*, (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id AND r.status IN ('ran', 'billed', 'unpaid')) AS runs FROM agents a";

// GET /api/agents
export async function listAgents(env) {
  const rows = (await env.DB.prepare(WITH_RUNS + ' ORDER BY a.id DESC LIMIT 200').all()).results;
  await refresh(env, rows);
  const all = rows.map((a) => view(a, false));
  // A retired agent (replaced by a newer one) leaves the floor, but what it earned still counts.
  const agents = all.filter((a) => a.status !== 'retired');
  const sum = (k) => all.reduce((n, a) => n + BigInt(a.stats?.[k] || 0), 0n).toString();
  return json({ agents, totals: { agents: agents.length, runs: all.reduce((n, a) => n + a.runs, 0), income: sum('income'), profit: sum('profit') } }, 200, { 'cache-control': 'private, max-age=20' });
}

export const findAgent = (env, id) => /^\d{1,9}$/.test(id) ? env.DB.prepare(WITH_RUNS + ' WHERE a.id = ?').bind(Number(id)).first() : null;

// GET /api/agents/:id
export async function getAgent(env, a) {
  await refresh(env, [a]);
  const runs = (await env.DB.prepare("SELECT id, payer, paid, cost, status, pay_tx, charge_tx, created_at FROM runs WHERE agent_id = ? AND status IN ('ran', 'billed', 'unpaid') ORDER BY created_at DESC LIMIT 20").bind(a.id).all()).results;
  return json({ agent: view(a, true), recent: runs }, 200, { 'cache-control': 'private, max-age=15' });
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
    image: 'https://zerolux.fun/media/lux-token-3.png',
    external_url: `https://zerolux.fun/a/${a.id}`,
    services: [
      { name: 'web', endpoint: `https://zerolux.fun/a/${a.id}` },
      // The layout other Robinhood Chain projects read to list an agent for hire: a price, the network and who is paid.
      { name: 'x402', endpoint: `https://zerolux.fun/a/${a.id}/run`, price: `${Number(a.price) / 1e6} USDG`, network: `eip155:${CHAIN_ID}`, payTo: a.wallet, docs: 'POST {"input": "..."} or GET ?input=...; https://zerolux.fun/skill.md' },
      { name: 'wallet', endpoint: `eip155:${CHAIN_ID}:${a.wallet}` },
      { name: 'MCP', endpoint: 'https://zerolux.fun/mcp', version: '2025-06-18' },
    ],
    x402Support: true,
    active: a.status === 'live',
    registrations: a.identity_id ? [{ agentId: Number(a.identity_id), agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY}` }] : [],
    supportedTrust: ['reputation'],
    zerolux: { agent: a.id, wallet: a.wallet, factory: a.v === 2 ? env.FACTORY2 : env.FACTORY, price: String(a.price), asset: USDG, specHash: a.spec_hash },
  }, 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
}

// GET /api/config: addresses and the function selectors a browser wallet needs.
export function config(env) {
  const sel = (sig) => toFunctionSelector(sig);
  return json({
    chainId: CHAIN_ID, chainName: 'Robinhood Chain', explorer: EXPLORER, usdg: USDG, factory: env.FACTORY2 || env.FACTORY, factories: [env.FACTORY, env.FACTORY2].filter(Boolean), treasury: env.TREASURY,
    markupBps: Number(env.MARKUP_BPS), identity: IDENTITY, models: MODELS, tools: TOOLS,
    selectors: {
      withdraw: sel('withdraw(address,address,uint256)'), setLimits: sel('setLimits(uint128,uint128)'), setPaused: sel('setPaused(bool)'),
      setLien: sel('setLien(address,uint16,uint128)'), settleLien: sel('settleLien()'), endLien: sel('endLien()'),
      setAgentWallet: sel('setAgentWallet(uint256,address,uint256,bytes)'),
    },
  }, 200, { 'cache-control': 'private, max-age=300' });
}
