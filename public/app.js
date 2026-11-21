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
  // A job typed on the home page arrives in the address; put it on the line straight away.
  const sent = new URLSearchParams(location.search).get('job');
  if (sent && sent.trim()) { job.value = sent.trim().slice(0, 1200); history.replaceState(null, '', '/create'); setTimeout(() => $('#line').requestSubmit(), 0); }
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
  // Featuring: anyone may burn $LUX to put this agent at the top of the market. What it costs comes from /api/config.
  const L = cfg.lux, fbox = $('#feature');
  const lux = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const BURN = 'zl-burn-' + id; // a burn that was sent and not yet recorded is kept in this browser, so it is never lost or sent twice
  const pending = () => { try { return JSON.parse(localStorage.getItem(BURN) || 'null'); } catch { return null; } };
  const setPending = (v) => { try { v ? localStorage.setItem(BURN, JSON.stringify(v)) : localStorage.removeItem(BURN); } catch {} };
  let armed = 0, burning = false;
  const drawFeature = () => {
    if (!fbox) return;
    fbox.hidden = !L; if (!L) return;
    const on = !!A.featured_until && Date.parse(A.featured_until) > Date.now();
    $('#f-what').textContent = `Burn ${lux(L.featureAmount)} $LUX to put this agent at the top of the market for ${L.featureDays} ${L.featureDays === 1 ? 'day' : 'days'}.`;
    $('#f-status').textContent = on ? 'Featured until ' + new Date(A.featured_until).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Not featured';
    $('#f-burned').textContent = lux(A.lux_burned || 0) + ' $LUX';
    if (burning) return;
    const b = $('#f-go'), held = pending();
    b.textContent = held ? 'Finish featuring' : armed ? `Confirm: burn ${lux(L.featureAmount)} $LUX` : `Burn ${lux(L.featureAmount)} $LUX`;
    b.disabled = !held && (A.status !== 'live' || !L.open); $('#f-no').hidden = !armed || !!held;
    $('#f-closed').hidden = !!L.open; $('#f-paste').hidden = !L.open;
  };
  const load = async () => {
    const r = await api('/api/agents/' + id);
    if (!r.ok) { $('main').replaceChildren(el('div', { class: 'empty glass', text: 'No unit with that number.' })); return false; }
    A = r.data.agent; const s = A.stats || {};
    document.title = A.name + ' · Zero Lux';
    $('#name').textContent = A.name; $('#tag').textContent = A.tagline || A.job;
    $('#chips').replaceChildren(el('span', { class: 'chip hot', text: usd(A.price) + ' a call in USDG' }), el('span', { class: 'chip', text: A.model + ' model' }), ...A.tools.map((t) => el('span', { class: 'chip', text: cfg.tools[t] })), ...(A.identity ? [el('span', { class: 'chip', text: 'ERC-8004 #' + A.identity })] : []), ...(A.status !== 'live' ? [el('span', { class: 'chip', text: 'Off the line' })] : []));
    $('#l-income').textContent = usd(s.income); $('#l-cost').textContent = usd(s.charged); $('#l-profit').textContent = usd(s.profit); $('#l-runs').textContent = A.runs;
    const who = A.customers; if (who) $('#l-who').textContent = who.payers ? `${who.outside_payers} outside ${who.outside_payers === 1 ? 'customer has' : 'customers have'} paid ${usd(who.from_outside)}${who.top_outside_share != null ? `, the largest of them ${who.top_outside_share}% of that` : ''}. ${usd(who.from_insiders)} came from the owner, a pledge holder or Zero Lux's own test wallet.` : 'No one has paid this agent yet.';
    // A version 3 wallet counts outside income itself, on chain, net of refunds: show the contract's own figures.
    if (A.version === 3 && s.externalIncome != null) $('#l-who').textContent = BigInt(s.externalIncome) + BigInt(s.insiderIncome) > 0n ? `On chain, this wallet counts ${usd(s.externalIncome)} from ${s.payerCount} outside ${s.payerCount === 1 ? 'customer' : 'customers'}${BigInt(s.externalIncome) > 0n ? `, the largest of them ${Math.round((Number(s.topPayerPaid) / Number(s.externalIncome)) * 100)}% of that` : ''}, and ${usd(s.insiderIncome)} from its owner, a pledge holder or their other wallets. ${usd(s.totalRefunded)} has been refunded to customers.` : `No one has paid this agent yet.${BigInt(s.totalRefunded || 0) > 0n ? ` ${usd(s.totalRefunded)} has been refunded to customers.` : ''}`;
    $('#wallet').replaceChildren(addr(A.wallet)); $('#owner').replaceChildren(addr(A.owner));
    $('#input').placeholder = A.input_hint || 'What should it work on?'; $('#pay').textContent = 'Pay ' + usd(A.price) + ' and run'; $('#pay').disabled = A.status !== 'live';
    $('#instr').textContent = A.instructions;
    $('#curl').textContent = `curl -X POST https://zerolux.fun/a/${A.id}/run \\\n  -H 'content-type: application/json' \\\n  -d '{"input": "..."}'\n# answers 402 with the USDG payment to sign; see https://zerolux.fun/skill.md`;
    const lien = s.lien, lb = $('#lien');
    lb.replaceChildren(lien
      ? el('p', {}, `${lien.bps / 100}% of this unit's profit is pledged to `, addr(lien.payee), `. Paid so far ${usd(lien.paid)}${lien.cap !== '0' ? ' of ' + usd(lien.cap) : ', with no cap'}; ${usd(lien.unpaid)} waiting to be sent. `, el('button', { class: 'pill quiet sm', id: 'settle', text: 'Send it now' }))
      : el('p', { class: 'note', text: 'No share of this unit\'s profit is pledged. Its owner keeps all of it.' }));
    $('#settle')?.addEventListener('click', () => act('settleLien', ''));
    $('#recent').replaceChildren(...(r.data.recent.length ? r.data.recent.map((x) => el('tr', {}, el('td', { text: x.created_at.slice(0, 16).replace('T', ' ') }), el('td', { class: 'mono', text: short(x.payer) }), el('td', { text: usd(x.paid) }), el('td', { text: x.cost == null ? '' : usd(Math.round(x.cost * (1 + cfg.markupBps / 1e4))) }), el('td', {}, tx(x.pay_tx)), el('td', {}, el('a', { href: '/api/runs/' + x.id, text: 'open', target: '_blank', rel: 'noopener' })))) : [el('tr', {}, el('td', { colspan: '6', class: 'note', text: 'No paid runs yet.' }))]));
    $('#o-avail').textContent = usd(s.withdrawable); $('#o-held').textContent = lien ? usd(BigInt(s.balance || 0) - BigInt(s.withdrawable || 0)) : usd(0);
    $('#pause').textContent = s.paused ? 'Resume runs' : 'Pause runs'; $('#pause').dataset.next = s.paused ? '0' : '1';
    $('#lienform').hidden = !!lien; $('#endlien').hidden = !lien;
    // Version 2 and 3 wallets can be named in the identity registry as the wallet this agent is paid at.
    const nm = $('#nameit'); if (nm) { nm.hidden = !(A.version >= 2 && A.identity && !s.named); $('#named').hidden = !s.named; }
    drawHire(); drawFeature();
    return true;
  };
  // Version 3: which other units this one may hire during a run. The list lives on the wallet contract and only its owner can change it.
  const listed = () => A.can_hire_agents || [];
  const drawHire = () => {
    // What a customer should know before paying: this unit may pay other units out of the job. Names are set as text, never as markup.
    let t = $('#hire-terms'); if (!t && $('#hire')) { t = el('p', { class: 'note', id: 'hire-terms' }); $('#hire').append(t); }
    if (t) { t.hidden = !listed().length; t.textContent = listed().length ? 'During a run this unit may pay up to half of the job\'s budget to ' + listed().map((x) => `unit ${x.agent_id} "${x.name}"`).join(', ') + '. Money paid to a hired unit that delivered is not refunded, even if the job itself fails.' : ''; }
    const l = $('#ch-list'); if (!l) return;
    l.replaceChildren(...(listed().length ? listed().map((x) => el('span', { style: 'display:block', text: `Unit ${x.agent_id} "${x.name}" · ${usd(x.price)} a call · wallet ${x.wallet}` })) : ['This unit cannot hire any other unit yet.']));
  };
  if (!(await load())) return;
  if (A.version === 3 && $('#oerr')) {
    $('#oerr').before(el('form', { class: 'stack', id: 'canhire' },
      el('p', { class: 'lbl', text: 'Units this one can hire during a run' }), el('p', { class: 'note', id: 'ch-list' }),
      el('label', {}, el('span', { text: 'Unit number' }), el('input', { id: 'ch-id', type: 'number', min: '0', step: '1', autocomplete: 'off' })),
      el('p', { class: 'note', id: 'ch-check' }),
      el('button', { class: 'pill quiet sm', id: 'ch-add', text: 'Allow it to hire this unit' }), el('button', { class: 'pill quiet sm', id: 'ch-del', type: 'button', text: 'Stop it hiring this unit' })));
    drawHire();
    // Two presses: the first shows exactly which unit this is and what allowing it means, the second sends it from the owner's wallet.
    let ready = null;
    const reset = () => { ready = null; $('#ch-check').textContent = ''; $('#ch-add').textContent = 'Allow it to hire this unit'; $('#ch-del').textContent = 'Stop it hiring this unit'; };
    $('#ch-id').addEventListener('input', reset);
    const setHire = async (allowed) => {
      try {
        const n = $('#ch-id').value.trim(); if (!/^\d{1,9}$/.test(n)) throw new Error('Enter a unit number.');
        if (Number(n) === A.id) throw new Error('A unit cannot hire itself.');
        if (ready && ready.n === n && ready.allowed === allowed) { const w = ready.wallet; reset(); return act('setPayable', word(w) + uintWord(allowed ? 1 : 0)); }
        const r = await api('/api/agents/' + n); if (!r.ok) throw new Error('No unit with that number.');
        const T = r.data.agent;
        if (allowed && T.version !== 3) throw new Error('Only units on wallet version 3 can be hired by another unit.');
        reset(); ready = { n, allowed, wallet: T.wallet };
        $('#ch-check').textContent = `Unit ${T.id} "${T.name}" · ${usd(T.price)} a call · wallet ${T.wallet}. ` + (allowed ? 'If you allow this, your unit will be able to pay that unit out of customers\' jobs, up to half of a job\'s budget, and that money is not refunded to the customer when that unit delivers. Press again to confirm.' : 'Your unit will no longer be able to pay that unit. Press again to confirm.');
        $(allowed ? '#ch-add' : '#ch-del').textContent = 'Confirm';
        oerr('');
      } catch (x) { oerr(explain(x)); }
    };
    $('#canhire').addEventListener('submit', (e) => { e.preventDefault(); setHire(true); });
    $('#ch-del').addEventListener('click', () => setHire(false));
  }
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
    // What happens to a payment nobody collects depends on the wallet version: a version 3 wallet sends it back, older ones keep it.
    if (r.data.again) throw new Error('This is taking longer than it should. Your payment is safe: press the button again to pick the run up, within 15 minutes.' + (A.version === 3 ? ' After that it is returned to your wallet, less what the attempts cost and the network charge' + (A.can_hire_agents?.length ? ', and less anything it paid a unit it hired.' : '.') : ''));
    // The ticket is only let go on a result or an answer that says this payment is finished.
    if (!r.ok && !r.data.final) throw new Error((r.data.error || 'Something went wrong.') + ' Your payment is kept: press the button again to pick the run up.');
    keep(null);
    if (!r.ok) throw new Error(r.data.error || 'The run failed.');
    $('#out').hidden = false; $('#out').textContent = r.data.output;
    $('#receipt').replaceChildren('Paid ' + usd(r.data.paid) + ' · ', tx(r.data.tx)); say('');
    setTimeout(load, 9000);
  }
  const waiting = kept();
  if (waiting && Date.now() - waiting.at < 40 * 60_000) { $('#input').value = waiting.input; $('#pay').textContent = 'Pick up your paid run'; say('You have a paid run waiting from a moment ago.', 'ok'); } else keep(null);
  $('#hire').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#pay'), input = $('#input').value.trim(); if (!input) return;
    b.disabled = true; say('');
    try {
      const held = kept();
      if (held && Date.now() - held.at < 40 * 60_000) { b.replaceChildren(el('span', { class: 'spin' }), ' Working…'); await collect(held.ticket, held.input); b.disabled = false; b.textContent = 'Pay ' + usd(A.price) + ' and run'; return; }
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

  // feature it: one transfer of $LUX to the burn address from the visitor's own wallet (any wallet, not only the owner's),
  // then the transaction hash goes to the server, which checks the burn on chain and records it once.
  // The calldata carries one extra word after the transfer: this agent's number. The token ignores it; the server
  // reads it, so the burn can only ever be used for this agent.
  if (fbox && L) {
    const fsay = (t, cls = 'err') => { const e = $('#ferr'); e.className = cls; e.textContent = t; };
    const pause = (ms) => new Promise((s) => setTimeout(s, ms));
    const saved = ' Your burn is saved in this browser: press the button again to finish.';
    const mined = async (hash) => {
      for (let i = 0; i < 90; i++) { // about three minutes
        const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
        if (r) return r;
        await pause(2000);
      }
      return null;
    };
    const record = async (hash, since) => {
      // `kept` is true for the burn this browser is holding; a pasted hash never touches that one.
      const kept = () => pending()?.tx === hash, drop = () => { if (kept()) setPending(null); };
      const later = () => (kept() ? saved : ' Nothing was recorded: try again in a minute.');
      for (let tries = 0; tries < 10; tries++) {
        const r = await api('/api/agents/' + id + '/feature', { tx: hash });
        if (r.ok) {
          drop();
          A.featured_until = r.data.featured_until; A.lux_burned = String(Number(A.lux_burned || 0) + Number(r.data.burned));
          fsay(`Done. ${lux(r.data.burned)} $LUX burned. This agent is featured on the market until the time shown above.`, 'ok');
          setTimeout(load, 16_000); return;
        }
        if (r.data.again) { fsay('Waiting for the chain to confirm the burn…', 'note'); await pause(3000); continue; }
        // A final answer about this transaction lets it go; anything else (a busy server, a daily limit) keeps it for another try.
        const final = [400, 404, 409, 422].includes(r.status);
        if (final) { drop(); setTimeout(load, 16_000); }
        throw new Error((r.data.error || 'The burn could not be recorded.') + (final ? '' : later()));
      }
      if (kept() && Date.now() - since > 3_600_000) { drop(); throw new Error('That transaction did not confirm within an hour, so it was most likely dropped or replaced. Check your wallet: if the burn went through under another hash, paste that hash below.'); }
      throw new Error('The chain has not confirmed the burn yet.' + later());
    };
    const disarm = () => { armed = 0; if (!burning) { fsay(''); drawFeature(); } };
    $('#f-no').addEventListener('click', disarm);
    $('#f-go').addEventListener('click', async () => {
      if (burning) return;
      const b = $('#f-go'), held = pending();
      // Two presses: the first says exactly what will happen, the second sends it.
      if (!held && !armed) {
        const at = (armed = Date.now()); drawFeature();
        fsay(`This sends ${lux(L.featureAmount)} $LUX from your wallet to the burn address ${L.burnAddress}. A burn cannot be undone: nobody, Zero Lux included, can return the tokens. Press again to confirm.`, 'note');
        setTimeout(() => { if (armed === at) disarm(); }, 45_000);
        return;
      }
      armed = 0; burning = true; b.disabled = true; $('#f-no').hidden = true;
      try {
        let hash = held?.tx, since = held?.at || Date.now();
        if (!hash) {
          b.textContent = 'Connecting your wallet…'; fsay('');
          const from = await connect(), units = BigInt(L.featureAmount) * 10n ** 18n;
          const bal = await eth().request({ method: 'eth_call', params: [{ to: L.address, data: '0x70a08231' + word(from) }, 'latest'] }).catch(() => null);
          if (/^0x[0-9a-f]+$/i.test(bal || '') && BigInt(bal) < units) throw new Error(`This wallet holds ${lux(BigInt(bal) / 10n ** 18n)} $LUX. Featuring takes ${lux(L.featureAmount)}.`);
          b.textContent = 'Confirm in your wallet…';
          hash = await sendTx(from, L.address, '0xa9059cbb' + word(L.burnAddress) + uintWord(units) + uintWord(A.id)); // transfer(burn address, amount), then this agent's number
          if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Your wallet did not give back a transaction hash, so the burn could not be followed. Find the transaction in your wallet and paste its hash below.');
          setPending({ tx: hash, at: since });
          b.replaceChildren(el('span', { class: 'spin' }), ' Burning…'); fsay('Sent. Waiting for the chain to confirm the burn. Transaction ' + short(hash), 'note');
          const rc = await mined(hash);
          if (rc && rc.status !== '0x1') { setPending(null); throw new Error('The burn failed on chain, so no $LUX was burned. You can try again.'); }
        }
        b.replaceChildren(el('span', { class: 'spin' }), ' Recording…');
        await record(hash, since);
      } catch (e) { fsay(explain(e)); }
      burning = false; drawFeature();
    });
    // For a wallet that replaced the transaction (a speed-up) or never showed its hash: paste the hash of a burn made from this page.
    $('#f-paste').addEventListener('submit', async (e) => {
      e.preventDefault(); if (burning) return;
      const hash = $('#f-hash').value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { fsay('That is not a transaction hash. It is 0x followed by 64 characters.'); return; }
      const b = $('#f-go'); armed = 0; burning = true; b.disabled = true; $('#f-no').hidden = true; $('#f-send').disabled = true;
      b.replaceChildren(el('span', { class: 'spin' }), ' Recording…'); fsay('');
      try { await record(hash.toLowerCase(), Date.now()); $('#f-hash').value = ''; } catch (x) { fsay(explain(x)); }
      burning = false; $('#f-send').disabled = false; drawFeature();
    });
    if (pending()) fsay('You sent a burn from this browser that has not been recorded yet. Press the button to finish. Nothing is sent from your wallet again.', 'note');
  }

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
  // Two steps in the owner's wallet: sign the statement, then send it to the registry.
  $('#nameit')?.addEventListener('click', async () => {
    try {
      const from = await connect();
      if (from.toLowerCase() !== A.owner.toLowerCase()) throw new Error('Connect the wallet that owns this unit (' + short(A.owner) + ').');
      const deadline = Math.floor(Date.now() / 1000) + 240;
      const sig = await eth().request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify({
        domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: cfg.chainId, verifyingContract: cfg.identity },
        primaryType: 'AgentWalletSet', message: { agentId: String(A.identity), newWallet: A.wallet, owner: from, deadline: String(deadline) },
        types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
          AgentWalletSet: [{ name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
      })] });
      // what the wallet contract checks: (agentId, deadline, the owner's signature), packed the standard way
      const blob = uintWord(A.identity) + uintWord(deadline) + uintWord(96) + uintWord(65) + sig.replace(/^0x/, '').padEnd(192, '0');
      const data = cfg.selectors.setAgentWallet + uintWord(A.identity) + word(A.wallet) + uintWord(deadline) + uintWord(128) + uintWord(blob.length / 2) + blob;
      const h = await sendTx(from, cfg.identity, data);
      oerr('Sent. The registry will show this wallet within a minute. Transaction ' + short(h), 'ok'); setTimeout(load, 65_000);
    } catch (e) { oerr(explain(e)); }
  });
}

// click a command to copy it
document.querySelectorAll('[data-copy]').forEach((pre) => {
  pre.style.cursor = 'copy'; pre.title = 'Click to copy';
  pre.addEventListener('click', async () => { const t = pre.textContent; try { await navigator.clipboard.writeText(t); pre.textContent = 'Copied'; setTimeout(() => (pre.textContent = t), 900); } catch {} });
});

({ create: pageCreate, floor: pageFloor, agent: pageAgent })[document.body.dataset.page]?.().catch(() => {});
