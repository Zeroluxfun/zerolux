// Zero Lux Worker: the site, the line (job to agent), paid runs, the floor, MCP.
import { line, createAgent, json, allow, clientKey, hasBuildKey } from './line.js';
import { hire, sweep } from './run.js';
import { listAgents, findAgent, getAgent, getRun, card, config, ownerBoard } from './api.js';
import { mcp } from './mcp.js';
import { feature } from './feature.js';
import { getImage } from './tools.js';
import { setProfile, getPhoto, dropProfile } from './profile-api.js';
import { balance, checkout, confirm, webhook, afterCard, settleCard, cardStatus, floatAlert } from './credits.js';
import { setSample } from './samples.js';
import { createSub, listSubs, changeSub, subsTick } from './subs.js';
import { withReview, postReview, hideReview } from './reviews.js';
import { createJob, listJobs, getJob, changeJob, jobsTick } from './jobs.js';
import { putFile, fileInfo, filesTick } from './files.js';
import { getDeliver, setDeliver, telegramHook } from './deliver.js';
import { listTemplates, makeDraft, setCopying } from './templates-api.js';
import { reviseAgent, revisions } from './revise.js';
import { setVerifiedOnly, tapTick } from './tap-api.js';
import { lockOf } from './lock.js';
export { Signer } from './chain.js';
export { JobRunner } from './jobs.js';

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

const PAGES = { '/create': '/create', '/floor': '/floor', '/connect': '/connect', '/docs': '/docs', '/roadmap': '/roadmap', '/security': '/security', '/factory': '/factory', '/lock': '/lock', '/pay': '/pay', '/dashboard': '/dashboard', '/inbox': '/inbox', '/job': '/job' }; // the asset layer serves x.html at /x
const open = (res) => { const h = new Headers(res.headers); h.set('access-control-allow-origin', '*'); h.set('access-control-expose-headers', 'payment-required, payment-response, x-payment-response, retry-after'); return new Response(res.body, { status: res.status, headers: h }); };

// Everything the factory does. Until PRODUCT is "on" these routes answer only
// to a browser holding the build key (open any of them once with ?build=<key>).
async function routeProduct(request, env, ctx, url) {
  // Compare on the decoded, single-slashed, lower-case path so no spelling of a gated address slips past.
  let p; try { p = decodeURIComponent(url.pathname); } catch { return simple('Not found: Zero Lux', 'Nothing at this address.', 404); }
  p = p.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1').toLowerCase();
  const m = p.match(/^\/a\/(\d{1,9})(\/run)?$/);
  const rvw = p.match(/^\/api\/runs\/(0x[0-9a-f]{64})\/review$/);
  const isProduct = p === '/api/line' || p === '/api/templates' || p === '/api/drafts' || p.startsWith('/api/agents') || p.startsWith('/api/runs/') || p === '/api/config' || p.startsWith('/api/credits') || p.startsWith('/api/subs') || p.startsWith('/api/jobs') || p.startsWith('/api/files') || p === '/api/deliver' || p === '/api/telegram/hook' || p === '/api/stripe/webhook' || p.startsWith('/api/lock/') || p.startsWith('/api/owners/') || p.startsWith('/card/') || p === '/mcp' || p === '/skill.md' || p in PAGES || m || ['/create.html', '/floor.html', '/agent.html', '/connect.html', '/docs.html', '/roadmap.html', '/security.html', '/factory.html', '/lock.html', '/pay.html', '/dashboard.html', '/inbox.html', '/job.html', '/pay.js', '/factory.js', '/vendor/three.module.min.js', '/agent', '/app.js', '/app.css'].includes(p);
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
  // A page on another site asking whether it may send a request with a payment or a JSON body here. Only the addresses
  // made for other sites answer yes: an agent's run address (the embed button, the code library, x402 clients) and the
  // MCP server. Building or changing an agent from another site's page is not allowed.
  if (request.method === 'OPTIONS' && ((m && m[2]) || p === '/mcp' || rvw)) return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-payment, x-sample, payment-signature, mcp-protocol-version, mcp-session-id', 'access-control-max-age': '86400' } });
  const page = (path) => env.ASSETS.fetch(new Request(new URL(path, url), request)).then((res) => {
    const h = secure(new Headers(res.headers)); h.set('cache-control', 'no-cache, no-transform'); return new Response(res.body, { status: res.status, headers: h });
  });
  if (p === '/agent') return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
  if (p in PAGES) return page(PAGES[p]);
  if (m && !m[2] && request.method === 'GET') return env.FACTORY && !(await findAgent(env, m[1])) ? simple('Not found: Zero Lux', 'No unit with that number.', 404) : page('/agent');
  if (['/app.js', '/app.css', '/skill.md', '/factory.js', '/vendor/three.module.min.js'].includes(p)) return page(p);
  if (['/create.html', '/floor.html', '/agent.html', '/connect.html', '/docs.html', '/roadmap.html', '/security.html', '/factory.html', '/lock.html', '/pay.html', '/dashboard.html', '/inbox.html', '/job.html'].includes(p)) return simple('Not found: Zero Lux', 'Nothing at this address.', 404);
  if (!env.FACTORY || !env.OPERATOR_KEY || !env.RPC_URL) return json({ error: 'The factory is not switched on yet.' }, 503);
  try {
    if (p === '/api/config') return config(env);
    // Paying by card: credit bought through Stripe's checkout, spent on runs.
    if (p === '/api/credits/status') return (await hasBuildKey(request, env)) ? cardStatus(env) : json({ error: 'not found' }, 404);
    if (p === '/api/credits') return request.method === 'GET' ? balance(request, env) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    if (p === '/api/credits/checkout' || p === '/api/credits/confirm' || p === '/api/stripe/webhook') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      return p.endsWith('checkout') ? checkout(request, env) : p.endsWith('confirm') ? confirm(request, env) : webhook(request, env);
    }
    // Standing orders: an agent run on a schedule or a price watch, paid from the customer's credit.
    if (p === '/api/subs') return request.method === 'POST' ? createSub(request, env) : request.method === 'GET' ? listSubs(request, env) : new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    const sb = p.match(/^\/api\/subs\/([0-9a-f]{32})$/);
    if (sb) return request.method === 'POST' ? changeSub(request, env, sb[1]) : new Response(null, { status: 405, headers: { allow: 'POST' } });
    // Where results are sent when nobody is on the site: a Discord or Slack webhook, Telegram.
    if (p === '/api/deliver') return request.method === 'POST' ? setDeliver(request, env) : request.method === 'GET' ? getDeliver(request, env) : new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    if (p === '/api/telegram/hook') return request.method === 'POST' ? telegramHook(request, env) : new Response(null, { status: 405, headers: { allow: 'POST' } });
    // Files a customer attaches to a request: read in their browser, sent here as text or a small JPEG.
    if (p === '/api/files') return request.method === 'POST' ? putFile(request, env) : new Response(null, { status: 405, headers: { allow: 'POST' } });
    const fl = p.match(/^\/api\/files\/([0-9a-f]{32})$/);
    if (fl) return request.method === 'GET' ? fileInfo(env, fl[1]) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    // Long jobs: one agent run in steps on one big piece of work, paid from the customer's credit.
    if (p === '/api/jobs') return request.method === 'POST' ? createJob(request, env) : request.method === 'GET' ? listJobs(request, env) : new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    const jb = p.match(/^\/api\/jobs\/([0-9a-f]{32})$/);
    if (jb) return request.method === 'POST' ? changeJob(request, env, jb[1]) : request.method === 'GET' ? getJob(request, env, jb[1]) : new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    if (p.startsWith('/api/lock/')) return request.method === 'GET' ? open(await lockOf(request, env, p.slice(10))) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    // A buyer's review of a run: the token that proves the purchase came with the answer.
    if (rvw) {
      if (request.method === 'POST') return open(await postReview(request, env, rvw[1]));
      return request.method === 'DELETE' ? await hideReview(request, env, rvw[1]) : json({ error: 'POST {"token", "stars", "text"} to review this run.' }, 405, { allow: 'POST', 'access-control-allow-origin': '*' });
    }
    if (p.startsWith('/api/runs/')) { const r = await getRun(env, p.slice(10)); return r ? open(json(r, 200, { 'cache-control': 'public, max-age=30' })) : json({ error: 'No paid run with that id.' }, 404); }
    if (p.startsWith('/api/owners/')) return request.method === 'GET' ? open(await ownerBoard(env, p.slice(12))) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    if (p === '/api/line') return request.method === 'POST' ? line(request, env) : new Response(null, { status: 405 });
    // Templates, starting from another agent, and changing a draft's wording before it is built.
    if (p === '/api/templates') return request.method === 'GET' ? open(listTemplates(env)) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    if (p === '/api/drafts') return request.method === 'POST' ? makeDraft(request, env) : new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (p === '/api/agents') return request.method === 'POST' ? createAgent(request, env) : open(await listAgents(env));
    const feat = p.match(/^\/api\/agents\/(\d{1,9})\/feature$/);
    if (feat) {
      if (request.method !== 'POST') return json({ error: 'POST {"tx": "0x..."} with the hash of a $LUX burn to feature this agent.' }, 405, { allow: 'POST' });
      const a = await findAgent(env, feat[1]);
      return a ? await feature(request, env, a) : json({ error: 'No agent with that number.' }, 404);
    }
    // Changing an agent: its owner saves a new version with a signed message; every version it has had is public.
    const rv = p.match(/^\/api\/agents\/(\d{1,9})\/(spec|revisions)$/);
    if (rv) {
      const a = await findAgent(env, rv[1]);
      if (!a) return json({ error: 'No agent with that number.' }, 404);
      if (rv[2] === 'revisions') return request.method === 'GET' ? open(await revisions(env, a)) : new Response(null, { status: 405, headers: { allow: 'GET' } });
      return request.method === 'POST' ? await reviseAgent(request, env, a) : json({ error: 'POST the change, signed by the wallet that owns the agent.' }, 405, { allow: 'POST' });
    }
    // An agent's profile: its owner sets it with a signed message; the picture is read back from /photo.
    // The free sample: its owner switches it on or off with a signed message.
    const cp = p.match(/^\/api\/agents\/(\d{1,9})\/copying$/);
    if (cp) {
      if (request.method !== 'POST') return json({ error: 'POST the setting, signed by the wallet that owns the agent.' }, 405, { allow: 'POST' });
      const a = await findAgent(env, cp[1]);
      return a ? await setCopying(request, env, a) : json({ error: 'No agent with that number.' }, 404);
    }
    // Verified agents only: its owner switches it on or off with a signed message.
    const vo = p.match(/^\/api\/agents\/(\d{1,9})\/verified$/);
    if (vo) {
      if (request.method !== 'POST') return json({ error: 'POST the setting, signed by the wallet that owns the agent.' }, 405, { allow: 'POST' });
      const a = await findAgent(env, vo[1]);
      return a ? await setVerifiedOnly(request, env, a) : json({ error: 'No agent with that number.' }, 404);
    }
    const smp = p.match(/^\/api\/agents\/(\d{1,9})\/sample$/);
    if (smp) {
      if (request.method !== 'POST') return json({ error: 'POST the setting, signed by the wallet that owns the agent.' }, 405, { allow: 'POST' });
      const a = await findAgent(env, smp[1]);
      return a ? await setSample(request, env, a) : json({ error: 'No agent with that number.' }, 404);
    }
    const prof = p.match(/^\/api\/agents\/(\d{1,9})\/(profile|photo)$/);
    if (prof && prof[2] === 'photo') return request.method === 'GET' || request.method === 'HEAD' ? getPhoto(request, env, prof[1], url) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    if (prof) {
      if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'POST a signed profile to set it.' }, 405, { allow: 'POST' });
      const a = await findAgent(env, prof[1]);
      if (!a) return json({ error: 'No agent with that number.' }, 404);
      return request.method === 'POST' ? await setProfile(request, env, a) : await dropProfile(request, env, a, url);
    }
    if (p.startsWith('/api/agents/')) { const a = await findAgent(env, p.slice(12)); return a ? open(await getAgent(env, a)) : json({ error: 'not found' }, 404); }
    const pic = p.match(/^\/api\/images\/([0-9a-f]{32})$/);
    if (pic) return request.method === 'GET' || request.method === 'HEAD' ? getImage(env, pic[1]) : new Response(null, { status: 405, headers: { allow: 'GET' } });
    if (p.startsWith('/card/')) return card(env, p.slice(6).replace(/\.json$/, ''));
    if (p === '/mcp') return open(await mcp(request, env, ctx));
    if (m && m[2]) {
      if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'POST {"input": "..."} to run this agent.' }, 405, { allow: 'GET, POST', 'access-control-allow-origin': '*' });
      const a = await findAgent(env, m[1]);
      if (!a) return json({ error: 'not found' }, 404);
      const ran = await hire(request, env, ctx, a);
      if (request.headers.get('x-credits') || request.headers.get('x-sample')) await afterCard(env, request);
      return open(await withReview(env, ran));
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
    if (env.FACTORY) ctx.waitUntil(settleCard(env).catch(() => {}));
    if (env.FACTORY) ctx.waitUntil(floatAlert(env).catch(() => {}));
    if (env.FACTORY) ctx.waitUntil(subsTick(env, ctx).catch((e) => console.error('standing orders failed', e?.name)));
    if (env.FACTORY) ctx.waitUntil(jobsTick(env).catch((e) => console.error('long jobs failed', e?.name)));
    if (env.FACTORY) ctx.waitUntil(filesTick(env).catch(() => {}));
    if (env.FACTORY) ctx.waitUntil(tapTick(env).catch(() => {}));
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
    // The embed button and the code library are loaded by other sites' pages.
    if (p === '/embed.js' || p === '/zerolux.js') { h.set('access-control-allow-origin', '*'); h.set('cross-origin-resource-policy', 'cross-origin'); h.set('cache-control', 'public, max-age=300'); }
    // Safari will not play a video unless the server answers partial requests, and the asset layer does not.
    if (p.endsWith('.mp4') && res.status === 200) {
      h.set('accept-ranges', 'bytes');
      const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
      if (m && (m[1] || m[2])) {
        const all = await res.arrayBuffer(), size = all.byteLength;
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        h.set('content-range', `bytes ${start}-${end}/${size}`); h.set('content-length', String(end - start + 1));
        return new Response(all.slice(start, end + 1), { status: 206, headers: h });
      }
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
};
