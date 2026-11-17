// Zero Lux site Worker: static pages, preview gate, waitlist.
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
  let body; try { body = await request.json(); } catch { return Response.json({ error: 'bad request' }, { status: 400 }); }
  const email = String(body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Response.json({ error: 'invalid email' }, { status: 400 });
  await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, created_at, source) VALUES (?, ?, ?)').bind(email, new Date().toISOString(), 'web').run();
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.' + HOST || (url.protocol === 'http:' && url.hostname === HOST && !env.DEV)) { url.hostname = HOST; url.protocol = 'https:'; return Response.redirect(url.toString(), 301); }
    const blocked = gate(request, env, url);
    if (blocked) return blocked;
    const p = url.pathname;

    if (p === '/api/waitlist') return request.method === 'POST' ? waitlist(request, env) : new Response(null, { status: 405 });
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
