// Agent profiles: POST /api/agents/:id/profile (the owner sets it), GET /api/agents/:id/photo (anyone reads the picture),
// DELETE /api/agents/:id/profile (Zero Lux takes a profile down, with the build key).
//
// Who may set a profile: the address the agent's wallet contract names as its owner, read from the chain at the moment of
// the request, proved by a signed message (no transaction, no gas). The message names the agent, the exact picture by its
// SHA-256, every text field and a time; it is good for ten minutes and never for a time at or before the one last used.
// The Worker keeps the picture in D1. It is served as an image and nothing else: fixed type, no sniffing, no script.
import { recoverMessageAddress } from 'viem';
import { reader, walletAbi } from './chain.js';
import { json, allow, clientKey, readJson } from './line.js';
import { PHOTO_MAX, cleanProfile, fromBase64, hex, profileMessage, sniff, timeOk } from './profile.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Profiles for a list of agent rows, attached as row.profile. Never the picture itself: only its fingerprint.
// If the table is not there yet the pages must still load, so that reads as no profiles.
export async function profiles(env, rows) {
  if (!rows.length) return;
  const got = (await env.DB.prepare('SELECT agent_id, photo_hash, tagline, x, site FROM profiles').all().catch(() => ({ results: [] }))).results;
  const by = new Map(got.map((p) => [p.agent_id, p]));
  for (const a of rows) a.profile = by.get(a.id) || null;
}

export const photoPath = (id, p) => (p?.photo_hash ? `/api/agents/${id}/photo?v=${p.photo_hash.slice(0, 16)}` : null);

export async function setProfile(request, env, a) {
  const body = await readJson(request, 460_000); if (!body) return json({ error: 'Send JSON, 300 KB of picture at most.' }, 400);
  if (!(await allow(env, 'profile:' + clientKey(request), 40))) return json({ error: 'That is enough changes for today. Come back tomorrow.' }, 429);
  if (!(await allow(env, 'profile:a' + a.id, 30))) return json({ error: 'This agent\'s profile has been changed enough for today. Come back tomorrow.' }, 429);

  const clean = cleanProfile(body); if (!clean.ok) return json({ error: clean.error }, 400);
  // First step, nothing signed yet: the page sends what it wants to save and gets back the exact words for the owner to sign,
  // with every field as it will be stored. The picture is named by its SHA-256 only; it is sent with the signature.
  if (body.prepare === true) {
    const tag = body.photo === undefined ? 'keep' : body.photo === null ? 'none' : String(body.photo);
    if (!/^(keep|none|sha256:[0-9a-f]{64})$/.test(tag)) return json({ error: 'That picture could not be read.' }, 400);
    const time = new Date().toISOString();
    return json({ ok: true, time, tagline: clean.tagline, x: clean.x, site: clean.site, message: profileMessage({ id: a.id, photo: tag, tagline: clean.tagline, x: clean.x, site: clean.site, time }) });
  }
  if (!timeOk(body.time)) return json({ error: 'That signature is too old. Press save again.' }, 400);
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) return json({ error: 'The signature is missing.' }, 400);

  // The picture: a new one (base64), null to take it down, or left out to keep what is there.
  let photo = 'keep', bytes = null, type = null, hash = null;
  if (body.photo === null) photo = 'none';
  else if (body.photo !== undefined) {
    bytes = fromBase64(body.photo);
    if (!bytes || !bytes.length) return json({ error: 'That picture could not be read.' }, 400);
    if (bytes.length > PHOTO_MAX) return json({ error: 'That picture is too large. 300 KB at most.' }, 413);
    type = sniff(bytes); if (!type) return json({ error: 'The picture has to be a JPEG, PNG or WebP.' }, 415);
    hash = hex(await crypto.subtle.digest('SHA-256', bytes)); photo = 'sha256:' + hash;
  }

  const prev = await env.DB.prepare('SELECT signed_at, locked FROM profiles WHERE agent_id = ?').bind(a.id).first();
  if (prev?.locked) return json({ error: 'This agent\'s profile was taken down by Zero Lux and cannot be changed here.' }, 403);
  if (prev?.signed_at && body.time <= prev.signed_at) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);

  // Who owns the agent right now, from its wallet contract, and whether they signed exactly this.
  const message = profileMessage({ id: a.id, photo, tagline: clean.tagline, x: clean.x, site: clean.site, time: body.time });
  const c = reader(env);
  let owner;
  try { owner = await c.readContract({ address: a.wallet, abi: walletAbi, functionName: 'owner' }); }
  catch { return json({ error: 'The chain is not answering. Nothing was saved: try again in a minute.' }, 502); }
  let ok = false;
  try { ok = signature.length === 132 && same(await recoverMessageAddress({ message, signature }), owner); } catch {}
  // An owner that is a contract (a multisig) signs the contract way; the chain is asked whether it stands.
  if (!ok) { try { ok = await c.verifyMessage({ address: owner, message, signature }); } catch { ok = false; } }
  if (!ok) return json({ error: 'That was not signed by the wallet that owns this agent (' + owner.slice(0, 6) + '…' + owner.slice(-4) + ').' }, 403);

  const now = new Date().toISOString();
  const sets = 'tagline = excluded.tagline, x = excluded.x, site = excluded.site, updated_at = excluded.updated_at, updated_by = excluded.updated_by, signed_at = excluded.signed_at';
  const keepPhoto = photo === 'keep';
  // The older-signature check is repeated inside the write, so two saves arriving together cannot land out of order.
  const done = await env.DB.prepare(
    `INSERT INTO profiles (agent_id, photo, photo_type, photo_hash, tagline, x, site, updated_at, updated_by, signed_at, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (agent_id) DO UPDATE SET ${keepPhoto ? '' : 'photo = excluded.photo, photo_type = excluded.photo_type, photo_hash = excluded.photo_hash, '}${sets}
     WHERE profiles.locked = 0 AND (profiles.signed_at IS NULL OR profiles.signed_at < excluded.signed_at) RETURNING photo_hash, tagline, x, site`,
  ).bind(a.id, bytes ? bytes.buffer : null, type, hash, clean.tagline || null, clean.x || null, clean.site || null, now, owner, body.time).first();
  if (!done) return json({ error: 'A newer change has already been saved. Press save again.' }, 409);
  return json({ ok: true, agent: a.id, photo: photoPath(a.id, done), tagline: done.tagline, links: { x: done.x, site: done.site } });
}

// The picture itself. With ?v=<the start of its fingerprint> it never changes, so it can be kept for a year.
export async function getPhoto(request, env, id, url) {
  const p = await env.DB.prepare('SELECT photo, photo_type, photo_hash FROM profiles WHERE agent_id = ? AND photo IS NOT NULL').bind(Number(id)).first().catch(() => null);
  if (!p) return new Response(null, { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
  const v = url.searchParams.get('v'), pinned = !!v && p.photo_hash.startsWith(v);
  const etag = '"' + p.photo_hash.slice(0, 32) + '"';
  const headers = {
    'content-type': ['image/jpeg', 'image/png', 'image/webp'].includes(p.photo_type) ? p.photo_type : 'application/octet-stream',
    'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    etag, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline',
    'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin',
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(p.photo), { status: 200, headers });
}

// Zero Lux takes a profile down (a picture that should not be on the site). Needs the build key in x-build-key.
// With ?lock=1 the owner cannot put another up; ?lock=0 lets them again. The agent and its money are not touched.
export async function dropProfile(request, env, a, url) {
  if (!env.BUILD_KEY || request.headers.get('x-build-key') !== env.BUILD_KEY) return json({ error: 'not found' }, 404);
  const lock = url.searchParams.get('lock') === '1' ? 1 : 0, now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO profiles (agent_id, updated_at, updated_by, locked) VALUES (?, ?, 'zerolux', ?)
     ON CONFLICT (agent_id) DO UPDATE SET photo = NULL, photo_type = NULL, photo_hash = NULL, tagline = NULL, x = NULL, site = NULL, updated_at = excluded.updated_at, updated_by = 'zerolux', locked = excluded.locked`,
  ).bind(a.id, now, lock).run();
  return json({ ok: true, agent: a.id, locked: !!lock });
}
