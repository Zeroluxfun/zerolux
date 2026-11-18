// Zero Lux product pages: the line (create), the floor, and one unit.
// No libraries. Chain writes go through the visitor's own wallet.
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};
const usd = (units, dp) => {
  const u = Number(units || 0), n = u / 1e6;
  const d = dp ?? (u % 10_000 === 0 ? 2 : 4); // whole cents show as cents
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const api = async (path, body, headers = {}) => {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, data };
};
let CFG; const config = async () => (CFG ||= (await api('/api/config')).data);

// glass highlight follows the pointer
addEventListener('pointermove', (e) => {
  const g = e.target.closest?.('.glass'); if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty('--gx', ((e.clientX - r.left) / r.width) * 100 + '%'); g.style.setProperty('--gy', ((e.clientY - r.top) / r.height) * 100 + '%');
}, { passive: true });

// ---- wallet ----
const eth = () => window.ethereum;
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
async function connect() {
  if (!eth()) throw new Error('No wallet found in this browser. Open this page in a browser with a wallet such as MetaMask or Rabby.');
  const [account] = await eth().request({ method: 'eth_requestAccounts' });
  const cfg = await config(); const want = '0x' + cfg.chainId.toString(16);
  if ((await eth().request({ method: 'eth_chainId' })) !== want) {
    try { await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch { throw new Error('Switch your wallet to Robinhood Chain (chain id 4663) and try again.'); }
  }
  return account;
}
const sendTx = (from, to, data) => eth().request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
const explain = (e) => (e?.code === 4001 ? 'You declined it in your wallet.' : e?.message || 'Something went wrong.');

// ---- the line ----
async function pageCreate() {
  const stations = [...document.querySelectorAll('.station')], belt = $('.belt');
  const err = $('#err'), go = $('#go'), job = $('#job');
  let timer, draft;
  const run = (on) => {
    clearInterval(timer); belt.classList.toggle('run', on);
    if (!on) return;
    let i = 0; stations.forEach((s) => (s.className = 'station'));
    stations[0].classList.add('on');
    timer = setInterval(() => { if (i < stations.length - 1) { stations[i].className = 'station done'; stations[++i].classList.add('on'); } }, 850);
  };
  document.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', () => { job.value = b.dataset.job; job.focus(); }));
  $('#line').addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; go.disabled = true; $('#result').hidden = true; run(true);
    const r = await api('/api/line', { job: job.value });
    run(false); go.disabled = false;
    if (!r.ok) { stations.forEach((s) => (s.className = 'station')); err.textContent = r.data.error || 'The line jammed. Try again.'; return; }
    stations.forEach((s) => (s.className = 'station done'));
    draft = r.data; const s = draft.spec;
    $('#s-name').textContent = s.name; $('#s-tag').textContent = s.tagline; $('#s-instr').textContent = s.instructions;
    $('#s-chips').replaceChildren(el('span', { class: 'chip hot', text: draft.models[s.model].label + ' model' }), ...s.tools.map((t) => el('span', { class: 'chip', text: draft.tools[t] })), ...(s.tools.length ? [] : [el('span', { class: 'chip', text: 'No tools' })]), el('span', { class: 'chip', text: 'Wallet with spend limits' }));
    $('#price').value = (s.price / 1e6).toFixed(2); $('#price').min = (draft.models[s.model].minPrice / 1e6).toFixed(2);
    $('#result').hidden = false; $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#usewallet').addEventListener('click', async () => {
    try { $('#owner').value = await connect(); $('#err2').textContent = ''; } catch (e) { $('#err2').textContent = explain(e); }
  });
  $('#launch').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#put'), e2 = $('#err2'); e2.textContent = ''; b.disabled = true; b.textContent = 'Putting it on chain…';
    const r = await api('/api/agents', { draft: draft.draft, owner: $('#owner').value.trim(), price_usd: Number($('#price').value) });
    if (!r.ok) { b.disabled = false; b.textContent = 'Put it on the line'; e2.textContent = r.data.error || 'That did not work. Try again.'; return; }
    location.href = '/a/' + r.data.id + '?new=1';
  });
}

// ---- the floor ----
async function pageFloor() {
  const box = $('#units');
  const draw = async () => {
    const r = await api('/api/agents'); if (!r.ok) { box.replaceChildren(el('div', { class: 'empty glass', text: 'The floor is not answering. Try again in a moment.' })); return; }
    const { agents, totals } = r.data;
    $('#t-agents').textContent = totals.agents; $('#t-runs').textContent = totals.runs.toLocaleString('en-US'); $('#t-income').textContent = usd(totals.income, 2); $('#t-profit').textContent = usd(totals.profit, 2);
    if (!agents.length) { box.replaceChildren(el('div', { class: 'empty glass' }, el('p', { text: 'Nothing on the line yet.' }), el('p', {}, el('a', { class: 'pill', href: '/create', text: 'Build the first unit' })))); return; }
    agents.sort((a, b) => Number(BigInt(b.stats?.profit || 0) - BigInt(a.stats?.profit || 0)) || b.runs - a.runs || b.id - a.id);
    const top = Math.max(1, ...agents.map((a) => Number(a.stats?.profit || 0)));
    box.replaceChildren(...agents.map((a, i) => {
      const heat = Number(a.stats?.profit || 0) / top; // 0 cold .. 1 white-hot
      const glow = heat > .75 ? '#FFB000' : heat > .4 ? '#FF4B1F' : heat > .1 ? '#C2185B' : '#5B1A9E';
      const card = el('a', { class: 'unit glass', href: '/a/' + a.id },
        el('div', { class: 'row', style: 'justify-content:space-between' }, el('span', { class: 'rank', text: '#' + (i + 1) + ' · unit ' + a.id }), el('span', { class: 'chip' + (a.status === 'live' ? ' hot' : ''), text: a.status === 'live' ? usd(a.price) + ' a call' : 'Off the line' })),
        el('h3', { text: a.name }), el('p', { text: a.tagline || '' }),
        el('div', { class: 'money' }, el('div', {}, el('span', { text: 'Earned' }), el('b', { text: usd(a.stats?.income) })), el('div', {}, el('span', { text: 'Profit' }), el('b', { class: 'heat', text: usd(a.stats?.profit) })), el('div', {}, el('span', { text: 'Runs' }), el('b', { text: String(a.runs) }))),
        a.stats?.lien ? el('span', { class: 'chip', text: (a.stats.lien.bps / 100) + '% of profit pledged' }) : null);
      card.style.setProperty('--heat', String(.22 + heat * .7)); card.style.setProperty('--glow', glow);
      return card;
    }));
  };
  await draw(); setInterval(() => { if (!document.hidden) draw(); }, 60_000);
}

// ---- one unit ----
async function pageAgent() {
  const id = location.pathname.split('/')[2];
  const cfg = await config();
  const tx = (h) => el('a', { href: cfg.explorer + '/tx/' + h, target: '_blank', rel: 'noopener', text: short(h) });
  const addr = (a) => el('a', { href: cfg.explorer + '/address/' + a, target: '_blank', rel: 'noopener', text: a });
  let A;
  const load = async () => {
    const r = await api('/api/agents/' + id);
    if (!r.ok) { $('main').replaceChildren(el('div', { class: 'empty glass', text: 'No unit with that number.' })); return false; }
    A = r.data.agent; const s = A.stats || {};
    document.title = A.name + ' · Zero Lux';
    $('#name').textContent = A.name; $('#tag').textContent = A.tagline || A.job;
    $('#chips').replaceChildren(el('span', { class: 'chip hot', text: usd(A.price) + ' a call in USDG' }), el('span', { class: 'chip', text: A.model + ' model' }), ...A.tools.map((t) => el('span', { class: 'chip', text: cfg.tools[t] })), ...(A.identity ? [el('span', { class: 'chip', text: 'ERC-8004 #' + A.identity })] : []), ...(A.status !== 'live' ? [el('span', { class: 'chip', text: 'Off the line' })] : []));
    $('#l-income').textContent = usd(s.income); $('#l-cost').textContent = usd(s.charged); $('#l-profit').textContent = usd(s.profit); $('#l-runs').textContent = A.runs;
    $('#wallet').replaceChildren(addr(A.wallet)); $('#owner').replaceChildren(addr(A.owner));
    $('#input').placeholder = A.input_hint || 'What should it work on?'; $('#pay').textContent = 'Pay ' + usd(A.price) + ' and run'; $('#pay').disabled = A.status !== 'live';
    $('#instr').textContent = A.instructions;
    $('#curl').textContent = `curl -X POST https://zerolux.fun/a/${A.id}/run \\\n  -H 'content-type: application/json' \\\n  -d '{"input": "..."}'\n# answers 402 with the USDG payment to sign; see https://zerolux.fun/skill.md`;
    const lien = s.lien, lb = $('#lien');
    lb.replaceChildren(lien
      ? el('p', {}, `${lien.bps / 100}% of this unit's profit is pledged to `, addr(lien.payee), `. Paid so far ${usd(lien.paid)}${lien.cap !== '0' ? ' of ' + usd(lien.cap) : ', with no cap'}; ${usd(lien.unpaid)} waiting to be sent. `, el('button', { class: 'pill quiet sm', id: 'settle', text: 'Send it now' }))
      : el('p', { class: 'note', text: 'No share of this unit\'s profit is pledged. Its owner keeps all of it.' }));
    $('#settle')?.addEventListener('click', () => act('settleLien', ''));
    $('#recent').replaceChildren(...(r.data.recent.length ? r.data.recent.map((x) => el('tr', {}, el('td', { text: x.created_at.slice(0, 16).replace('T', ' ') }), el('td', { class: 'mono', text: short(x.payer) }), el('td', { text: usd(x.paid) }), el('td', { text: x.cost == null ? '' : usd(Math.round(x.cost * (1 + cfg.markupBps / 1e4))) }), el('td', {}, tx(x.pay_tx)))) : [el('tr', {}, el('td', { colspan: '5', class: 'note', text: 'No paid runs yet.' }))]));
    $('#o-avail').textContent = usd(s.withdrawable); $('#o-held').textContent = lien ? usd(BigInt(s.balance || 0) - BigInt(s.withdrawable || 0)) : usd(0);
    $('#pause').textContent = s.paused ? 'Resume runs' : 'Pause runs'; $('#pause').dataset.next = s.paused ? '0' : '1';
    $('#lienform').hidden = !!lien; $('#endlien').hidden = !lien;
    return true;
  };
  if (!(await load())) return;
  if (new URLSearchParams(location.search).has('new')) $('#fresh').hidden = false;

  // hire it
  const say = (t, cls = 'err') => { const e = $('#runerr'); e.className = cls; e.textContent = t; };
  // A signed payment is kept in this tab until its run has a final answer, so a reload cannot lose a paid run.
  const KEEP = 'zl-ticket-' + id;
  const keep = (v) => { try { v ? sessionStorage.setItem(KEEP, JSON.stringify(v)) : sessionStorage.removeItem(KEEP); } catch {} };
  const kept = () => { try { return JSON.parse(sessionStorage.getItem(KEEP) || 'null'); } catch { return null; } };
  async function collect(ticket, input) {
    let r;
    for (let tries = 0; tries < 60; tries++) { // up to five minutes
      r = await api(`/a/${id}/run`, { input }, { 'x-payment': ticket });
      if (r.ok || !r.data.again) break;
      await new Promise((s) => setTimeout(s, 5000));
    }
    if (r.data.again) throw new Error('This is taking longer than it should. Your payment is safe: press the button again to pick the run up, within 15 minutes.');
    // The ticket is only let go on a result or an answer that says this payment is finished.
    if (!r.ok && !r.data.final) throw new Error((r.data.error || 'Something went wrong.') + ' Your payment is kept: press the button again to pick the run up.');
    keep(null);
    if (!r.ok) throw new Error(r.data.error || 'The run failed.');
    $('#out').hidden = false; $('#out').textContent = r.data.output;
    $('#receipt').replaceChildren('Paid ' + usd(r.data.paid) + ' · ', tx(r.data.tx)); say('');
    setTimeout(load, 9000);
  }
  const waiting = kept();
  if (waiting && Date.now() - waiting.at < 15 * 60_000) { $('#input').value = waiting.input; $('#pay').textContent = 'Pick up your paid run'; say('You have a paid run waiting from a moment ago.', 'ok'); } else keep(null);
  $('#hire').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#pay'), input = $('#input').value.trim(); if (!input) return;
    b.disabled = true; say('');
    try {
      const held = kept();
      if (held && Date.now() - held.at < 15 * 60_000) { b.replaceChildren(el('span', { class: 'spin' }), ' Working…'); await collect(held.ticket, held.input); b.disabled = false; b.textContent = 'Pay ' + usd(A.price) + ' and run'; return; }
      const need = await api(`/a/${id}/run`, { input });
      if (need.status !== 402) throw new Error(need.data.error || 'This unit is not taking runs right now.');
      const from = await connect(); const sign = need.data.sign;
      const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
      const message = { from, ...sign.message, validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce };
      b.textContent = 'Confirm in your wallet…';
      const signature = await eth().request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify({ domain: sign.domain, primaryType: sign.primaryType, message, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...sign.types } })] });
      b.replaceChildren(el('span', { class: 'spin' }), ' Working…');
      // One signed payment buys one run. If we are told "again", the same payment is sent again; it is never charged twice.
      const ticket = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'eip155:' + cfg.chainId, payload: { authorization: message, signature } }));
      keep({ ticket, input, at: Date.now() });
      await collect(ticket, input);
    } catch (e2) { say(explain(e2)); }
    b.disabled = false; b.textContent = 'Pay ' + usd(A.price) + ' and run';
  });

  // owner controls: each builds one call to the wallet contract, sent from the owner's wallet
  const oerr = (t, cls = 'err') => { const e = $('#oerr'); e.className = cls; e.textContent = t; };
  async function act(fn, args) {
    try {
      const from = await connect();
      if (fn !== 'settleLien' && from.toLowerCase() !== A.owner.toLowerCase()) throw new Error('Connect the wallet that owns this unit (' + short(A.owner) + ').');
      const h = await sendTx(from, A.wallet, cfg.selectors[fn] + args);
      oerr('Sent. It shows here within a minute. Transaction ' + short(h), 'ok'); setTimeout(load, 65_000);
    } catch (e) { oerr(explain(e)); }
  }
  const units = (v) => { const n = Math.round(Number(v) * 1e6); if (!Number.isFinite(n) || n < 0) throw new Error('Enter an amount.'); return n; };
  const guard = (f) => (e) => { e.preventDefault(); try { f(); } catch (x) { oerr(explain(x)); } };
  $('#withdraw').addEventListener('submit', guard(() => { const to = $('#w-to').value.trim() || A.owner; if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That is not a wallet address.'); act('withdraw', word(cfg.usdg) + word(to) + uintWord(units($('#w-amt').value))); }));
  $('#pause').addEventListener('click', guard(() => act('setPaused', uintWord($('#pause').dataset.next))));
  $('#limits').addEventListener('submit', guard(() => act('setLimits', uintWord(units($('#lim-run').value)) + uintWord(units($('#lim-day').value)))));
  $('#lienform').addEventListener('submit', guard(() => {
    const to = $('#lien-to').value.trim(), pct = Number($('#lien-pct').value), cap = units($('#lien-cap').value || 0);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That is not a wallet address.');
    if (!(pct > 0 && pct <= 100)) throw new Error('Enter a share between 0 and 100.');
    if (cap === 0 && !$('#lien-forever').checked) throw new Error('Enter the most this pledge will ever pay, or tick the box to pledge with no limit.');
    act('setLien', word(to) + uintWord(Math.round(pct * 100)) + uintWord(cap));
  }));
  $('#endlien').addEventListener('click', guard(() => act('endLien', '')));
}

({ create: pageCreate, floor: pageFloor, agent: pageAgent })[document.body.dataset.page]?.().catch(() => {});
