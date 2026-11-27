// The line: a written job goes in, an agent spec comes out, and the spec is
// put on chain as an agent with its own wallet and ERC-8004 identity.
import { keccak256, toHex, getAddress, isAddress, decodeEventLog } from 'viem';
import { factoryAbi, factoryOf, signer, USDG, IDENTITY } from './chain.js';
import { feeFor } from './lock.js';

// The models a builder can choose from. The line suggests Fast or Smart from the job; the builder may pick any of them
// before launch. `rate` is what the provider lists, in dollars per million tokens (in, out), checked 2026-11-22: a run is
// charged what its model calls cost, so a dearer model has a higher lowest price (about 0.075 x its input rate, which
// leaves room for a run that reads pages and uses tools). The key is what a spec stores; never reuse or rename one.
export const MODELS = {
  fast: { id: 'anthropic/claude-haiku-5.5', label: 'Fast', name: 'Claude Haiku 5.5', maker: 'Anthropic', rate: [0.1, 0.5], minPrice: 20_000 }, // $0.02
  smart: { id: 'anthropic/claude-sonnet-5.5', label: 'Smart', name: 'Claude Sonnet 5.5', maker: 'Anthropic', rate: [2, 10], minPrice: 150_000 }, // $0.15
  grok: { id: 'x-ai/grok-4.7', label: 'Grok 4.7', name: 'Grok 4.7', maker: 'xAI', rate: [2, 6], minPrice: 150_000 }, // $0.15
  gemini: { id: 'google/gemini-4-neon', label: 'Gemini 4 Neon', name: 'Gemini 4 Neon', maker: 'Google', rate: [3, 15], minPrice: 250_000 }, // $0.25
  opus: { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', name: 'Claude Opus 5.5', maker: 'Anthropic', rate: [4, 20], minPrice: 300_000 }, // $0.30
  gpt: { id: 'openai/gpt-6.2-astra', label: 'GPT-6.2 Astra', name: 'GPT-6.2 Astra', maker: 'OpenAI', rate: [8, 40], minPrice: 600_000 }, // $0.60
  fable: { id: 'anthropic/claude-fable-5.2', label: 'Claude Fable 5.2', name: 'Claude Fable 5.2', maker: 'Anthropic', rate: [8, 40], minPrice: 600_000 }, // $0.60
};
export const isModel = (k) => typeof k === 'string' && Object.hasOwn(MODELS, k);
export const TOOLS = {
  web_search: 'Search the live web',
  fetch_url: 'Read a public web page',
  market_data: 'Live prices: coins, tokens and stock tokens',
  read_chain: 'Read Robinhood Chain: balances, tokens, contracts and transactions',
  make_image: 'Make pictures',
  calculate: 'Exact arithmetic',
  remember: 'Keep notes about each customer between runs',
};
// A search and a picture cost money of their own each time, so an agent that has one cannot be priced below what a run using it costs.
export const TOOL_FLOOR = { web_search: 50_000, make_image: 100_000 }; // $0.05, $0.10
const MAX_PRICE = 2_000_000; // $2
// A version 3 run carries a larger network charge (see NETWORK_COST in run.js), so its cheapest price is higher.
const MIN_PRICE_V3 = { fast: 50_000 }; // $0.05; Smart stays at $0.15
export const minPrice = (model, version, tools = []) => Math.max((version >= 3 && MIN_PRICE_V3[model]) || MODELS[model].minPrice, ...tools.map((t) => TOOL_FLOOR[t] || 0));
// The model list as a client should read it for agents of one wallet version.
export const modelsFor = (version) => Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { ...m, minPrice: minPrice(k, version) }]));
// The wallet version a new agent gets when its maker has no say: NEW_AGENT_VERSION, if that factory is configured.
export const newAgentVersion = (env) => {
  const v = Number(env.NEW_AGENT_VERSION || 2);
  return [1, 2, 3, 4].includes(v) && factoryOf(env, { v }) ? v : env.FACTORY2 ? 2 : 1;
};
// The same test the product gate uses: the build key in a header, or the cookie that holds its hash.
export async function hasBuildKey(request, env) {
  const key = env.BUILD_KEY; if (!key) return false;
  if (request.headers.get('x-build-key') === key) return true;
  const pass = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zl-build:' + key)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (request.headers.get('cookie') || '').split(/;\s*/).includes('zl_build=' + pass);
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const today = () => new Date().toISOString().slice(0, 10);

// Counts a use of `k` today and says whether it is still under `max`.
export async function allow(env, k, max) {
  const row = await env.DB.prepare(
    'INSERT INTO limits (k, day, n) VALUES (?, ?, 1) ON CONFLICT (k, day) DO UPDATE SET n = n + 1 RETURNING n',
  ).bind(k, today()).first();
  return row.n <= max;
}

// One key per visitor network: a whole IPv6 /64 counts as one address.
export const clientKey = (request) => {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
};

// Body of a JSON POST, or null. Refusing other content types stops another site's page from posting here unasked.
export async function readJson(request, max = 20_000) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') || 0) > max) return null;
  const text = await request.text().catch(() => '');
  if (text.length > max) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function chat(env, body, timeoutMs = 60_000) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.OPENROUTER_KEY, 'content-type': 'application/json', 'x-title': 'Zero Lux' },
    body: JSON.stringify({ ...body, usage: { include: true } }),
    signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
  });
  if (!res.ok) throw new Error('model provider answered ' + res.status);
  const out = await res.json();
  if (out.error || !out.choices?.[0]) throw new Error('model provider returned no answer');
  return out;
}

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
// For short display text: never cut a word in half.
const clipWords = (v, n) => { const t = clip(v, 400); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '…'; };

// Whatever the model wrote, the spec that leaves here has exactly these fields
// and stays inside these bounds. `version` is the wallet version the agent is for.
export function cleanSpec(raw, job, version = 2) {
  const model = isModel(raw?.model) ? raw.model : 'fast';
  const tools = [...new Set(Array.isArray(raw?.tools) ? raw.tools : [])].filter((t) => t in TOOLS);
  let price = Math.round(Number(raw?.price_usd) * 1e6);
  const floor = minPrice(model, version, tools);
  if (!Number.isFinite(price)) price = floor * 2;
  price = Math.min(MAX_PRICE, Math.max(floor, Math.round(price / 10_000) * 10_000));
  const spec = {
    v: 1,
    name: clip(raw?.name, 40) || 'Unnamed unit',
    tagline: clipWords(raw?.tagline, 150),
    job: clip(job, 1200),
    instructions: clip(raw?.instructions, 4000),
    input_hint: clip(raw?.input_hint, 140) || 'What should it work on?',
    model,
    tools,
    price,
  };
  if (spec.instructions.length < 40) throw new Error('the line could not build an agent from that job');
  return spec;
}

export const specHash = (spec) => keccak256(toHex(JSON.stringify(spec)));

const LINE_PROMPT = `You design a single-purpose AI agent that sells one job per call.
The user describes the job. Reply with ONLY a JSON object:
{
 "name": short product name, 2-4 words, no quotes, no emoji,
 "tagline": one plain sentence of at most 110 characters saying what the customer gets,
 "instructions": the full system prompt for the agent: its role, the steps it takes, what a finished answer contains, what it refuses, and how it formats output. 150-500 words. It must tell the agent to finish the job in one reply without asking follow-up questions.
 "input_hint": a short placeholder telling the customer what to send,
 "model": "fast" for simple lookups, rewriting, summarising, classification; "smart" for analysis, code, planning or anything a mistake would make costly,
 "tools": array from ["web_search","fetch_url","market_data","read_chain","make_image","calculate","remember"], only the ones the job needs. web_search if the job needs anything recent or needs to find sources. fetch_url if the job reads a web page the customer names or one a search finds. market_data if the job needs live prices of coins, tokens or stock tokens. read_chain if the job needs facts from Robinhood Chain: what an address or token is, a balance, a read-only contract call, or what a transaction did. make_image if a finished answer includes a picture made for the customer. calculate if the job has sums that must be right. remember if knowing a returning customer helps. The instructions must say when to use each tool the agent is given,
 "price_usd": a fair price per call between 0.02 and 5
}
If the job says the agent should hire, pay or pass part of the work to other agents, keep that in the instructions: its owner can give it a hire_agent tool that pays another agent out of the run and returns that agent's answer. Say when to use the tool and what to do with the answer, and never tell the agent not to hire. Do not put hire_agent in "tools".
Refuse (reply {"refuse": "one sentence why"}) if the job is illegal, is harassment, is sexual content involving minors, tries to impersonate a real company or person, or asks the agent to move money or trade for people.`;

// POST /api/line {job}
export async function line(request, env) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  const job = clip(body?.job, 1200);
  if (job.length < 12) return json({ error: 'Describe the job in a sentence or two.' }, 400);
  if (!(await allow(env, 'line:' + clientKey(request), 12))) return json({ error: 'That is enough drafts for today. Come back tomorrow.' }, 429);
  if (!(await allow(env, 'line:all', 600))) return json({ error: 'The line is at capacity today.' }, 429);

  let raw;
  try {
    const out = await chat(env, {
      model: MODELS.fast.id, max_tokens: 2600, temperature: 0.6, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: LINE_PROMPT }, { role: 'user', content: job }],
    });
    const text = out.choices[0].message.content || '';
    raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch { return json({ error: 'The line jammed. Try again.' }, 502); }
  if (raw?.refuse) return json({ error: clip(raw.refuse, 200) || 'The line will not build that.' }, 422);

  const version = newAgentVersion(env);
  let spec; try { spec = cleanSpec({ ...raw, model: raw?.model === 'smart' ? 'smart' : 'fast' }, job, version); } catch (e) { return json({ error: e.message }, 422); }
  const hash = specHash(spec);
  await env.DB.prepare('INSERT OR IGNORE INTO drafts (spec_hash, spec, created_at) VALUES (?, ?, ?)').bind(hash, JSON.stringify(spec), new Date().toISOString()).run();
  return json({ draft: hash, spec, models: modelsFor(version), tools: TOOLS, tool_floor: TOOL_FLOOR });
}

// POST /api/agents {draft, owner, price_usd?, tools?, model?, version?}: put a drafted agent on chain.
// The factory pays the gas; the owner address owns the wallet from the first block.
// New agents get the wallet version named by NEW_AGENT_VERSION. Only a caller holding the build key may name another.
export async function createAgent(request, env) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  const owner = String(body?.owner || '');
  if (!isAddress(owner) || /^0x0{40}$/i.test(owner)) return json({ error: 'Enter the wallet address that should own this agent.' }, 400);
  // A token or one of our own contracts cannot own an agent: nothing at those addresses could ever withdraw what it earns.
  const notOwners = [env.LUX, USDG, IDENTITY, env.FACTORY, env.FACTORY2, env.FACTORY3, env.FACTORY4, env.TREASURY, '0x000000000000000000000000000000000000dEaD'].filter(Boolean).map((x) => String(x).toLowerCase());
  if (notOwners.includes(owner.toLowerCase())) return json({ error: 'That is a contract address, not a wallet. Enter the address of the wallet that should own this agent: only it can withdraw what the agent earns.' }, 400);
  const row = await env.DB.prepare('SELECT spec FROM drafts WHERE spec_hash = ?').bind(String(body?.draft || '')).first();
  if (!row) return json({ error: 'Draft not found. Run the job through the line again.' }, 404);

  let version = newAgentVersion(env);
  if (body?.version != null && Number(body.version) !== version) {
    if (!(await hasBuildKey(request, env))) return json({ error: 'The wallet version cannot be chosen here.' }, 403);
    version = Number(body.version);
    if (![1, 2, 3, 4].includes(version) || !factoryOf(env, { v: version })) return json({ error: 'There is no factory for that wallet version.' }, 400);
  }
  const factory = factoryOf(env, { v: version });

  // The owner may change the price and the tools before launch; everything else is as drafted. A draft priced below what
  // this wallet version can run for is raised to its minimum, the same way a price the owner sets too low is.
  let spec = JSON.parse(row.spec);
  const drafted = spec; // a draft started from a template or another agent says so (src/templates-api.js)
  // The owner may also choose the tools: any of the list in TOOLS, in place of the ones the line picked.
  const pick = Array.isArray(body?.tools) ? body.tools.slice(0, 12).map(String) : null;
  // And the model: any key of MODELS, in place of the one the line suggested. A dearer model raises the lowest price.
  const model = body?.model != null && body.model !== spec.model ? body.model : null;
  if (model && !isModel(model)) return json({ error: 'There is no model by that name. Choose one of: ' + Object.keys(MODELS).join(', ') + '.' }, 400);
  if (pick || model || body?.price_usd != null || spec.price < minPrice(spec.model, version, spec.tools)) spec = cleanSpec({ ...spec, ...(pick ? { tools: pick } : {}), ...(model ? { model } : {}), price_usd: body?.price_usd != null ? Number(body.price_usd) : spec.price / 1e6 }, spec.job, version);
  if (drafted.from && !spec.from) { spec.from = drafted.from; spec.serial = drafted.serial; }
  const hash = specHash(spec);
  if (await env.DB.prepare('SELECT 1 FROM agents WHERE spec_hash = ?').bind(hash).first()) return json({ error: 'This exact agent is already on the line.' }, 409);

  // The fee rate this agent's wallet is made with: the standard one, or a lower one if its owner has enough $LUX locked
  // for long enough (src/lock.js). It is read from the chain now and is then fixed for the life of the agent.
  let feeBps;
  try { feeBps = await feeFor(env, owner, version); } catch { return json({ error: 'The chain is not answering, so this wallet\'s $LUX lock could not be read. Nothing was built: try again in a minute.' }, 502); }

  if (!(await allow(env, 'create:' + clientKey(request), 4))) return json({ error: 'You have put enough agents on the line today.' }, 429);
  if (!(await allow(env, 'create:all', 150))) return json({ error: 'The line is at capacity today.' }, 429);

  // Claim this spec before sending, so two requests at once cannot both put it on chain.
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, '9999-12-31', 1)").bind('claim:' + hash).run();
  if (!claim.meta.changes) return json({ error: 'This agent is already being put on the line.' }, 409);
  const unclaim = () => env.DB.prepare("DELETE FROM limits WHERE k = ? AND day = '9999-12-31'").bind('claim:' + hash).run();

  // A run can never cost the agent more than one call earns. The cap is on cost with the fee included, so on a
  // version 3 wallet it also covers the run's budget and fee, which together never exceed the price.
  const perRunCap = BigInt(spec.price);
  const perDayCap = BigInt(Math.max(spec.price * 50, 5_000_000)); // the most our billing key could ever charge in a day; the owner can change it
  const uri = `https://zerolux.fun/card/${hash}.json`;
  let tx;
  try {
    tx = await signer(env).send({
      to: factory, abi: 'factory', functionName: 'createAgent',
      args: [getAddress(owner), perRunCap, perDayCap, hash, uri, env.TREASURY, feeBps],
    });
  } catch { tx = { ok: false, stage: 'rpc' }; }
  if (!tx.ok) {
    if (tx.stage === 'revert' || tx.stage === 'rpc') await unclaim(); // nothing was sent; it can be tried again
    return json({ error: 'The chain did not take it. Try again in a minute.' }, 502);
  }

  let id, wallet, identity = null;
  for (const l of tx.logs) {
    if (l.address.toLowerCase() !== factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: factoryAbi, topics: l.topics, data: l.data });
      if (ev.eventName === 'AgentCreated') { id = Number(ev.args.id); wallet = ev.args.wallet; }
      if (ev.eventName === 'IdentityRegistered') identity = ev.args.identityId.toString();
    } catch {}
  }
  if (wallet == null) return json({ error: 'Created, but the receipt could not be read. Transaction ' + tx.hash }, 502);

  // Each factory numbers its agents from zero, so the site keeps its own running number, taken in the same statement.
  const made = await env.DB.prepare(
    `INSERT INTO agents (id, wallet, owner, name, spec, spec_hash, price, identity_id, create_tx, status, created_at, v, chain_id)
     SELECT COALESCE(MAX(id), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ? FROM agents RETURNING id`,
  ).bind(wallet, getAddress(owner), spec.name, JSON.stringify(spec), hash, spec.price, identity, tx.hash, new Date().toISOString(), version, id).first();
  return json({ id: made.id, wallet, identity, tx: tx.hash, version, price: String(spec.price), fee_bps: feeBps, standard_fee_bps: Number(env.MARKUP_BPS) });
}
