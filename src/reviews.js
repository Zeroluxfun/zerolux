// Reviews. Whoever paid for a run and got its answer may rate it once: one to five stars and a few words.
//
// There are no sign-ins, so the proof of purchase is handed over with the answer itself: the reply to a paid run carries
// a `review` token (an HMAC of the run's id under a key only this Worker has). Only the party that received the answer
// has it. A run gets no token when it was a free sample, when its payer is the agent's own owner, or when one agent
// hired another. Reviews are public; the request and the answer never are.
//
//   POST   /api/runs/:id/review  {"token", "stars": 1..5, "text"?}   -> saved once; a second one is refused
//   DELETE /api/runs/:id/review  x-build-key                         -> Zero Lux hides one (abuse, private details)
//   GET    /api/agents/:id        -> agent.rating {count, average} and reviews [{stars, text, created_at, run}]
import { json, allow, clientKey, readJson } from './line.js';

const enc = new TextEncoder();
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const DELIVERED = "('ran', 'billed', 'unpaid')";
const RUN = `SELECT r.id, r.agent_id, r.payer, r.parent, r.status, a.owner,
  (SELECT 1 FROM credit_events e WHERE e.id = 'run:' || r.id AND e.meta LIKE '%"sample":1%') AS sample FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.id = ?`;
const mayReview = (r) => !!r && !r.parent && !r.sample && !same(r.payer, r.owner);

export async function reviewToken(env, run) {
  const root = env.SECRETS_KEY || env.OPERATOR_KEY; if (!root) throw new Error('no key');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('zerolux review tokens v1|' + root));
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', k, enc.encode(String(run).toLowerCase()))).slice(0, 40);
}
const timingSafe = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// The reply to a run that delivered gains its review token (or `sample: true` on a free sample). Anything else passes untouched.
export async function withReview(env, res) {
  if (res.status !== 200) return res;
  try {
    const d = await res.clone().json();
    if (!d || typeof d.output !== 'string' || !/^0x[0-9a-f]{64}$/.test(String(d.run))) return res;
    const r = await env.DB.prepare(RUN).bind(d.run).first();
    if (r?.sample) d.sample = true;
    else if (mayReview(r) && !(await env.DB.prepare('SELECT 1 FROM reviews WHERE run_id = ?').bind(d.run).first())) d.review = { token: await reviewToken(env, d.run), url: `/api/runs/${d.run}/review` };
    else return res;
    return new Response(JSON.stringify(d), { status: 200, headers: res.headers });
  } catch { return res; }
}

// A few plain words: no control characters, single spaces, 280 characters at most.
export const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);

export async function postReview(request, env, run) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON: {"token", "stars", "text"}.' }, 400);
  if (!(await allow(env, 'review:' + clientKey(request), 60))) return json({ error: 'Too many reviews from this network today.' }, 429);
  const stars = Number(body.stars), token = String(body.token || '');
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: 'Choose one to five stars.' }, 400);
  if (!/^0x[0-9a-f]{64}$/.test(run) || !timingSafe(token, await reviewToken(env, run))) return json({ error: 'Only the buyer of a run can review it. The review code comes with the answer.' }, 403);
  const r = await env.DB.prepare(RUN + ` AND r.status IN ${DELIVERED}`).bind(run).first();
  if (!mayReview(r)) return json({ error: 'This run cannot be reviewed.' }, 403);
  const text = cleanText(body.text);
  const made = await env.DB.prepare('INSERT OR IGNORE INTO reviews (run_id, agent_id, stars, body, hidden, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(run, r.agent_id, stars, text || null, new Date().toISOString()).run();
  if (!made.meta.changes) return json({ error: 'This run has already been reviewed.' }, 409);
  return json({ ok: true, run, agent: r.agent_id, stars, text: text || null });
}

export async function hideReview(request, env, run) {
  if (!env.BUILD_KEY || request.headers.get('x-build-key') !== env.BUILD_KEY) return json({ error: 'not found' }, 404);
  const done = await env.DB.prepare('UPDATE reviews SET hidden = 1 WHERE run_id = ?').bind(run).run();
  return json({ ok: true, run, hidden: done.meta.changes > 0 });
}

// Each agent's rating, attached as row.rating. A missing table reads as no reviews.
export async function ratings(env, rows) {
  if (!rows.length) return;
  const got = (await env.DB.prepare('SELECT agent_id, COUNT(*) AS n, AVG(stars) AS avg FROM reviews WHERE hidden = 0 GROUP BY agent_id').all().catch(() => ({ results: [] }))).results;
  const by = new Map(got.map((x) => [x.agent_id, x]));
  for (const a of rows) { const x = by.get(a.id); a.rating = x ? { count: x.n, average: Math.round(x.avg * 100) / 100 } : { count: 0, average: null }; }
}
export const latestReviews = async (env, id) => (await env.DB.prepare('SELECT run_id AS run, stars, body AS text, created_at FROM reviews WHERE agent_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 20').bind(id).all().catch(() => ({ results: [] }))).results;
