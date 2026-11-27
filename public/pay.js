// The card payment window. The Zero Lux button on another website opens this page in a small window, hands it the
// visitor's request, and gets the answer back. The credit code stays in this window, on zerolux.fun, where the other
// website cannot read it. Opened on its own, the page works by itself: type a request, pay from credit, read the answer.
import { getAgent, dollars, answerNodes, rateNodes } from '/zerolux.js';

const $ = (s) => document.querySelector(s);
const id = Number(new URLSearchParams(location.search).get('agent') ?? NaN);
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); } n.append(...kids); return n; };
const say = (t, cls = 'dim') => { $('#status').className = cls; $('#status').textContent = t; };
const api = async (path, body, headers = {}) => {
  try {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : { headers });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, data: { error: 'The network request failed. Check your connection and try again.' } }; }
};
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const LS = 'zl-credit', ASK = 'zl-pay-ask-' + id, RUN = 'zl-pay-run-' + id;
const code = () => { try { const v = localStorage.getItem(LS); return /^[0-9a-f]{64}$/.test(v || '') ? v : null; } catch { return null; } };
const setCode = (v) => { try { localStorage.setItem(LS, v); return localStorage.getItem(LS) === v; } catch { return false; } };
const account = async (v) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const ss = { get: (k) => { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} } };
// The page that opened this window. Its request is taken only from that window, and the answer goes only to the
// address the request came from.
const opener = () => { try { return window.opener && !window.opener.closed ? window.opener : null; } catch { return null; } };
let ask = ss.get(ASK);
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || e.source !== opener() || !/^https?:\/\//.test(e.origin)) return;
  if (d.zl === 'pay-ask' && typeof d.input === 'string' && typeof d.req === 'string' && /^[0-9a-f]{8,64}$/.test(d.req)) {
    ask = { input: d.input.slice(0, 12000), origin: e.origin, req: d.req }; ss.set(ASK, ask);
    if (!$('#input').value) $('#input').value = ask.input;
  }
  if (d.zl === 'pay-got' && ask && e.origin === ask.origin && d.req === ask.req) { ss.set(ASK, null); window.close(); }
});
const tell = (msg) => { const o = opener(); if (o && ask) { try { o.postMessage({ ...msg, req: ask.req }, ask.origin); return true; } catch {} } return false; };

(async () => {
  if (!Number.isInteger(id) || id < 0) { $('#note').textContent = 'This payment window was opened without an agent.'; return; }
  let A, cfg;
  try { A = await getAgent(id, { origin: location.origin }); cfg = (await api('/api/config')).data; } catch { $('#note').textContent = 'That agent could not be loaded.'; return; }
  const price = Number(A.price);
  $('#name').textContent = A.name; $('#tagline').textContent = A.tagline || ''; document.title = `Pay ${A.name} by card · Zero Lux`;
  $('#price').textContent = `One run costs ${dollars(price)}.`;
  if (A.input_hint) $('#input').placeholder = A.input_hint;
  if (ask && !$('#input').value) $('#input').value = ask.input;
  // Ready for the request. This says nothing private, so it may go to whichever page opened the window.
  const o = opener(); if (o) { try { o.postMessage({ zl: 'pay-ready', agent: id }, '*'); } catch {} }
  if (A.status !== 'live') { $('#note').textContent = `${A.name} is not taking runs.`; return; }
  if (!cfg.card?.on) { $('#note').textContent = 'Card payment is not switched on right now.'; return; }

  let bal = 0, hold = false;
  const go = $('#go');
  const draw = () => {
    const enough = bal >= price && !hold, waiting = ss.get(RUN);
    $('#note').textContent = hold ? 'Your credit is on hold: a card payment that funded it was disputed.' : bal > 0 ? `You have ${dollars(bal)} of credit.` : 'No wallet needed. Buy credit once by card, then spend it on any agent.';
    go.textContent = waiting ? 'Pick up your paid run' : enough ? `Pay ${dollars(price)} from credit and run` : bal > 0 ? 'Add more credit' : 'Buy credit by card';
    go.disabled = hold;
    $('#code').hidden = !code(); if (code()) $('#key').value = code();
  };
  const refresh = async () => { const c = code(); if (c) { const r = await api('/api/credits', null, { 'x-credits': c }); if (r.ok) { bal = Number(r.data.balance); hold = !!r.data.on_hold; } } draw(); };
  $('#list').replaceChildren(...cfg.card.packs.map((p) => el('button', { class: 'pill quiet sm', type: 'button', 'data-pack': p.id, text: `${dollars(p.credit)} of credit for $${(p.charge_cents / 100).toFixed(2)}` })));

  // Back from Stripe: the checkout is confirmed with the server, which reads it from Stripe itself.
  const q = new URLSearchParams(location.search), came = q.get('card');
  if (came) {
    history.replaceState(null, '', '/pay?agent=' + id);
    if (came.startsWith('cs_')) {
      say('Checking your card payment…');
      let r; for (let i = 0; i < 6; i++) { r = await api('/api/credits/confirm', { session: came }); if (r.ok || !r.data.again) break; await new Promise((s) => setTimeout(s, 2500)); }
      say(r.ok ? `Added ${dollars(r.data.credit)} of credit. Press the button to run.` : (r.data.error || 'The card payment could not be confirmed.'), r.ok ? 'ok' : 'err');
    }
  }
  const draft = ss.get(ASK + '-draft'); if (draft && !$('#input').value) $('#input').value = draft; ss.set(ASK + '-draft', null);
  await refresh();

  async function run(ticket, input) {
    let r;
    for (let tries = 0; tries < 60; tries++) {
      r = await api(`/a/${id}/run`, { input, ticket }, { 'x-credits': code() });
      if (r.ok || !r.data.again) break;
      await new Promise((s) => setTimeout(s, 5000));
    }
    if (r.data.again) throw new Error('This is taking longer than it should. Press the button again to pick the run up. If it never runs, the credit comes back.');
    ss.set(RUN, null);
    if (!r.ok) throw new Error(r.data.error || 'The run failed.');
    $('#out').hidden = false; $('#out').replaceChildren(...answerNodes(r.data.output, { origin: location.origin }));
    $('#receipt').replaceChildren('Paid ' + dollars(r.data.paid) + ' from credit. ', ...(r.data.run ? [el('a', { href: '/api/runs/' + r.data.run, target: '_blank', rel: 'noopener', text: 'Receipt' })] : []));
    // The answer goes back to the page that asked. If that page says it has it, this window closes; if not, the answer stays here.
    $('#rate').replaceChildren(...rateNodes(r.data, { origin: location.origin }));
    if (tell({ zl: 'pay-done', output: String(r.data.output ?? ''), paid: String(r.data.paid ?? ''), run: String(r.data.run ?? ''), review: r.data.review?.token ? { token: String(r.data.review.token) } : null })) say('Sent the answer back to the page you came from.', 'ok'); else say('');
  }

  go.addEventListener('click', async () => {
    const waiting = ss.get(RUN), input = $('#input').value.trim();
    if (!waiting && !(bal >= price)) { $('#packs').hidden = !$('#packs').hidden; return; }
    if (!waiting && !input) { $('#input').focus(); say('Write what the agent should work on first.', 'err'); return; }
    go.disabled = true; go.textContent = 'Working…'; say(''); $('#out').hidden = true; $('#receipt').textContent = ''; $('#rate').replaceChildren();
    try { const w = waiting || { ticket: rnd(16), input }; ss.set(RUN, w); await run(w.ticket, w.input); } catch (x) { say((x && x.message) || 'Something went wrong.', 'err'); }
    await refresh();
  });
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pack]'); if (!b) return;
    if (!code() && !setCode(rnd(32))) { say('This browser will not keep the credit code, so credit bought here would be lost. Turn off private browsing and try again.', 'err'); return; }
    b.disabled = true; say('Opening the card checkout…');
    ss.set(ASK + '-draft', $('#input').value || null);
    const r = await api('/api/credits/checkout', { account: await account(code()), pack: b.dataset.pack, back: '/pay?agent=' + id });
    if (r.ok && r.data.url) { location.href = r.data.url; return; }
    b.disabled = false; say(r.data.error || 'The card checkout could not be opened.', 'err');
  });
  $('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(code()); $('#copy').textContent = 'Copied'; } catch { $('#key').select(); } });
  $('#use').addEventListener('click', async () => {
    const v = $('#other').value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(v)) { say('That is not a credit code.', 'err'); return; }
    if (bal > 0 && v !== code()) { say('This browser still holds credit under its own code. Copy that code somewhere safe before switching, then press again.', 'err'); bal = 0; return; }
    if (!setCode(v)) { say('This browser will not keep a credit code. Turn off private browsing and try again.', 'err'); return; }
    $('#other').value = ''; say('Using that code.', 'ok'); await refresh();
  });
})();
