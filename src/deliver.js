// Where results go when nobody is on the site to read them.
//
// A standing order or a long job finishes while its customer is away. The result is always kept in their inbox
// (/inbox); this file also sends it to the places they chose, once per credit account:
//
//   a Discord or Slack webhook   they paste its address
//   Telegram                     they press a link that opens the Zero Lux bot, and press Start
//
//   GET  /api/deliver   x-credits                            -> what is set (never the webhook address itself)
//   POST /api/deliver   x-credits, {"webhook": "https://..."|""} | {"telegram": "link"|"unlink"} | {"test": true}
//   POST /api/telegram/hook                                  -> Telegram's own notices, proven by a secret header
//
// A message is tried once and never holds up the run that made it: the inbox is the record, this is the nudge.
// Telegram is on only when the bot's token is set (TELEGRAM_BOT_TOKEN). The bot registers itself the first time it is needed.
import { json, allow, clientKey, readJson } from './line.js';
import { sha, isAccount } from './credits.js';
import { safeUrl } from './run.js';

const LINK_MINUTES = 30; // how long a Telegram link stays good
const now = () => new Date().toISOString();
const dev = (env) => env.DEV === '1' && /^http:\/\/localhost:\d+$/.test(env.DEV_ORIGIN || '');
const site = (env) => (dev(env) ? env.DEV_ORIGIN : 'https://zerolux.fun');
// A webhook is a public https address. (On a developer's machine only, one on localhost is let through for tests.)
const hookUrl = (env, raw) => { if (dev(env) && /^http:\/\/localhost:\d+\//.test(raw)) return new URL(raw); return safeUrl(raw); };
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
async function who(request) { const secret = request.headers.get('x-credits') || ''; return isAccount(secret) ? sha(secret) : null; }

export const telegramOn = (env) => /^\d+:[\w-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN || '');
const hookSecret = async (env) => (await sha('zerolux telegram hook|' + env.TELEGRAM_BOT_TOKEN)).slice(0, 48);
async function tg(env, method, body = {}) {
  const res = await fetch(`${(dev(env) && env.TELEGRAM_API) || 'https://api.telegram.org'}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).catch(() => null);
  const out = res ? await res.json().catch(() => null) : null;
  return out?.ok ? out.result : null;
}
// The bot's name. The first time, it also tells Telegram where to send what people write to the bot.
let BOT = null;
async function bot(env) {
  if (!telegramOn(env)) return null;
  const key = 'tg:' + (await hookSecret(env)).slice(0, 12);
  if (BOT?.key === key) return BOT.name;
  let name = (await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(key).first())?.v;
  if (!name) {
    const me = await tg(env, 'getMe');
    if (!me?.username) return null;
    if (!(await tg(env, 'setWebhook', { url: site(env) + '/api/telegram/hook', secret_token: await hookSecret(env), allowed_updates: ['message'] }))) return null;
    name = me.username;
    await env.DB.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind(key, name).run();
  }
  BOT = { key, name };
  return name;
}

const routeOf = (env, account) => env.DB.prepare('SELECT * FROM routes WHERE account = ?').bind(account).first();
const shape = (env, r) => ({ webhook: r?.webhook ? { host: new URL(r.webhook).hostname } : null, telegram: telegramOn(env) ? { linked: !!r?.tg_chat } : null });

export async function getDeliver(request, env) {
  const account = await who(request); if (!account) return json({ error: 'Send your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'dv:' + clientKey(request), 3000))) return json({ error: 'Too many requests.' }, 429);
  return json(shape(env, await routeOf(env, account)), 200, { 'cache-control': 'no-store' });
}

export async function setDeliver(request, env) {
  const account = await who(request), body = await readJson(request);
  if (!account || !body) return json({ error: 'Send JSON with your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'dvset:' + clientKey(request), 200))) return json({ error: 'Too many changes for today.' }, 429);
  const more = {};
  if (typeof body.webhook === 'string') {
    const raw = body.webhook.trim().slice(0, 300), u = raw ? hookUrl(env, raw) : null;
    if (raw && !u) return json({ error: 'The webhook has to be a public https address.' }, 400);
    await env.DB.prepare('INSERT INTO routes (account, webhook, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(account) DO UPDATE SET webhook = ?2, updated_at = ?3').bind(account, u ? u.href : null, now()).run();
  } else if (body.telegram === 'link') {
    const name = await bot(env);
    if (!name) return json({ error: 'Telegram is not switched on.' }, 503);
    const code = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO routes (account, tg_code, tg_code_at, updated_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(account) DO UPDATE SET tg_code = ?2, tg_code_at = ?3, updated_at = ?3').bind(account, code, now()).run();
    more.link = `https://t.me/${name}?start=${code}`; more.minutes = LINK_MINUTES;
  } else if (body.telegram === 'unlink') {
    await env.DB.prepare('UPDATE routes SET tg_chat = NULL, tg_code = NULL, updated_at = ? WHERE account = ?').bind(now(), account).run();
  } else if (body.test === true) {
    if (!(await allow(env, 'dvtest:' + account.slice(0, 24), 20))) return json({ error: 'That is enough test messages for today.' }, 429);
    more.sent = await deliver(env, account, { title: 'Zero Lux: a test message', body: 'Results from your standing orders and long jobs will arrive here.', link: site(env) + '/inbox' });
  } else return json({ error: 'Send "webhook", "telegram": "link" or "unlink", or "test": true.' }, 400);
  return json({ ok: true, ...shape(env, await routeOf(env, account)), ...more });
}

// Send one message to wherever this account asked for. `own` is a webhook set on one standing order, used instead of
// the account's. Answers what got through; never throws.
export async function deliver(env, account, msg, own = null) {
  const sent = { webhook: false, telegram: false };
  try {
    const r = await routeOf(env, account), u = own || r?.webhook ? hookUrl(env, own || r.webhook) : null;
    if (u) {
      // Discord reads "content" and Slack reads "text". Discord takes 2000 characters at most.
      const text = `${cut(msg.title, 120)}\n\n${cut(msg.body, 1600)}\n\n${msg.link}`;
      const res = await fetch(u.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }), redirect: 'manual', signal: AbortSignal.timeout(8000) }).catch(() => null);
      sent.webhook = !!res?.ok;
    }
    if (r?.tg_chat && telegramOn(env)) sent.telegram = !!(await tg(env, 'sendMessage', { chat_id: r.tg_chat, text: `${cut(msg.title, 120)}\n\n${cut(msg.body, 3600)}\n\n${msg.link}`, disable_web_page_preview: true }));
  } catch (e) { console.error('delivery failed', e?.name, String(e?.message || '').slice(0, 200)); }
  return sent;
}

// What people write to the bot. "/start <code>" from the link on the inbox page joins that chat to the account.
export async function telegramHook(request, env) {
  if (!telegramOn(env) || request.headers.get('x-telegram-bot-api-secret-token') !== (await hookSecret(env))) return json({ error: 'not found' }, 404);
  const m = (await readJson(request, 60_000))?.message, chat = m?.chat?.id, text = String(m?.text || '').trim();
  if (chat == null) return json({ ok: true });
  const say = (t) => tg(env, 'sendMessage', { chat_id: chat, text: t, disable_web_page_preview: true });
  const start = text.match(/^\/start(?:@\w+)?(?:\s+([0-9a-f]{24}))?$/);
  if (start?.[1]) {
    const since = new Date(Date.now() - LINK_MINUTES * 60_000).toISOString();
    const done = await env.DB.prepare('UPDATE routes SET tg_chat = ?, tg_code = NULL, updated_at = ? WHERE tg_code = ? AND tg_code_at > ?').bind(String(chat), now(), start[1], since).run();
    await say(done.meta.changes ? 'Connected. Results from your Zero Lux standing orders and long jobs will arrive here. Send /stop to disconnect.' : 'That link has expired. Open zerolux.fun/inbox and press Connect Telegram again.');
  } else if (/^\/stop(@\w+)?$/.test(text)) {
    await env.DB.prepare('UPDATE routes SET tg_chat = NULL, updated_at = ? WHERE tg_chat = ?').bind(now(), String(chat)).run();
    await say('Disconnected. Nothing more will be sent here.');
  } else if (start) await say('To connect this chat, open zerolux.fun/inbox and press Connect Telegram.');
  return json({ ok: true });
}
