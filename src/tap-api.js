// Verified agents on the line (the check itself is src/tap.js).
//
//   Any request to run an agent, POST /a/:id/run, may carry a TAP signature. When it does, the signature is checked
//   before any money moves, and a run that goes ahead is marked on its public receipt: hired by a verified agent.
//   A signature that is refused stops the request (403), and one that could not be checked stops it too (503, try
//   again): a signed request never runs as an unsigned one.
//
//   POST /api/agents/:id/verified   the owner sets "verified agents only", with a signed message (no gas)
//   An agent set that way takes work only by a signed request. A person on the site, a standing order, a long job, a
//   free sample and another agent hiring it during a run are all refused, because none of them is a signed request.
//
// What a pass is tied to. This site has no member accounts: holding a payment is what entitles a caller to a run. The
// signature covers the whole body, so it covers the work and, for card credit, the ticket that names the run. A copy of
// a signed request can therefore only ever buy the run it was signed for, with the payment it was sent with, and the
// nonce store below holds it to that: a key and nonce are good for one run, and the same request for the same run
// (which this site asks callers to send again while a payment settles) is the only thing that may repeat them.
import { recoverMessageAddress } from 'viem';
import { reader, walletAbi } from './chain.js';
import { json, allow, clientKey, readJson } from './line.js';
import { timeOk } from './profile.js';
import { createVerifier, REGISTRY, DIRECTORY } from './tap.js';

const ORIGIN = 'https://zerolux.fun'; // what agents sign for, whatever address the request arrived at
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// Only when testing on this machine may the registry be somewhere else (a stand-in on this machine).
const registryOf = (env) => (env.DEV === '1' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(env.TAP_REGISTRY || '') ? env.TAP_REGISTRY : REGISTRY);
const verifiers = new Map();
const verifierFor = (origin) => { if (!verifiers.has(origin)) verifiers.set(origin, createVerifier({ registryOrigin: origin, reserveNonce: async () => false })); return verifiers.get(origin); };

export const ONLY_NOTE = 'This agent takes work only from verified agents: a request signed with the Trusted Agent Protocol by an agent listed in Visa CLI\'s registry. See zerolux.fun/docs#verified.';
export const verifiedOnly = async (env, id) => !!(await env.DB.prepare('SELECT required FROM tap_only WHERE agent_id = ?').bind(id).first().catch(() => null))?.required;
// Of these agents, the ones that take work only from verified agents.
export async function onlyAmong(env, ids) {
  if (!ids.length) return new Set();
  const rows = (await env.DB.prepare(`SELECT agent_id FROM tap_only WHERE required = 1 AND agent_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all().catch(() => ({ results: [] }))).results;
  return new Set(rows.map((r) => r.agent_id));
}

// Before a new payment is admitted. Answers { reply } to stop the request, or { tap } to go on: null for an unsigned
// request, and for a signed one that passed, what is kept on the run. `run` is the id the payment gives the run.
export async function tapGate(request, env, agent, rawBody, run) {
  const only = await verifiedOnly(env, agent.id);
  const signed = request.headers.has('signature-input') || request.headers.has('signature');
  if (!signed) return only ? { reply: json({ error: 'Nothing was charged. ' + ONLY_NOTE, code: 'verified_agents_only', final: true }, 403) } : { tap: null };
  if (!(await allow(env, 'tap:' + clientKey(request), 600))) return { reply: json({ error: 'Too many signed requests from this network today. Nothing was charged.' }, 429) };
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  // This site's own payment headers travel beside the signature and are not part of what an agent signs.
  delete headers['x-payment']; delete headers['payment-signature'];
  const url = new URL(request.url);
  const result = await verifierFor(registryOf(env))({
    method: request.method, publicOrigin: ORIGIN, target: url.pathname + url.search, headers, rawBody,
    // Cloudflare puts its own cf- headers on every request before this Worker sees it, and not all of them are on the
    // published list. Nothing here acts on one, so they may go unsigned. (mf- is the same thing on a developer's machine.)
    alsoTransport: (name) => name.startsWith('cf-') || (env.DEV === '1' && name.startsWith('mf-')),
    reserveNonce: async (id, expires) => {
      const made = await env.DB.prepare('INSERT OR IGNORE INTO tap_nonces (id, run, expires) VALUES (?, ?, ?)').bind(id, run, expires).run();
      if (made.meta.changes) return true;
      return (await env.DB.prepare('SELECT run FROM tap_nonces WHERE id = ?').bind(id).first())?.run === run;
    },
  });
  if (!result.ok && !result.judged) return { reply: json({ error: 'Nothing was charged. The signature could not be checked just now: sign the request again in a few seconds.', code: 'verifier_unavailable', detail: result.code }, 503, { 'retry-after': String(result.retryAfterSeconds ?? 5) }) };
  if (!result.ok) return { reply: json({ error: 'Nothing was charged. The signature on this request was refused. ' + result.message, code: 'verification_failed', detail: result.code, reason: result.reason, final: true }, 403) };
  // A key listed anywhere but Visa's production directory is a test listing, and is always shown as one.
  return { tap: { by: 'visa-cli', agent: result.agentId, key: result.keyId, name: String(result.agentName).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 80), test: result.directoryOrigin !== DIRECTORY, at: new Date().toISOString() } };
}

// The part of a public receipt that says a verified agent paid for the run.
export function receiptTap(text) {
  let t; try { t = JSON.parse(text || 'null'); } catch { t = null; }
  if (!t) return null;
  return {
    checked_with: "Visa CLI's registry (Trusted Agent Protocol)", agent_id: t.agent, key_id: t.key, agent_name: t.name, checked_at: t.at, test_listing: !!t.test,
    note: (t.test ? 'This key is a test listing, not one in Visa\'s production directory: it shows the request was signed, and no more. ' : '') + 'The request that paid for this run was signed by this agent\'s key, which was listed and active when checked. It says a person passed a card check to register the agent. It does not say who, or that the agent\'s work is good.',
  };
}

export const onlyMessage = ({ id, required, time }) => [
  `Zero Lux (zerolux.fun): agent ${id}`,
  `Take work only from verified agents: ${required ? 'yes' : 'no'}`,
  `Time: ${time}`,
  'Signing this costs nothing and moves no money.',
].join('\n');

// POST /api/agents/:id/verified {"required", "time", "signature"} (with "prepare": true it returns the words to sign).
// Proved the same way as a profile change: a message signed by the address the agent's wallet contract names as its owner.
export async function setVerifiedOnly(request, env, a) {
  const body = await readJson(request); if (!body) return json({ error: 'Send JSON.' }, 400);
  if (!(await allow(env, 'tapset:' + clientKey(request), 60))) return json({ error: 'That is enough changes for today. Come back tomorrow.' }, 429);
  if (typeof body.required !== 'boolean') return json({ error: 'Send "required": true or false.' }, 400);
  const required = body.required;
  if (body.prepare === true) { const time = new Date().toISOString(); return json({ ok: true, time, required, message: onlyMessage({ id: a.id, required, time }) }); }
  if (!timeOk(body.time)) return json({ error: 'That signature is too old. Press save again.' }, 400);
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) return json({ error: 'The signature is missing.' }, 400);
  const message = onlyMessage({ id: a.id, required, time: body.time });
  const c = reader(env);
  let owner;
  try { owner = await c.readContract({ address: a.wallet, abi: walletAbi, functionName: 'owner' }); }
  catch { return json({ error: 'The chain is not answering. Nothing was saved: try again in a minute.' }, 502); }
  let ok = false;
  try { ok = signature.length === 132 && same(await recoverMessageAddress({ message, signature }), owner); } catch {}
  if (!ok) { try { ok = await c.verifyMessage({ address: owner, message, signature }); } catch { ok = false; } }
  if (!ok) return json({ error: 'That was not signed by the wallet that owns this agent (' + owner.slice(0, 6) + '…' + owner.slice(-4) + ').' }, 403);
  const done = await env.DB.prepare(
    `INSERT INTO tap_only (agent_id, required, signer, signed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (agent_id) DO UPDATE SET required = excluded.required, signer = excluded.signer, signed_at = excluded.signed_at, updated_at = excluded.updated_at
     WHERE tap_only.signed_at < excluded.signed_at`,
  ).bind(a.id, required ? 1 : 0, owner, body.time, new Date().toISOString()).run();
  if (!done.meta.changes) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);
  return json({ ok: true, agent: a.id, required });
}

// From the timer: nonces whose signatures have long expired.
export const tapTick = (env) => env.DB.prepare('DELETE FROM tap_nonces WHERE expires < ?').bind(Math.floor(Date.now() / 1000) - 3600).run();
