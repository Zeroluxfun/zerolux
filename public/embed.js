// The Zero Lux button for any website. Paste where the button should appear:
//   <script src="https://zerolux.fun/embed.js" data-agent="15"></script>
// Options on the tag: data-label="Ask our analyst", data-theme="light".
// Or mark places yourself: <span data-zerolux-agent="15"></span>, or call ZeroLux.mount(element, { agent: 15 }).
// The button opens a small panel where a visitor types a request, pays the agent's price in USDG from their own
// wallet, and reads the answer. The money goes to the agent's wallet contract; this script never holds it.
// A visitor with no wallet pays by card instead: that opens a small Zero Lux window, where the card credit is bought
// and spent, and the answer is handed back to this panel. The card credit never touches the page this script is on.
(() => {
  const me = document.currentScript;
  const origin = me && me.src ? new URL(me.src).origin : 'https://zerolux.fun';
  const lib = import(origin + '/zerolux.js');
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.b{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:11px 18px;font-size:15px;font-weight:700;cursor:pointer;color:#170403;background:linear-gradient(100deg,#FFB000,#FF4B1F 55%,#C2185B);box-shadow:0 6px 22px -8px rgba(255,75,31,.7),inset 0 1px 0 rgba(255,255,255,.5);text-decoration:none;line-height:1.2}
.b:disabled{opacity:.55;cursor:default}
.q{background:transparent;color:var(--fg);border:1px solid var(--line);box-shadow:none}
.b:focus-visible,.x:focus-visible,textarea:focus-visible{outline:2px solid #FFB000;outline-offset:2px}
.back{position:fixed;inset:0;z-index:2147483000;background:rgba(3,1,14,.72);display:grid;place-items:center;padding:16px}
.card{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:20px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:20px;display:grid;gap:12px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8);font-size:15px;line-height:1.45}
.dark{--bg:#0B0626;--fg:#F3F1EA;--dim:rgba(243,241,234,.66);--line:rgba(255,255,255,.16);--field:rgba(0,0,0,.34)}
.light{--bg:#FFFFFF;--fg:#15121F;--dim:rgba(21,18,31,.66);--line:rgba(21,18,31,.16);--field:rgba(21,18,31,.05)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
h2{margin:0;font-size:20px;line-height:1.2;font-weight:800}
p{margin:0}
.dim{color:var(--dim);font-size:13px}
.x{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;width:32px;height:32px;font-size:18px;line-height:1;cursor:pointer;flex:none}
textarea{width:100%;min-height:96px;resize:vertical;border-radius:14px;border:1px solid var(--line);background:var(--field);color:var(--fg);padding:12px 14px;font-size:15px;line-height:1.4}
.out{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:14px;border:1px solid var(--line);background:var(--field);padding:12px 14px;max-height:320px;overflow:auto}
.out img{display:block;max-width:100%;border-radius:10px;margin:8px 0}
.out p{margin:0 0 .65em}.out ul,.out ol{margin:0 0 .65em;padding-left:1.4em}.out li{margin:.15em 0}.out h3,.out h4{margin:.6em 0 .35em;font-size:1.06em;line-height:1.3;font-weight:800;text-transform:none;letter-spacing:0}.out code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:rgba(127,127,127,.2);padding:1px 5px;border-radius:5px}.out pre{margin:0 0 .65em;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.16);overflow:auto;white-space:pre}.out pre code{background:none;padding:0}.out hr{border:0;border-top:1px solid var(--line);margin:.7em 0}.out a{text-decoration:underline;text-underline-offset:2px}.out>:first-child{margin-top:0}.out>:last-child{margin-bottom:0}
.err{color:#FF7A59}
.ok{color:#7BD88F}
a{color:inherit}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.rate{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font-size:14px}.rate-l{color:var(--dim)}.rate-s{display:inline-flex;gap:2px}.rate-x{background:none;border:0;padding:2px;font-size:22px;line-height:1;cursor:pointer;color:var(--dim);opacity:.55}.rate-x.on{color:#FFB000;opacity:1}.rate-x:focus-visible{outline:2px solid #FFB000;outline-offset:2px}.rate-t{flex:1 1 180px;min-width:0}.rate-m{color:#FF7A59;flex-basis:100%}.rate-m:empty{display:none}
.rate-t{border-radius:999px;border:1px solid var(--line);background:var(--field);color:var(--fg);padding:8px 12px;font-size:14px}
.rate-b{padding:8px 14px;font-size:14px}
`;
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null && v !== false) n.setAttribute(k, v); }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  const shadow = (host) => { const root = host.attachShadow({ mode: 'open' }); root.append(h('style', { text: CSS })); return root; };
  async function mount(target, opts = {}) {
    const id = Number(opts.agent);
    if (!target || !Number.isInteger(id) || id < 0) return;
    const theme = opts.theme === 'light' ? 'light' : 'dark';
    const host = h('span', { style: 'display:inline-block' }); target.append(host);
    const btn = h('button', { class: 'b', type: 'button', text: opts.label || 'Ask this agent', disabled: '' });
    shadow(host).append(btn);
    let Z, A;
    try { Z = await lib; A = await Z.getAgent(id, { origin }); } catch { btn.textContent = 'Agent unavailable'; return; }
    const price = Z.dollars(A.price), page = origin + '/a/' + id;
    btn.textContent = opts.label || `Ask ${A.name} · ${price}`;
    if (A.status !== 'live') { btn.textContent = `${A.name} is not taking runs`; return; }
    btn.disabled = false;

    // A signed payment is kept in this tab until its run has a final answer, so closing the panel or a reload cannot lose a paid run.
    const KEEP = 'zl-ticket-' + id;
    const keep = (v) => { try { v ? sessionStorage.setItem(KEEP, JSON.stringify(v)) : sessionStorage.removeItem(KEEP); } catch {} };
    const kept = () => { try { const v = JSON.parse(sessionStorage.getItem(KEEP) || 'null'); return v && Date.now() - v.at < 40 * 60_000 ? v : null; } catch { return null; } };

    btn.addEventListener('click', () => {
      const layer = h('div'); document.body.append(layer);
      let win = null, req = null, watch = null;
      const close = () => { layer.remove(); document.removeEventListener('keydown', onKey); removeEventListener('message', onMsg); clearInterval(watch); btn.focus(); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      const input = h('textarea', { placeholder: A.input_hint || 'What should it work on?', maxlength: '12000', 'aria-label': 'Your request' });
      const status = h('p', { class: 'dim', role: 'status' });
      const out = h('div', { class: 'out', hidden: '' });
      const rate = h('div');
      // One free run, where the agent's owner offers it: no wallet and no payment.
      const free = A.free_sample ? h('button', { class: 'b q', type: 'button', text: 'Try it once free' }) : null;
      const SKEEP = 'zl-sample-' + id;
      const say = (t, cls = 'dim') => { status.className = cls; status.textContent = t; };
      const wallet = window.ethereum;
      const go = wallet ? h('button', { class: 'b', type: 'button', text: `Pay ${price} and run` }) : null;
      const byCard = h('button', { class: wallet ? 'b q' : 'b', type: 'button', text: wallet ? 'Pay by card' : `Pay ${price} by card` });
      const cardIdle = () => { clearInterval(watch); win = null; byCard.disabled = false; byCard.textContent = wallet ? 'Pay by card' : `Pay ${price} by card`; };
      // Messages are taken only from the payment window this panel opened, and only while it is a Zero Lux page.
      const onMsg = (e) => {
        const d = e.data;
        if (!win || e.source !== win || e.origin !== origin || !d || typeof d !== 'object') return;
        if (d.zl === 'pay-ready') win.postMessage({ zl: 'pay-ask', input: input.value.trim(), req }, origin);
        if (d.zl === 'pay-done' && d.req === req) {
          win.postMessage({ zl: 'pay-got', req }, origin);
          out.hidden = false; out.replaceChildren(...Z.answerNodes(d.output, { origin }));
          rate.replaceChildren(...Z.rateNodes({ run: d.run, review: d.review }, { origin }));
          status.className = 'dim'; status.replaceChildren('Paid ' + Z.dollars(d.paid) + ' by card. ', ...(/^0x[0-9a-f]{64}$/i.test(d.run || '') ? [h('a', { href: origin + '/api/runs/' + d.run, target: '_blank', rel: 'noopener', text: 'Receipt' })] : []));
          cardIdle();
        }
      };
      addEventListener('message', onMsg);
      byCard.addEventListener('click', () => {
        if (win && !win.closed) { win.focus(); return; }
        if (!input.value.trim()) { input.focus(); say('Write your request first.', 'err'); return; }
        req = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('');
        win = window.open(origin + '/pay?agent=' + id, 'zerolux-pay', 'popup,width=460,height=760');
        if (!win) { status.className = 'err'; status.replaceChildren('Your browser blocked the payment window. Allow pop-ups for this site, or ', h('a', { href: page, target: '_blank', rel: 'noopener', text: 'pay on Zero Lux' }), '.'); return; }
        out.hidden = true; rate.replaceChildren(); byCard.disabled = true; byCard.textContent = 'Finish in the payment window…'; say('A Zero Lux window opened for the card payment. The answer will show here.');
        watch = setInterval(() => { if (win && win.closed) { cardIdle(); if (out.hidden) say('The payment window was closed before an answer came back.', 'err'); } }, 700);
      });
      const conns = (A.connections || []).map((c) => `${c.name} (${c.host})`), hires = (A.can_hire_agents || []).map((x) => `"${x.name}"`);
      const card = h('div', { class: 'card ' + theme, role: 'dialog', 'aria-modal': 'true', 'aria-label': A.name },
        h('div', { class: 'top' }, h('div', {}, h('h2', { text: A.name }), h('p', { class: 'dim', text: A.tagline || '' })), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: close })),
        input,
        h('div', { class: 'row' }, go, byCard, free),
        h('p', { class: 'dim', text: wallet ? 'Pay in USDG on Robinhood Chain from your wallet, with no gas, or by card.' : 'No wallet needed. Card payments are taken by Zero Lux through Stripe.' }),
        status, out, rate,
        conns.length ? h('p', { class: 'dim', text: 'During a run this agent may send parts of your request to outside tool servers its owner connected: ' + conns.join(', ') + '.' }) : null,
        hires.length ? h('p', { class: 'dim', text: 'During a run this agent may pay part of the job to other agents: ' + hires.join(', ') + '.' }) : null,
        h('p', { class: 'dim' }, 'Runs on ', h('a', { href: page, target: '_blank', rel: 'noopener', text: 'Zero Lux' }), '. One payment buys one run.'));
      const back = h('div', { class: 'back', onclick: (e) => { if (e.target === back) close(); } }, card);
      shadow(layer).append(back);
      const held = kept();
      if (held) { input.value = held.input; if (wallet) go.textContent = 'Pick up your paid run'; say('You have a paid run waiting from a moment ago.', 'ok'); }
      input.focus();
      if (free) free.addEventListener('click', async () => {
        const text = input.value.trim(); if (!text) { input.focus(); say('Write your request first.', 'err'); return; }
        free.disabled = true; free.textContent = 'Working…'; out.hidden = true; rate.replaceChildren(); say('');
        let w = null; try { w = JSON.parse(sessionStorage.getItem(SKEEP) || 'null'); } catch {}
        if (!w) { w = { ticket: [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join(''), input: text }; try { sessionStorage.setItem(SKEEP, JSON.stringify(w)); } catch {} }
        try {
          const r = await Z.sample(id, w.input, { origin, ticket: w.ticket });
          try { sessionStorage.removeItem(SKEEP); } catch {}
          out.hidden = false; out.replaceChildren(...Z.answerNodes(r.output, { origin }));
          say('That was a free sample, paid for by this agent\'s owner. To run it again, pay for a run.'); free.remove();
        } catch (e) {
          if (!e || e.final !== false) { try { sessionStorage.removeItem(SKEEP); } catch {} }
          say((e && e.message) || 'The free sample did not run.', 'err');
          if (e && e.sample) free.remove(); else { free.disabled = false; free.textContent = 'Try it once free'; }
        }
      });
      if (!wallet) return;
      go.addEventListener('click', async () => {
        const text = input.value.trim(); if (!text || go.disabled) return;
        go.disabled = true; out.hidden = true; rate.replaceChildren(); say('');
        try {
          let r; const waiting = kept();
          if (waiting) { go.textContent = 'Working…'; r = await Z.collect(id, waiting.input, waiting.ticket, { origin }); }
          else {
            go.textContent = 'Confirm in your wallet…';
            const { ticket } = await Z.pay(id, text, { signer: Z.fromProvider(wallet), origin });
            keep({ ticket, input: text, at: Date.now() });
            go.textContent = 'Working…';
            r = await Z.collect(id, text, ticket, { origin });
          }
          keep(null);
          out.hidden = false; out.replaceChildren(...Z.answerNodes(r.output, { origin }));
          rate.replaceChildren(...Z.rateNodes(r, { origin }));
          status.className = 'dim'; status.replaceChildren('Paid ' + Z.dollars(r.paid) + '. ', h('a', { href: origin + '/api/runs/' + r.run, target: '_blank', rel: 'noopener', text: 'Receipt' }));
        } catch (e) {
          // The ticket is only let go on an answer that says the payment is finished.
          if (e && e.final) keep(null);
          say(e && e.code === 4001 ? 'You declined it in your wallet.' : ((e && e.message) || 'Something went wrong.') + (kept() ? ' Your payment is kept: press the button again to pick the run up.' : ''), 'err');
        }
        go.disabled = false; go.textContent = kept() ? 'Pick up your paid run' : `Pay ${price} and run`;
      });
    });
  }

  const auto = () => { for (const el of document.querySelectorAll('[data-zerolux-agent]:not([data-zl-on])')) { el.setAttribute('data-zl-on', ''); mount(el, { agent: el.dataset.zeroluxAgent, label: el.dataset.label, theme: el.dataset.theme }); } };
  if (me && me.dataset.agent != null && me.parentNode) { const slot = document.createElement('span'); me.after(slot); mount(slot, { agent: me.dataset.agent, label: me.dataset.label, theme: me.dataset.theme }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
  window.ZeroLux = Object.assign(window.ZeroLux || {}, { mount, scan: auto, library: lib });
})();
