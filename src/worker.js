// Zero Lux Worker: the site, the line (job to agent), paid runs, the floor, MCP.
import { line, createAgent, json, allow, clientKey } from './line.js';
import { hire, sweep } from './run.js';
import { listAgents, findAgent, getAgent, card, config } from './api.js';
import { mcp } from './mcp.js';
export { Signer } from './chain.js';

const HOST = 'zerolux.fun';
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const secure = (h) => {
  h.set('content-security-policy', CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  return h;
};

const simple = (title, line, status) => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font:500 15px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;display:grid;place-items:center;height:100vh;margin:0;background:#0E0C14;color:#F3F1EA"><p>${line}</p>`,
  { status, headers: secure(new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' })) });

// While PREVIEW_KEY is set the whole site is private: open it once with ?key=<value>.
function gate(request, env, url) {
  if (!env.PREVIEW_KEY) return null;
  const cookie = request.headers.get('cookie') || '';
  if (cookie.split(/;\s*/).includes('zl_preview=' + env.PREVIEW_KEY)) return null;
  if (url.searchParams.get('key') === env.PREVIEW_KEY) {
    url.searchParams.delete('key');
    return new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'set-cookie': `zl_preview=${env.PREVIEW_KEY}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' } });
  }
  return simple('Zero Lux', 'Private preview.', 401);
}

async function waitlist(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 2000) return Response.json({ error: 'too large' }, { status: 413 });
  const text = await request.text().catch(() => '');
  if (text.length > 2000) return Response.json({ error: 'too large' }, { status: 413 });
  let body; try { body = JSON.parse(text); } catch { return Response.json({ error: 'bad request' }, { status: 400 }); }
  if (!(await allow(env, 'wl:' + clientKey(request), 8))) return Response.json({ error: 'Too many tries today.' }, { status: 429 });
  const email = String(body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Response.json({ error: 'invalid email' }, { status: 400 });
  await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, created_at, source) VALUES (?, ?, ?)').bind(email, new Date().toISOString(), 'web').run();
  return Response.json({ ok: true });
}

const PAGES = { '/create': '/create', '/floor': '/floor', '/connect': '/connect' }; // the asset layer serves x.html at /x
const open = (res) => { const h = new Headers(res.headers); h.set('access-control-allow-origin', '*'); h.set('access-control-expose-headers', 'payment-required, payment-response, x-payment-response, retry-after'); return new Response(res.body, { status: res.status, headers: h }); };

// Everything the factory does. Until PRODUCT is "on" these routes answer only
// to a browser holding the build key (open any of them once with ?build=<key>).
async function routeProduct(request, env, ctx, url) {
  // Compare on the decoded, single-slashed, lower-case path so no spelling of a gated address slips past.
  let p; try { p = decodeURIComponent(url.pathname); } catch { return simple('Not found: Zero Lux', 'Nothing at this address.', 404); }
  p = p.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1').toLowerCase();
  const m = p.match(/^\/a\/(\d{1,9})(\/run)?$/);
  const isProduct = p === '/api/line' || p.startsWith('/api/agents') || p === '/api/config' || p.startsWith('/card/') || p === '/mcp' || p === '/skill.md' || p in PAGES || m || ['/create.html', '/floor.html', '/agent.html', '/connect.html', '/agent', '/app.js', '/app.css'].includes(p);
  if (!isProduct) return null;
  // An agent's identity card is public from the moment its on-chain identity points at it.
  if (env.PRODUCT !== 'on' && !p.startsWith('/card/')) {
    const cookie = request.headers.get('cookie') || '';
    const key = env.BUILD_KEY;
    // The cookie holds a hash of the key, never the key itself.
    const pass = key ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zl-build:' + key)))].map((b) => b.toString(16).padStart(2, '0')).join('') : '';
    const ok = key && (cookie.split(/;\s*/).includes('zl_build=' + pass) || request.headers.get('x-build-key') === key);
    if (key && url.searchParams.get('build') === key) {
      url.searchParams.delete('build');
      return new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'set-cookie': `zl_build=${pass}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    if (!ok) return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-payment, payment-signature, mcp-protocol-version, mcp-session-id', 'access-control-max-age': '86400' } });
  const page = (path) => env.ASSETS.fetch(new Request(new URL(path, url), request)).then((res) => {
    const h = secure(new Headers(res.headers)); h.set('cache-control', 'no-cache, no-transform'); return new Response(res.body, { status: res.status, headers: h });
  });
  if (p === '/agent') return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
  if (p in PAGES) return page(PAGES[p]);
  if (m && !m[2] && request.method === 'GET') return env.FACTORY && !(await findAgent(env, m[1])) ? simple('Not found: Zero Lux', 'No unit with that number.', 404) : page('/agent');
  if (['/app.js', '/app.css', '/skill.md'].includes(p)) return page(p);
  if (['/create.html', '/floor.html', '/agent.html', '/connect.html'].includes(p)) return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
  if (!env.FACTORY || !env.OPERATOR_KEY || !env.RPC_URL) return json({ error: 'The factory is not switched on yet.' }, 503);
  try {
    if (p === '/api/config') return config(env);
    if (p === '/api/line') return request.method === 'POST' ? line(request, env) : new Response(null, { status: 405 });
    if (p === '/api/agents') return request.method === 'POST' ? createAgent(request, env) : open(await listAgents(env));
    if (p.startsWith('/api/agents/')) { const a = await findAgent(env, p.slice(12)); return a ? open(await getAgent(env, a)) : json({ error: 'not found' }, 404); }
    if (p.startsWith('/card/')) return card(env, p.slice(6).replace(/\.json$/, ''));
    if (p === '/mcp') return open(await mcp(request, env, ctx));
    if (m && m[2]) {
      if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'POST {"input": "..."} to run this agent.' }, 405, { allow: 'GET, POST', 'access-control-allow-origin': '*' });
      const a = await findAgent(env, m[1]);
      return a ? open(await hire(request, env, ctx, a)) : json({ error: 'not found' }, 404);
    }
  } catch (e) {
    console.error('product route failed', p, e?.name);
    return json({ error: 'Something broke on our side.' }, 500);
  }
  return null;
}

export default {
  async scheduled(event, env, ctx) {
    if (env.FACTORY) ctx.waitUntil(sweep(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === 'www.' + HOST || (url.protocol === 'http:' && url.hostname === HOST && !env.DEV)) { url.hostname = HOST; url.protocol = 'https:'; return Response.redirect(url.toString(), 301); }
    const blocked = gate(request, env, url);
    if (blocked) return blocked;
    const p = url.pathname;

    if (p === '/api/waitlist') return request.method === 'POST' ? waitlist(request, env) : new Response(null, { status: 405 });
    const product = await routeProduct(request, env, ctx, url);
    if (product) return product;
    if (p === '/robots.txt') return new Response(env.PREVIEW_KEY ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });

    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
    const type = res.headers.get('content-type') || '';
    const h = secure(new Headers(res.headers));
    if (type.includes('text/html')) h.set('cache-control', 'public, max-age=300, no-transform');
    else if (p.startsWith('/fonts/') || p.startsWith('/media/')) h.set('cache-control', 'public, max-age=604800');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
