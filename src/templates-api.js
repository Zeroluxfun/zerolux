// Starting an agent from something that already exists, and changing a draft before it is built.
//
//   GET  /api/templates                 the templates (src/templates.js)
//   POST /api/drafts                    {"template": key} | {"agent": number} | {"draft": hash}, with any of
//                                       "name", "tagline", "instructions", "input_hint" to change the wording
//                                       -> the same answer as /api/line: a draft to send to POST /api/agents
//   POST /api/agents/:id/copying        the owner lets, or stops, others starting a new agent from theirs
//
// No model writes anything here, so a draft from a template or an agent is free and instant. Wording the builder
// changes is checked against the same refusals as a new job before the draft is kept (review, src/revise.js).
// A template's own wording and a live agent's wording have been checked already.
//
// An agent's instructions are public (its page and /api/agents/:id show them), so another builder can start from any
// live agent unless its owner has switched that off. A copy takes the wording, the model, the built-in tools and the
// price. It never takes the wallet, the earnings, the reviews, the profile, the connected tool servers or their keys.
import { recoverMessageAddress } from 'viem';
import { reader, walletAbi } from './chain.js';
import { json, allow, clientKey, readJson, cleanSpec, specHash, modelsFor, newAgentVersion, MODELS, TOOLS, TOOL_FLOOR } from './line.js';
import { review } from './revise.js';
import { timeOk } from './profile.js';
import { TEMPLATES, findTemplate, fromText, readFrom, copyMessage } from './templates.js';

const FOREVER = '9999-12-31';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const WORDS = ['name', 'tagline', 'instructions', 'input_hint'];
const serial = () => [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('');

// GET /api/templates
export function listTemplates(env) {
  const version = newAgentVersion(env);
  return json({
    templates: TEMPLATES.map((t) => {
      const s = cleanSpec(t, t.job, version);
      return { key: t.key, name: s.name, tagline: s.tagline, job: s.job, input_hint: s.input_hint, example: t.example, best: t.best, model: s.model, model_name: MODELS[s.model].name, tools: s.tools, price: String(s.price), instructions: s.instructions };
    }),
    tools: TOOLS,
    note: 'POST /api/drafts {"template": "<key>"} returns a draft; POST /api/agents {"draft", "owner"} builds it. Send "name" or "instructions" with the draft request to change the wording first.',
  }, 200, { 'cache-control': 'public, max-age=300' });
}

// Whether an agent's owner has stopped others starting from it. A missing table reads as not stopped.
export const copyOff = async (env, id) => !!(await env.DB.prepare('SELECT off FROM copying WHERE agent_id = ?').bind(id).first().catch(() => null))?.off;

// POST /api/drafts
export async function makeDraft(request, env) {
  const body = await readJson(request, 30_000); if (!body) return json({ error: 'Send JSON.' }, 400);
  if (!(await allow(env, 'draft:' + clientKey(request), 80))) return json({ error: 'That is enough drafts for today. Come back tomorrow.' }, 429);
  if (!(await allow(env, 'draft:all', 5000))) return json({ error: 'The line is at capacity today.' }, 429);
  const version = newAgentVersion(env);

  // What the draft starts from.
  let base, from = null, source = null;
  if (body.template != null) {
    const t = findTemplate(body.template);
    if (!t) return json({ error: 'There is no template by that name. GET /api/templates lists them.' }, 404);
    base = cleanSpec(t, t.job, version); from = fromText('template', t.key); source = { template: t.key, name: t.name };
  } else if (body.agent != null) {
    const a = /^\d{1,9}$/.test(String(body.agent)) ? await env.DB.prepare('SELECT id, name, spec, status FROM agents WHERE id = ?').bind(Number(body.agent)).first() : null;
    if (!a) return json({ error: 'No agent with that number.' }, 404);
    if (a.status !== 'live') return json({ error: 'That agent is not live, so a new one cannot be started from it.' }, 409);
    if (await copyOff(env, a.id)) return json({ error: 'The owner of that agent does not let new agents be started from it.' }, 403);
    const s = JSON.parse(a.spec);
    // A copy gets a name of its own to begin with; its builder is expected to change it.
    base = cleanSpec({ ...s, name: ('Copy of ' + s.name).slice(0, 40).trim(), price_usd: s.price / 1e6 }, s.job, version);
    from = fromText('agent', a.id); source = { agent: a.id, name: a.name };
  } else if (body.draft != null) {
    const row = await env.DB.prepare('SELECT spec FROM drafts WHERE spec_hash = ?').bind(String(body.draft)).first();
    if (!row) return json({ error: 'Draft not found. Start again.' }, 404);
    base = JSON.parse(row.spec); from = base.from || null; source = readFrom(from);
  } else return json({ error: 'Send "template", "agent" or "draft".' }, 400);

  // The builder's own wording over it.
  const sent = Object.fromEntries(WORDS.filter((k) => typeof body[k] === 'string').map((k) => [k, body[k]]));
  if ('name' in sent && !sent.name.trim()) return json({ error: 'The agent needs a name.' }, 400);
  let spec;
  try { spec = cleanSpec({ ...base, ...sent, price_usd: base.price / 1e6 }, base.job, version); } catch { return json({ error: 'Write at least 40 characters of instructions.' }, 400); }
  const changed = WORDS.some((k) => spec[k] !== base[k]);
  if (body.draft != null && !changed) return json({ draft: String(body.draft), spec: base, models: modelsFor(version), tools: TOOLS, tool_floor: TOOL_FLOOR, ...(source ? { from: source } : {}) });

  // Changed wording is checked once per exact wording; wording that passed is remembered by its fingerprint.
  if (changed) {
    const mark = 'okspec:' + specHash(spec);
    if (!(await env.DB.prepare('SELECT 1 FROM limits WHERE k = ? AND day = ?').bind(mark, FOREVER).first())) {
      if (!(await allow(env, 'draftcheck:' + clientKey(request), 20))) return json({ error: 'You have changed enough drafts for today. Come back tomorrow.' }, 429);
      let no;
      try { no = await review(env, spec).catch(() => review(env, spec)); } catch { return json({ error: 'The change could not be checked just now. Try again in a minute.' }, 502); }
      if (no) return json({ error: no }, 422);
      await env.DB.prepare('INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, ?, 1)').bind(mark, FOREVER).run();
    }
  }
  // Where it came from stays on the spec, with a serial so two builders starting from the same thing get two agents.
  if (from) { spec.from = from; spec.serial = serial(); }
  const hash = specHash(spec);
  await env.DB.prepare('INSERT OR IGNORE INTO drafts (spec_hash, spec, created_at) VALUES (?, ?, ?)').bind(hash, JSON.stringify(spec), new Date().toISOString()).run();
  return json({ draft: hash, spec, models: modelsFor(version), tools: TOOLS, tool_floor: TOOL_FLOOR, ...(source ? { from: source } : {}) });
}

// POST /api/agents/:id/copying {"allow", "time", "signature"} (with "prepare": true it returns the words to sign).
// Proved the same way as a profile change: a message signed by the address the agent's wallet contract names as its owner.
export async function setCopying(request, env, a) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  if (!(await allow(env, 'copyset:' + clientKey(request), 60))) return json({ error: 'That is enough changes for today. Come back tomorrow.' }, 429);
  if (typeof body.allow !== 'boolean') return json({ error: 'Send "allow": true or false.' }, 400);
  const ok0 = body.allow;
  if (body.prepare === true) { const time = new Date().toISOString(); return json({ ok: true, time, allow: ok0, message: copyMessage({ id: a.id, allow: ok0, time }) }); }
  if (!timeOk(body.time)) return json({ error: 'That signature is too old. Press save again.' }, 400);
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) return json({ error: 'The signature is missing.' }, 400);
  const message = copyMessage({ id: a.id, allow: ok0, time: body.time });
  const c = reader(env);
  let owner;
  try { owner = await c.readContract({ address: a.wallet, abi: walletAbi, functionName: 'owner' }); }
  catch { return json({ error: 'The chain is not answering. Nothing was saved: try again in a minute.' }, 502); }
  let ok = false;
  try { ok = signature.length === 132 && same(await recoverMessageAddress({ message, signature }), owner); } catch {}
  if (!ok) { try { ok = await c.verifyMessage({ address: owner, message, signature }); } catch { ok = false; } }
  if (!ok) return json({ error: 'That was not signed by the wallet that owns this agent (' + owner.slice(0, 6) + '…' + owner.slice(-4) + ').' }, 403);
  const done = await env.DB.prepare(
    `INSERT INTO copying (agent_id, off, signer, signed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (agent_id) DO UPDATE SET off = excluded.off, signer = excluded.signer, signed_at = excluded.signed_at, updated_at = excluded.updated_at
     WHERE copying.signed_at < excluded.signed_at`,
  ).bind(a.id, ok0 ? 0 : 1, owner, body.time, new Date().toISOString()).run();
  if (!done.meta.changes) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);
  return json({ ok: true, agent: a.id, allow: ok0 });
}
