// Bring your own tools: an owner connects an agent to tool servers of their own choosing, and the agent can call every
// tool those servers offer during a run. The servers speak MCP (Model Context Protocol) over HTTP, the standard AI
// clients already use, so anything published for them works here.
//
// How it is kept:
//  - A connection is part of the agent's spec, and so of its public, signed version history (src/revise.js): a name,
//    the server's address, the header its key travels in, a fingerprint of the key, and the tools the server offered
//    WHEN THE CONNECTION WAS SAVED (name, description, input schema). What the agent can call is that saved list,
//    not whatever the server says later: a server that changes its tools changes nothing until the owner saves again.
//  - The key itself is never in the spec. It is encrypted and kept in `conn_keys`, found by its fingerprint. The
//    fingerprint is an HMAC under a key only this Worker has, so it gives nothing away about the key.
//
// What a run may do with a connection:
//  - Only public https addresses, never an address on this site, never a redirect (the same rule as reading a web page).
//  - At most MAX_CALLS calls a run, each with a time limit, each answer cut to RESULT_CHARS.
//  - What a server returns is material, wrapped in <connected>, never an instruction; and a run that has called one
//    cannot save a note about its customer (the same rule as a run that has read a web page).
//  - Zero Lux pays nothing for these calls and holds no account with these servers: the owner's key, the owner's bill.
import { safeUrl } from './run.js';

export const MAX_CONNECTIONS = 3; // per agent
export const MAX_TOOLS = 24; // per connection
export const MAX_CALLS = 8; // per run, over all connections
export const RESULT_CHARS = 8_000;
const SPEC_BYTES = 150_000; // all of an agent's connections, as JSON
const NOT_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'cookie', 'connection', 'transfer-encoding', 'user-agent', 'mcp-session-id', 'mcp-protocol-version']);

const enc = new TextEncoder();
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// Two keys, for two jobs, both derived from one Worker secret (SECRETS_KEY if it is set, else the billing key).
// If that secret is ever replaced, saved connection keys can no longer be read and their owners enter them again.
const derived = async (env, label) => {
  const root = env.SECRETS_KEY || env.OPERATOR_KEY; if (!root) throw new Error('no key to keep secrets with');
  return crypto.subtle.digest('SHA-256', enc.encode(label + '|' + root));
};
const cipherKey = async (env) => crypto.subtle.importKey('raw', await derived(env, 'zerolux connection keys v1'), 'AES-GCM', false, ['encrypt', 'decrypt']);

// The public name of a secret: changes when the secret changes, and cannot be worked back to it.
export async function fingerprint(env, secret) {
  const k = await crypto.subtle.importKey('raw', await derived(env, 'zerolux connection key fingerprints v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'k:' + hexOf(await crypto.subtle.sign('HMAC', k, enc.encode(secret))).slice(0, 16);
}
export async function seal(env, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cipherKey(env), enc.encode(secret)));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  let bin = ''; for (const b of all) bin += String.fromCharCode(b);
  return btoa(bin);
}
export async function unseal(env, sealed) {
  const bin = atob(sealed), all = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) all[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await cipherKey(env), all.slice(12)));
}
// The key a connection of this agent is called with, or null if it has none (or it can no longer be read).
export async function secretOf(env, agentId, conn) {
  if (!conn.key) return null;
  const row = await env.DB.prepare('SELECT enc FROM conn_keys WHERE agent_id = ? AND fp = ?').bind(agentId, conn.key).first().catch(() => null);
  if (!row) return null;
  try { return await unseal(env, row.enc); } catch { return null; }
}

// A tool server's address: public https, as for a web page an agent reads. Local testing only (DEV is never set on
// the deployed Worker): a server on this machine over plain http.
export function connUrl(env, raw) {
  const text = String(raw ?? '').trim(); if (!text || text.length > 300) return null;
  if (env.DEV === '1') { try { const u = new URL(text); if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u; } catch { return null; } }
  const u = safeUrl(text);
  return u && !u.hash ? u : null;
}

const line = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// A server's tools as an agent keeps them: a name, a description and an input schema, each inside bounds. A tool that
// does not fit is left out and named in `skipped`. Cleaning a cleaned list gives the same list.
export function cleanTools(list) {
  const tools = [], skipped = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const name = typeof t?.name === 'string' ? t.name : '';
    if (!/^[A-Za-z0-9_.\/-]{1,80}$/.test(name) || seen.has(name)) { if (name) skipped.push(line(name, 80)); continue; }
    let schema = t.schema ?? t.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') schema = { type: 'object', properties: {} };
    let size; try { size = JSON.stringify(schema).length; } catch { size = Infinity; }
    if (size > 3_000 || tools.length >= MAX_TOOLS) { skipped.push(name); continue; }
    seen.add(name);
    tools.push({ name, description: line(t.description, 400), schema: JSON.parse(JSON.stringify(schema)) });
  }
  return { tools, skipped };
}

// The name the model calls a connected tool by: its connection's place in the list, then the tool's own name.
export const functionName = (i, name) => ('c' + (i + 1) + '_' + name.replace(/[^a-zA-Z0-9_-]/g, '_')).slice(0, 64);

// ---- talking to a server ----

// Read a response body up to a size. For an event stream, stop as soon as the answer to request `id` has arrived.
async function readAnswer(res, id, stream) {
  const rd = res.body.getReader(), dec = new TextDecoder(); let text = '', size = 0;
  const found = () => {
    for (const ev of text.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { const m = JSON.parse(data); if (m && m.id === id && ('result' in m || 'error' in m)) return m; } catch {}
    }
    return null;
  };
  try {
    while (size < 600_000) {
      const { done, value } = await rd.read(); if (done) break;
      size += value.length; text += dec.decode(value, { stream: true });
      if (stream) { const m = found(); if (m) return m; }
    }
  } finally { rd.cancel().catch(() => {}); }
  if (stream) return found();
  try { return JSON.parse(text); } catch { return null; }
}

// One request to a server. `sess` carries the session the server opened and the protocol version it agreed to.
async function rpc(env, conn, secret, sess, method, params, ms, notify = false) {
  const u = connUrl(env, conn.url); if (!u) throw new Error('its address is not allowed');
  const header = conn.header || 'authorization';
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'ZeroLuxAgent/1.0' };
  if (sess.version) headers['mcp-protocol-version'] = sess.version;
  if (sess.id) headers['mcp-session-id'] = sess.id;
  if (secret) headers[header] = header === 'authorization' && !/^(bearer|basic) /i.test(secret) ? 'Bearer ' + secret : secret;
  const id = ++sess.n;
  const res = await fetch(u, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(Math.max(1_000, ms)) });
  const sid = res.headers.get('mcp-session-id'); if (sid && sid.length <= 300) sess.id = sid;
  if (notify) { res.body?.cancel().catch(() => {}); return null; }
  if (res.status === 401 || res.status === 403) { res.body?.cancel().catch(() => {}); throw new Error(secret ? 'it refused the key' : 'it asks for a key'); }
  if (res.status >= 300) { res.body?.cancel().catch(() => {}); throw new Error('it answered ' + res.status); }
  const m = await readAnswer(res, id, (res.headers.get('content-type') || '').includes('text/event-stream'));
  if (!m || typeof m !== 'object') throw new Error('it did not answer as a tool server');
  if (m.error) throw new Error('it said: ' + line(m.error.message, 160));
  return m.result ?? {};
}

// Open a session: say hello, note what the server agreed to, and tell it we are ready.
async function hello(env, conn, secret, sess, ms) {
  if (sess.ready) return;
  const r = await rpc(env, conn, secret, sess, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zerolux', version: '1' } }, ms);
  sess.version = /^\d{4}-\d{2}-\d{2}$/.test(String(r.protocolVersion)) ? r.protocolVersion : '2025-06-18';
  await rpc(env, conn, secret, sess, 'notifications/initialized', undefined, Math.min(ms, 5_000), true).catch(() => {});
  sess.ready = true;
}
export const session = () => ({ n: 0, id: null, version: null, ready: false });

// The tools a server offers right now, cleaned. Throws with a plain reason if it cannot be reached or is not one.
export async function listTools(env, conn, secret) {
  const sess = session();
  await hello(env, conn, secret, sess, 10_000);
  const all = []; let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await rpc(env, conn, secret, sess, 'tools/list', cursor ? { cursor } : undefined, 10_000);
    all.push(...(Array.isArray(r.tools) ? r.tools : []));
    cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    if (!cursor || all.length >= 200) break;
  }
  return cleanTools(all);
}

// Call one tool and give back what it said as text. Never throws: a failure comes back as a sentence the agent can read.
export async function callTool(env, conn, secret, sess, name, args, ms) {
  try {
    await hello(env, conn, secret, sess, Math.min(ms, 10_000));
    const r = await rpc(env, conn, secret, sess, 'tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, ms);
    const parts = (Array.isArray(r.content) ? r.content : []).map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type ? `[${line(c.type, 20)} left out]` : '')).filter(Boolean);
    let text = parts.join('\n').trim();
    if (!text && r.structuredContent != null) text = JSON.stringify(r.structuredContent);
    text = text || 'The tool returned nothing.';
    // Say so when an answer is cut, so the agent knows the rest is missing and can ask the tool for less.
    if (text.length > RESULT_CHARS) text = text.slice(0, RESULT_CHARS) + `\n[Cut here: this is the first ${RESULT_CHARS} of ${text.length} characters. The rest was not read. Ask the tool for a narrower answer if you need it.]`;
    return (r.isError ? 'The tool reported an error: ' : '') + text;
  } catch (e) { return 'The connected tool did not work: ' + line(e?.name === 'TimeoutError' ? 'it took too long' : e?.message, 200) + '. Carry on without it.'; }
}

// ---- saving connections (called from src/revise.js) ----

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// The connections an edit asks for, checked, as they will be stored in the spec, with the keys to keep beside them.
// Each item: { name, url, header?, secret? | key?, tools? }. `secret` is a new key; `key` is the fingerprint of one
// already saved for this agent; neither means the server needs none. With no `tools` the server is asked for its list.
export async function buildConnections(env, agent, cur, raw) {
  if (!Array.isArray(raw)) throw fail('Connections must be a list.');
  if (raw.length > MAX_CONNECTIONS) throw fail(`An agent can have at most ${MAX_CONNECTIONS} connections.`);
  const list = [], keep = [], names = new Set(), skipped = {};
  for (const item of raw) {
    const name = line(item?.name, 30);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) throw fail('Give each connection a short name: letters, numbers, spaces, dots and dashes.');
    if (names.has(name.toLowerCase())) throw fail(`Two connections are both called "${name}".`);
    names.add(name.toLowerCase());
    const u = connUrl(env, item?.url);
    if (!u) throw fail(`Connection "${name}": the address has to be a public https address.`);
    const header = String(item?.header || 'authorization').toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(header) || NOT_HEADERS.has(header)) throw fail(`Connection "${name}": that is not a header a key can travel in.`);
    let key = null, secret = null;
    if (item?.secret != null && item.secret !== '') {
      secret = String(item.secret);
      if (!/^[\x21-\x7e][\x20-\x7e]{0,499}$/.test(secret)) throw fail(`Connection "${name}": the key has to be plain characters, 500 at most.`);
      key = await fingerprint(env, secret); keep.push({ fp: key, enc: await seal(env, secret) });
    } else if (item?.key != null && item.key !== '') {
      key = String(item.key);
      // A saved key goes only where its owner already sent it: the same address and header as a connection the agent has now.
      if (!/^k:[0-9a-f]{16}$/.test(key) || !cur.some((c) => c.key === key && c.url === u.toString() && (c.header || 'authorization') === header) || (secret = await secretOf(env, agent.id, { key })) == null) throw fail(`Connection "${name}": its key is not saved here. Enter the key again.`);
    }
    const conn = { name, url: u.toString(), header, key };
    let got;
    if (Array.isArray(item?.tools)) got = cleanTools(item.tools);
    else {
      try { got = await listTools(env, conn, secret); }
      catch (e) { throw fail(`Connection "${name}" could not be used: ${line(e?.name === 'TimeoutError' ? 'it took too long to answer' : e?.message, 200)}.`, 502); }
    }
    if (!got.tools.length) throw fail(`Connection "${name}" offers no tools an agent can use.`, 422);
    if (got.skipped.length) skipped[name] = got.skipped.slice(0, 40);
    list.push({ ...conn, tools: got.tools });
  }
  if (JSON.stringify(list).length > SPEC_BYTES) throw fail('Those connections describe more tools than an agent can carry. Connect fewer servers.', 413);
  return { list, keep, skipped };
}

// What anyone may see of an agent's connections: where they go and what they can do. Never a key.
export const publicConnections = (spec) => (spec.connections || []).map((c) => {
  let host = ''; try { host = new URL(c.url).host; } catch {}
  return { name: c.name, url: c.url, host, header: c.header, key: c.key, tools: c.tools.map((t) => ({ name: t.name, description: t.description })) };
});
