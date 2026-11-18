// The line: a written job goes in, an agent spec comes out, and the spec is
// put on chain as an agent with its own wallet and ERC-8004 identity.
import { keccak256, toHex, getAddress, isAddress, decodeEventLog } from 'viem';
import { factoryAbi, signer } from './chain.js';

export const MODELS = {
  fast: { id: 'anthropic/claude-haiku-5.5', label: 'Fast', minPrice: 20_000 }, // $0.02
  smart: { id: 'anthropic/claude-sonnet-5.5', label: 'Smart', minPrice: 150_000 }, // $0.15
};
export const TOOLS = {
  fetch_url: 'Read a public web page',
  remember: 'Keep notes about each customer between runs',
};
const MAX_PRICE = 2_000_000; // $2

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
// and stays inside these bounds.
export function cleanSpec(raw, job) {
  const model = raw?.model === 'smart' ? 'smart' : 'fast';
  const tools = [...new Set(Array.isArray(raw?.tools) ? raw.tools : [])].filter((t) => t in TOOLS);
  let price = Math.round(Number(raw?.price_usd) * 1e6);
  if (!Number.isFinite(price)) price = MODELS[model].minPrice * 2;
  price = Math.min(MAX_PRICE, Math.max(MODELS[model].minPrice, Math.round(price / 10_000) * 10_000));
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
 "tools": array from ["fetch_url","remember"]. fetch_url if the job needs live web pages. remember if knowing a returning customer helps,
 "price_usd": a fair price per call between 0.02 and 5
}
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
      model: MODELS.fast.id, max_tokens: 1400, temperature: 0.6, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: LINE_PROMPT }, { role: 'user', content: job }],
    });
    const text = out.choices[0].message.content || '';
    raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch { return json({ error: 'The line jammed. Try again.' }, 502); }
  if (raw?.refuse) return json({ error: clip(raw.refuse, 200) || 'The line will not build that.' }, 422);

  let spec; try { spec = cleanSpec(raw, job); } catch (e) { return json({ error: e.message }, 422); }
  const hash = specHash(spec);
  await env.DB.prepare('INSERT OR IGNORE INTO drafts (spec_hash, spec, created_at) VALUES (?, ?, ?)').bind(hash, JSON.stringify(spec), new Date().toISOString()).run();
  return json({ draft: hash, spec, models: MODELS, tools: TOOLS });
}

// POST /api/agents {draft, owner, price?}: put a drafted agent on chain.
// The factory pays the gas; the owner address owns the wallet from the first block.
export async function createAgent(request, env) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  const owner = String(body?.owner || '');
  if (!isAddress(owner) || /^0x0{40}$/i.test(owner)) return json({ error: 'Enter the wallet address that should own this agent.' }, 400);
  const row = await env.DB.prepare('SELECT spec FROM drafts WHERE spec_hash = ?').bind(String(body?.draft || '')).first();
  if (!row) return json({ error: 'Draft not found. Run the job through the line again.' }, 404);

  // The owner may change the price before launch; everything else is as drafted.
  let spec = JSON.parse(row.spec);
  if (body?.price_usd != null) spec = cleanSpec({ ...spec, price_usd: Number(body.price_usd) }, spec.job);
  const hash = specHash(spec);
  if (await env.DB.prepare('SELECT 1 FROM agents WHERE spec_hash = ?').bind(hash).first()) return json({ error: 'This exact agent is already on the line.' }, 409);

  if (!(await allow(env, 'create:' + clientKey(request), 4))) return json({ error: 'You have put enough agents on the line today.' }, 429);
  if (!(await allow(env, 'create:all', 150))) return json({ error: 'The line is at capacity today.' }, 429);

  // Claim this spec before sending, so two requests at once cannot both put it on chain.
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, '9999-12-31', 1)").bind('claim:' + hash).run();
  if (!claim.meta.changes) return json({ error: 'This agent is already being put on the line.' }, 409);
  const unclaim = () => env.DB.prepare("DELETE FROM limits WHERE k = ? AND day = '9999-12-31'").bind('claim:' + hash).run();

  const perRunCap = BigInt(spec.price); // a run can never cost the agent more than one call earns
  const perDayCap = BigInt(Math.max(spec.price * 200, 10_000_000));
  const uri = `https://zerolux.fun/card/${hash}.json`;
  let tx;
  try {
    tx = await signer(env).send({
      to: env.FACTORY, abi: 'factory', functionName: 'createAgent',
      args: [getAddress(owner), perRunCap, perDayCap, hash, uri, env.TREASURY, Number(env.MARKUP_BPS)],
    });
  } catch { tx = { ok: false, stage: 'rpc' }; }
  if (!tx.ok) {
    if (tx.stage === 'revert' || tx.stage === 'rpc') await unclaim(); // nothing was sent; it can be tried again
    return json({ error: 'The chain did not take it. Try again in a minute.' }, 502);
  }

  let id, wallet, identity = null;
  for (const l of tx.logs) {
    if (l.address.toLowerCase() !== env.FACTORY.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: factoryAbi, topics: l.topics, data: l.data });
      if (ev.eventName === 'AgentCreated') { id = Number(ev.args.id); wallet = ev.args.wallet; }
      if (ev.eventName === 'IdentityRegistered') identity = ev.args.identityId.toString();
    } catch {}
  }
  if (wallet == null) return json({ error: 'Created, but the receipt could not be read. Transaction ' + tx.hash }, 502);

  await env.DB.prepare(
    'INSERT INTO agents (id, wallet, owner, name, spec, spec_hash, price, identity_id, create_tx, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, wallet, getAddress(owner), spec.name, JSON.stringify(spec), hash, spec.price, identity, tx.hash, 'live', new Date().toISOString()).run();
  return json({ id, wallet, identity, tx: tx.hash });
}
