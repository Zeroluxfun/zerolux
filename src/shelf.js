// The tool shelf: paid tools anyone can list, and any builder can give to an agent.
//   GET  /api/shelf              the tools on the shelf
//   POST /api/shelf              list a tool, or update one (two steps: prepare, then the same fields signed)
//   GET  /api/shelf/:id         one listing, with what agents here have paid it
//   POST /api/shelf/:id/remove   take a tool off (signed by the same wallet), or with the build key
//
// A listing is a paid tool (src/paytools.js) with a name and a sentence saying what it does. Who may list one: the
// wallet the tool is paid at. When a listing is made the endpoint is asked what it charges and whom it pays, and the
// listing has to be signed by that payee, so nobody can list someone else's tool or pass theirs off as another's.
// The signature is a message (no transaction, no gas), good for ten minutes, as for a profile.
//
// What a builder gets from a listing is the endpoint, its method, an example call, and the price and payee it had
// when it was last checked. Adding it to an agent goes through the same checks as any paid tool, and a run pays
// only that payee, never more than the builder's own limit for a call.
//
// Kept honest: every few hours each listing is asked again. One that stops asking for payment the same way (another
// payee, another chain, a price above the ceiling, or no answer) three times running is left off the shelf until
// its lister lists it again.
import { recoverMessageAddress } from 'viem';
import { reader } from './chain.js';
import { json, allow, clientKey, readJson, hasBuildKey } from './line.js';
import { timeOk } from './profile.js';
import { review } from './revise.js';
import { buildPaid, paidOn, MAX_CEILING } from './paytools.js';

const MAX_LISTED = 300; // tools on the shelf at once
const RECHECK_MS = 6 * 3600_000; // how often a listing is asked again
const MAX_FAILS = 3;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const usd = (units) => (Number(units) / 1e6).toFixed(Number(units) % 10_000 === 0 ? 2 : 4);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// A listing's id: one per endpoint and method, so listing the same tool again updates it.
export const shelfId = async (url, method) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(method + ' ' + url))).slice(0, 16);

// What the payee signs. Text is written as a JSON string so no value can pass for another line.
export const listMessage = ({ tool, time }) => [
  'Zero Lux (zerolux.fun): list a paid tool on the shelf',
  `Name: ${tool.name}`,
  `What it does: ${JSON.stringify(tool.description)}`,
  `Address: ${tool.method} ${tool.url}`,
  `Price now: $${usd(tool.price)} a call, paid to ${tool.pay_to}`,
  `Time: ${time}`,
  'Signing this costs nothing and moves no money.',
].join('\n');
export const removeMessage = ({ id, time }) => [`Zero Lux (zerolux.fun): take tool ${id} off the shelf`, `Time: ${time}`, 'Signing this costs nothing and moves no money.'].join('\n');

// Was `message` signed by `address`? An ordinary wallet first; a contract wallet (a multisig) is asked on chain.
async function signedBy(env, address, message, signature) {
  if (!/^0x[0-9a-fA-F]{130,4000}$/.test(String(signature))) return false;
  try { if (signature.length === 132 && same(await recoverMessageAddress({ message, signature }), address)) return true; } catch {}
  try { return await reader(env).verifyMessage({ address, message, signature }); } catch { return false; }
}

const shown = (r) => {
  let example = null; try { example = r.example ? JSON.parse(r.example) : null; } catch {}
  return { id: r.id, name: r.name, description: r.description, url: r.url, host: r.host, method: r.method, ...(example ? { example } : {}), price: String(r.price), pay_to: r.pay_to, listed_by: r.lister, listed_at: r.created_at, checked_at: r.checked_at };
};

export async function getShelf(env) {
  const rows = (await env.DB.prepare("SELECT * FROM shelf WHERE status = 'listed' AND fails < ? ORDER BY created_at").bind(MAX_FAILS).all().catch(() => ({ results: [] }))).results;
  return json({ tools: rows.map(shown), note: 'Prices are USDG units (six decimals), as each tool asked when it was last checked. Add one to an agent with "paid" on POST /api/agents/{id}/spec, or name its id in "shelf" on POST /api/agents when building.' }, 200, { 'cache-control': 'public, max-age=30' });
}

// The shelf tools named by `ids`, as paid tools ready to go into a new agent's spec. The limit for a call is the
// price the tool had when it was last checked. Throws with a plain reason if one is not on the shelf.
export async function shelfTools(env, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 8);
  if (!want.length) return [];
  if (want.some((id) => !/^[0-9a-f]{16}$/.test(id))) throw Object.assign(new Error('That is not a tool on the shelf.'), { status: 400 });
  const rows = (await env.DB.prepare(`SELECT * FROM shelf WHERE status = 'listed' AND fails < ? AND id IN (${want.map(() => '?').join(',')})`).bind(MAX_FAILS, ...want).all()).results;
  if (rows.length !== want.length) throw Object.assign(new Error('One of those tools is no longer on the shelf.'), { status: 409 });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return buildPaid(env, want.map((id) => { const r = byId.get(id); return { name: r.name, description: r.description, url: r.url, method: r.method, max: r.price, ...(r.example ? { example: r.example } : {}), price: r.price, pay_to: r.pay_to }; }));
}

// One listing and what it has been paid by agents here: calls, the total of the calls that delivered, and the last
// few payments. Counted from the payments Zero Lux signed for this tool by name, at this host, to this payee. Every
// figure is already public on chain; it is kept off the shelf itself so the seller reads it, not every visitor.
export async function shelfEarnings(env, id) {
  const r = await env.DB.prepare("SELECT * FROM shelf WHERE id = ? AND status = 'listed'").bind(id).first();
  if (!r) return json({ error: 'There is no tool on the shelf with that id.' }, 404);
  const where = 'FROM tool_payments WHERE tool = ? AND host = ? AND lower(pay_to) = ?', who = [r.name, r.host, String(r.pay_to).toLowerCase()];
  const sum = await env.DB.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered, COALESCE(SUM(CASE WHEN status = 'delivered' THEN amount ELSE 0 END), 0) AS earned, COUNT(DISTINCT agent_id) AS agents ${where}`).bind(...who).first();
  const last = (await env.DB.prepare(`SELECT run, agent_id, amount, status, tx, at ${where} ORDER BY id DESC LIMIT 10`).bind(...who).all()).results;
  return json({ ...shown(r), calls: Number(sum.calls), delivered: Number(sum.delivered), earned: String(sum.earned), agents: Number(sum.agents), payments: last.map((p) => ({ run: p.run, agent_id: p.agent_id, amount: String(p.amount), status: p.status, tx: p.tx || null, at: p.at })),
    note: 'USDG units (six decimals). "earned" counts calls the tool answered after being paid. Payments go from the agent side straight to pay_to; Zero Lux holds none of it.' }, 200, { 'cache-control': 'public, max-age=30' });
}

export async function listTool(request, env, deps = {}) {
  const body = await readJson(request, 20_000); if (!body) return json({ error: 'Send JSON.' }, 400);
  if (!paidOn(env)) return json({ error: 'Paid tools are not switched on here yet.' }, 503);
  if (!(await allow(env, 'shelf:' + clientKey(request), 30))) return json({ error: 'That is enough listings for today. Come back tomorrow.' }, 429);
  // The endpoint is asked now what it charges and whom it pays. On the second step that answer has to be the one that was signed.
  let tool;
  try { [tool] = await buildPaid(env, [{ name: body.name, description: body.description, url: body.url, method: body.method, example: body.example, max: MAX_CEILING }], deps); }
  catch (e) { return json({ error: e.status ? e.message : 'The tool could not be checked. Try again in a minute.' }, e.status || 502); }
  const id = await shelfId(tool.url, tool.method);
  const had = await env.DB.prepare('SELECT lister, status FROM shelf WHERE id = ?').bind(id).first();
  if (!had && (await env.DB.prepare("SELECT COUNT(*) AS n FROM shelf WHERE status = 'listed'").first()).n >= MAX_LISTED) return json({ error: 'The shelf is full for now.' }, 409);

  if (body.prepare === true) {
    // The same refusals as an agent's wording, once per listing as worded.
    const mark = 'okshelf:' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([tool.name, tool.description, tool.url]))));
    if (!(await env.DB.prepare("SELECT 1 FROM limits WHERE k = ? AND day = '9999-12-31'").bind(mark).first())) {
      if (!(await allow(env, 'shelfcheck:' + clientKey(request), 15))) return json({ error: 'That is enough listings for today. Come back tomorrow.' }, 429);
      const spec = { name: tool.name, tagline: tool.description, input_hint: '', instructions: 'A paid tool offered to AI agents: ' + tool.description, paid: [tool] };
      let no; try { no = await (deps.review || review)(env, spec); } catch { return json({ error: 'The listing could not be checked just now. Try again in a minute.' }, 502); }
      if (no) return json({ error: no }, 422);
      await env.DB.prepare("INSERT OR IGNORE INTO limits (k, day, n) VALUES (?, '9999-12-31', 1)").bind(mark).run();
    }
    const time = new Date().toISOString();
    return json({ ok: true, id, tool, time, sign_with: tool.pay_to, message: listMessage({ tool, time }) });
  }
  if (!timeOk(body.time)) return json({ error: 'That signature is too old. Press list again.' }, 400);
  if (!(await signedBy(env, tool.pay_to, listMessage({ tool, time: body.time }), body.signature))) return json({ error: `A listing is signed by the wallet the tool is paid at (${tool.pay_to.slice(0, 6)}…${tool.pay_to.slice(-4)}). Connect that wallet and try again.` }, 403);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO shelf (id, name, description, url, method, example, price, pay_to, host, lister, signature, signed_at, status, fails, created_at, checked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8, ?10, ?11, 'listed', 0, ?12, ?12)
    ON CONFLICT (id) DO UPDATE SET name = ?2, description = ?3, example = ?6, price = ?7, pay_to = ?8, lister = ?8, signature = ?10, signed_at = ?11, status = 'listed', fails = 0, checked_at = ?12`)
    .bind(id, tool.name, tool.description, tool.url, tool.method, tool.example ? JSON.stringify(tool.example) : null, tool.price, tool.pay_to, new URL(tool.url).host, String(body.signature), body.time, now).run();
  return json({ ok: true, id, tool });
}

export async function removeTool(request, env, id) {
  const body = (await readJson(request, 5_000)) || {};
  const row = await env.DB.prepare("SELECT id, lister FROM shelf WHERE id = ? AND status = 'listed'").bind(id).first();
  if (!row) return json({ error: 'There is no tool on the shelf with that id.' }, 404);
  if (!(await hasBuildKey(request, env))) {
    if (!(await allow(env, 'shelf:' + clientKey(request), 30))) return json({ error: 'That is enough for today. Come back tomorrow.' }, 429);
    if (body.prepare === true) { const time = new Date().toISOString(); return json({ ok: true, time, sign_with: row.lister, message: removeMessage({ id, time }) }); }
    if (!timeOk(body.time)) return json({ error: 'That signature is too old. Try again.' }, 400);
    if (!(await signedBy(env, row.lister, removeMessage({ id, time: body.time }), body.signature))) return json({ error: 'Only the wallet that listed this tool can take it off.' }, 403);
  }
  await env.DB.prepare("UPDATE shelf SET status = 'removed' WHERE id = ?").bind(id).run();
  return json({ ok: true, id });
}

// Every few hours each listing is asked again what it charges and whom it pays: two a tick, the longest unchecked first.
export async function shelfTick(env, deps = {}) {
  if (!paidOn(env)) return;
  const rows = (await env.DB.prepare("SELECT * FROM shelf WHERE status = 'listed' AND checked_at < ? ORDER BY checked_at LIMIT 2").bind(new Date(Date.now() - RECHECK_MS).toISOString()).all().catch(() => ({ results: [] }))).results;
  for (const r of rows) {
    let tool = null;
    try { [tool] = await buildPaid(env, [{ name: r.name, description: r.description, url: r.url, method: r.method, max: MAX_CEILING, ...(r.example ? { example: r.example } : {}) }], deps); } catch {}
    const now = new Date().toISOString();
    // The same payee as was signed for: a tool that starts naming another one is not the tool that was listed.
    if (tool && same(tool.pay_to, r.pay_to)) await env.DB.prepare('UPDATE shelf SET price = ?, fails = 0, checked_at = ? WHERE id = ?').bind(tool.price, now, r.id).run();
    else await env.DB.prepare('UPDATE shelf SET fails = fails + 1, checked_at = ? WHERE id = ?').bind(now, r.id).run();
  }
}
