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

// An agent's answer as page content: plain text, with any picture the agent made (an address under /api/images/ on this
// site, and nothing else) shown as the picture. The path is rebuilt from the id, so no other address can ever be loaded.
function answer(text) {
  const out = []; let at = 0;
  for (const m of String(text ?? '').matchAll(/https:\/\/zerolux\.fun\/api\/images\/([0-9a-f]{32})/g)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const src = '/api/images/' + m[1];
    out.push(el('a', { class: 'pic', href: src, target: '_blank', rel: 'noopener' }, el('img', { src, alt: 'Picture made by this agent', loading: 'lazy' })));
    at = m.index + m[0].length;
  }
  if (at < String(text ?? '').length) out.push(String(text).slice(at));
  return out;
}

// ---- the line ----
async function pageCreate() {
  const stations = [...document.querySelectorAll('.station')], belt = $('.belt');
  const err = $('#err'), go = $('#go'), job = $('#job');
  let timer, draft, picked = new Set(), model = 'fast';
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
    $('#s-chips').replaceChildren(el('span', { class: 'chip', text: 'Wallet with spend limits' }));
    // The model: the line's suggestion is selected, and the builder can choose any other before launch. A stronger one costs more a run.
    model = s.model;
    const perM = (m) => m.rate ? '$' + m.rate[0] + ' in, $' + m.rate[1] + ' out per million tokens' : '';
    $('#s-models').replaceChildren(...Object.entries(draft.models).map(([k, m]) => {
      const b = el('button', { type: 'button', class: 'mpick' + (k === model ? ' on' : ''), role: 'radio', 'aria-checked': String(k === model), title: perM(m) },
        el('b', { text: m.name || m.label }), el('span', { text: (m.maker || '') + (k === s.model ? ' · suggested' : '') }), el('i', { text: 'from ' + usd(m.minPrice) }));
      b.addEventListener('click', () => { model = k; for (const o of $('#s-models').children) { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', String(o === b)); } fit(); });
      return b;
    }));
    // The tools: the line's pick is switched on, and the builder can switch any of them on or off before launch.
    picked = new Set(s.tools);
    const floor = () => Math.max(draft.models[model].minPrice, ...[...picked].map((t) => draft.tool_floor?.[t] || 0));
    const fit = () => { const min = floor() / 1e6; $('#price').min = min.toFixed(2); if (!(Number($('#price').value) >= min)) $('#price').value = min.toFixed(2); $('#s-toolnote').textContent = [...picked].some((t) => draft.tool_floor?.[t]) ? 'Searches and pictures cost money each time they are used, so the lowest price with these tools is ' + usd(floor()) + ' a call.' : '';
      const m = draft.models[model]; $('#s-modelnote').textContent = 'Each run is charged what ' + (m.name || m.label) + ' costs for the words it reads and writes (' + perM(m) + '), so the lowest price on this model is ' + usd(m.minPrice) + ' a call. You can change the model later from the agent\'s page.'; };
    $('#s-tools').replaceChildren(...Object.entries(draft.tools).map(([t, text]) => {
      const b = el('button', { type: 'button', class: 'chip pick' + (picked.has(t) ? ' on' : ''), text, 'aria-pressed': String(picked.has(t)) });
      b.addEventListener('click', () => { picked.has(t) ? picked.delete(t) : picked.add(t); b.classList.toggle('on', picked.has(t)); b.setAttribute('aria-pressed', String(picked.has(t))); fit(); });
      return b;
    }));
    $('#price').value = (s.price / 1e6).toFixed(2); fit();
    $('#result').hidden = false; $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  // The fee this agent will carry: the standard rate, or a lower one if the owner's wallet has enough $LUX locked for long enough.
  let feeFor = '';
  const fee = async () => {
    const a = $('#owner').value.trim(), box = $('#s-fee'); if (!box) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { feeFor = ''; box.textContent = ''; return; }
    if (a === feeFor) return; feeFor = a;
    const r = await api('/api/lock/' + a); if (a !== feeFor || !r.ok) return;
    const L = r.data, pct = (b) => b / 100 + '%', low = L.tiers[0];
    box.replaceChildren(L.discounted ? `This wallet has ${Number(L.counted_lux).toLocaleString('en-US', { maximumFractionDigits: 0 })} $LUX locked, so this agent's fee will be ${pct(L.fee_bps)} instead of ${pct(L.standard_bps)}, for the life of the agent. ` : `This agent's fee will be ${pct(L.standard_bps)}. Lock ${Number(low.lux).toLocaleString('en-US')} $LUX for ${L.minDays} days or more first and it is built at ${pct(low.feeBps)}. `, el('a', { href: '/lock', text: L.discounted ? 'Your lock' : 'Lock $LUX' }));
  };
  $('#owner').addEventListener('input', fee);
  $('#usewallet').addEventListener('click', async () => {
    try { $('#owner').value = await connect(); $('#err2').textContent = ''; fee(); } catch (e) { $('#err2').textContent = explain(e); }
  });
  $('#launch').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#put'), e2 = $('#err2'); e2.textContent = ''; b.disabled = true; b.textContent = 'Putting it on chain…';
    const r = await api('/api/agents', { draft: draft.draft, owner: $('#owner').value.trim(), price_usd: Number($('#price').value), tools: [...picked], model });
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
  // The owner's unsaved profile changes. pPhoto: undefined keeps the picture, null removes it, text is a new one (base64 JPEG).
  let pPhoto, pDirty = false, ownerAsked = false;
  const botFace = () => '/media/bots/bot-' + String((A.id % 12) + 1).padStart(2, '0') + '.webp';
  const psay = (t, cls = 'err') => { const e = $('#perr'); e.className = cls; e.textContent = t; };
  // The owner's unsaved changes to what the unit does: the model and tools picked, and whether anything was touched.
  let eModel, eTools = new Set(), eDirty = false;
  // Its connections to outside tool servers, as rows of the form: a name, an address, the fingerprint of a saved key
  // (`key`) or a key just typed (`secret`), and the tools found when it was last saved. cDirty: a row was touched.
  let eConns = [], cDirty = false;
  const MAX_CONNS = 3;
  function drawConns() {
    const box = $('#e-conns'); if (!box) return;
    box.replaceChildren(...eConns.map((c, i) => {
      const field = (label, props, set) => { const inp = el('input', props); inp.addEventListener('input', () => { set(inp.value); eDirty = cDirty = true; }); return el('label', {}, el('span', { text: label }), inp); };
      return el('div', { class: 'stack', style: 'gap:8px;padding:12px;border:1px solid var(--line);border-radius:14px' },
        field('Name', { type: 'text', maxlength: '30', placeholder: 'Orders', value: c.name, autocomplete: 'off' }, (v) => { c.name = v; }),
        // A saved key only ever goes to the address it was saved for, so a new address needs the key again.
        field('Address', { type: 'text', maxlength: '300', placeholder: 'https://…/mcp', value: c.url, autocomplete: 'off', spellcheck: 'false' }, (v) => { c.url = v; if (c.key) { c.key = null; c.tools = []; } }),
        field('Key', { type: 'password', maxlength: '500', placeholder: c.key ? 'A key is saved. Leave blank to keep it' : 'Only if the server needs one', value: c.secret || '', autocomplete: 'off' }, (v) => { c.secret = v; }),
        c.tools?.length ? el('p', { class: 'note', text: c.tools.length + (c.tools.length === 1 ? ' tool: ' : ' tools: ') + c.tools.map((t) => t.name).join(', ') }) : null,
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'pill quiet sm', text: 'Remove', onclick: () => { eConns.splice(i, 1); eDirty = cDirty = true; drawConns(); } })));
    }));
    $('#e-addconn').hidden = eConns.length >= MAX_CONNS;
  }
  const esay = (t, cls = 'err') => { const e = $('#eerr'); e.className = cls; e.textContent = t; };
  const eFit = () => { $('#e-min').textContent = 'The lowest price with this model and these tools is ' + usd(Math.max(cfg.models[eModel]?.minPrice || 0, ...[...eTools].map((t) => cfg.tool_floor?.[t] || 0))) + ' a call.'; };
  function drawRevise() {
    if (!$('#revise') || eDirty) return;
    $('#e-name').value = A.name; $('#e-hint').value = A.input_hint || ''; $('#e-instr').value = A.instructions; $('#e-price').value = (Number(A.price) / 1e6).toFixed(2);
    eModel = A.model_key; eTools = new Set(A.tools);
    eConns = (A.connections || []).map((c) => ({ name: c.name, url: c.url, key: c.key, secret: '', tools: c.tools })); cDirty = false; drawConns();
    $('#e-models').replaceChildren(...Object.entries(cfg.models).map(([k, m]) => {
      const b = el('button', { type: 'button', class: 'mpick' + (k === eModel ? ' on' : ''), role: 'radio', 'aria-checked': String(k === eModel) },
        el('b', { text: m.name || m.label }), el('span', { text: m.maker || '' }), el('i', { text: 'from ' + usd(m.minPrice) }));
      b.addEventListener('click', () => { eModel = k; eDirty = true; for (const o of $('#e-models').children) { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', String(o === b)); } eFit(); });
      return b;
    }));
    $('#e-tools').replaceChildren(...Object.entries(cfg.tools).map(([t, text]) => {
      const b = el('button', { type: 'button', class: 'chip pick' + (eTools.has(t) ? ' on' : ''), text, 'aria-pressed': String(eTools.has(t)) });
      b.addEventListener('click', () => { eTools.has(t) ? eTools.delete(t) : eTools.add(t); eDirty = true; b.classList.toggle('on', eTools.has(t)); b.setAttribute('aria-pressed', String(eTools.has(t))); eFit(); });
      return b;
    }));
    eFit();
  }
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
    $('#chips').replaceChildren(el('span', { class: 'chip hot', text: usd(A.price) + ' a call in USDG' }), el('span', { class: 'chip', text: A.model + ' model' }), ...(A.fee_discount ? [el('span', { class: 'chip', text: 'Fee ' + A.fee_bps / 100 + '% · built with $LUX locked' })] : []), ...A.tools.map((t) => el('span', { class: 'chip', text: cfg.tools[t] })), ...(A.identity ? [el('span', { class: 'chip', text: 'ERC-8004 #' + A.identity })] : []), ...(A.connections || []).map((c) => el('span', { class: 'chip', text: 'Own tools: ' + c.name + ' · ' + c.tools.length })), ...(A.revision > 1 ? [el('span', { class: 'chip', text: 'Version ' + A.revision })] : []), ...(A.status !== 'live' ? [el('span', { class: 'chip', text: 'Off the line' })] : []));
    $('#l-income').textContent = usd(s.income); $('#l-cost').textContent = usd(s.charged); $('#l-profit').textContent = usd(s.profit); $('#l-runs').textContent = A.runs;
    const who = A.customers; if (who) $('#l-who').textContent = who.payers ? `${who.outside_payers} outside ${who.outside_payers === 1 ? 'customer has' : 'customers have'} paid ${usd(who.from_outside)}${who.top_outside_share != null ? `, the largest of them ${who.top_outside_share}% of that` : ''}. ${usd(who.from_insiders)} came from the owner, a pledge holder or Zero Lux's own test wallet.` : 'No one has paid this agent yet.';
    // A version 3 wallet counts outside income itself, on chain, net of refunds: show the contract's own figures.
    if (A.version >= 3 && s.externalIncome != null) $('#l-who').textContent = BigInt(s.externalIncome) + BigInt(s.insiderIncome) > 0n ? `On chain, this wallet counts ${usd(s.externalIncome)} from ${s.payerCount} outside ${s.payerCount === 1 ? 'customer' : 'customers'}${BigInt(s.externalIncome) > 0n ? `, the largest of them ${Math.round((Number(s.topPayerPaid) / Number(s.externalIncome)) * 100)}% of that` : ''}, and ${usd(s.insiderIncome)} from its owner, a pledge holder or their other wallets. ${usd(s.totalRefunded)} has been refunded to customers.` : `No one has paid this agent yet.${BigInt(s.totalRefunded || 0) > 0n ? ` ${usd(s.totalRefunded)} has been refunded to customers.` : ''}`;
    $('#wallet').replaceChildren(addr(A.wallet)); $('#owner').replaceChildren(addr(A.owner));
    $('#input').placeholder = A.input_hint || 'What should it work on?'; $('#pay').textContent = 'Pay ' + usd(A.price) + ' and run'; $('#pay').disabled = A.status !== 'live';
    $('#instr').textContent = A.instructions;
    // Its owner can change what it does. Say which version this is, and link every version it has had.
    const rv = $('#rev'); if (rv) rv.replaceChildren(A.revision > 1 ? `Version ${A.revision}${A.revised_at ? ', saved ' + new Date(A.revised_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : ''} by its owner. ` : 'Version 1: as it was built. Its owner can change it, and each change is a new version. ', el('a', { href: A.revisions, target: '_blank', rel: 'noopener', text: 'Every version' }));
    // Selling it elsewhere: the button as a visitor to another site would see it, the code to paste, and the same from JavaScript.
    const tagCode = `<script src="https://zerolux.fun/embed.js" data-agent="${A.id}"></` + 'script>';
    if ($('#embed')) {
      $('#embed').textContent = tagCode;
      $('#jsuse').textContent = `import { run, fromProvider } from 'https://zerolux.fun/zerolux.js';\n\nconst { output } = await run(${A.id}, 'your request', {\n  signer: fromProvider(window.ethereum),\n});`;
      const live = $('#embed-live'); if (!live.dataset.on && window.ZeroLux) { live.dataset.on = '1'; window.ZeroLux.mount(live, { agent: A.id }); }
      $('#embed-copy').onclick = async () => { try { await navigator.clipboard.writeText(tagCode); $('#embed-copy').textContent = 'Copied'; } catch { $('#embed-copy').textContent = 'Select the code and copy it'; } setTimeout(() => { $('#embed-copy').textContent = 'Copy the code'; }, 2000); };
    }
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
    drawHire(); drawFeature(); drawProfile(); drawRevise();
    return true;
  };
  // Version 3: which other units this one may hire during a run. The list lives on the wallet contract and only its owner can change it.
  const listed = () => A.can_hire_agents || [];
  const drawHire = () => {
    // What a customer should know before paying: this unit may pay other units out of the job. Names are set as text, never as markup.
    let t = $('#hire-terms'); if (!t && $('#hire')) { t = el('p', { class: 'note', id: 'hire-terms' }); $('#hire').append(t); }
    if (t) { t.hidden = !listed().length; t.textContent = listed().length ? 'During a run this unit may pay up to half of the job\'s budget to ' + listed().map((x) => `unit ${x.agent_id} "${x.name}"`).join(', ') + '. Money paid to a hired unit that delivered is not refunded, even if the job itself fails.' : ''; }
    // The same for outside tool servers its owner connected: a customer is told before paying where parts of a request may go.
    let ct = $('#conn-terms'); if (!ct && $('#hire')) { ct = el('p', { class: 'note', id: 'conn-terms' }); $('#hire').append(ct); }
    const cs = A.connections || [];
    if (ct) { ct.hidden = !cs.length; ct.textContent = cs.length ? 'During a run this unit may send parts of your request to outside tool servers its owner connected: ' + cs.map((c) => `${c.name} (${c.host}: ${c.tools.map((t) => t.name).join(', ')})`).join('; ') + '. Zero Lux does not run them.' : ''; }
    const l = $('#ch-list'); if (!l) return;
    l.replaceChildren(...(listed().length ? listed().map((x) => el('span', { style: 'display:block', text: `Unit ${x.agent_id} "${x.name}" · ${usd(x.price)} a call · wallet ${x.wallet}` })) : ['This unit cannot hire any other unit yet.']));
  };
  if (!(await load())) return;
  if (A.version >= 3 && $('#oerr')) {
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
        if (allowed && !(T.version >= 3 && T.version === A.version)) throw new Error('A unit can only hire units on its own wallet version (' + A.version + ').');
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
    if (r.data.again) throw new Error('This is taking longer than it should. Your payment is safe: press the button again to pick the run up, within 15 minutes.' + (A.version >= 3 ? ' After that it is returned to your wallet, less what the attempts cost and the network charge' + (A.can_hire_agents?.length ? ', and less anything it paid a unit it hired.' : '.') : ''));
    // The ticket is only let go on a result or an answer that says this payment is finished.
    if (!r.ok && !r.data.final) throw new Error((r.data.error || 'Something went wrong.') + ' Your payment is kept: press the button again to pick the run up.');
    keep(null);
    if (!r.ok) throw new Error(r.data.error || 'The run failed.');
    $('#out').hidden = false; $('#out').replaceChildren(...answer(r.data.output));
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

  // ---- pay by card: credit bought through Stripe's checkout and kept under a code this browser holds ----
  if ($('#cardbox')) (async () => {
    const cfg = await config(); if (!cfg.card?.on) return;
    const LS = 'zl-credit', KEEPC = 'zl-cardrun-' + id, DRAFT = 'zl-carddraft-' + id;
    const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const code = () => { try { const v = localStorage.getItem(LS); return /^[0-9a-f]{64}$/.test(v || '') ? v : null; } catch { return null; } };
    const setCode = (v) => { try { localStorage.setItem(LS, v); return true; } catch { return false; } };
    const account = async (v) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const ss = { get: (k) => { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v ?? null)); } catch {} } };
    let bal = 0, hold = false;
    const go = $('#card-go');
    const draw = () => {
      const enough = bal >= Number(A.price) && !hold, waiting = ss.get(KEEPC);
      $('#card-note').textContent = hold ? 'Your credit is on hold: a card payment that funded it was disputed.' : bal > 0 ? `You have ${usd(String(bal), 2)} of credit.` : 'No wallet? Pay by card: buy credit once, spend it on any agent.';
      go.textContent = waiting ? 'Pick up your paid run' : enough ? `Pay ${usd(A.price)} from credit` : bal > 0 ? 'Add more credit' : 'Pay by card';
      go.disabled = A.status !== 'live' || hold;
      $('#card-code').hidden = !code(); if (code()) $('#card-key').value = code();
    };
    const refresh = async () => { const c = code(); if (c) { const r = await api('/api/credits', null, { 'x-credits': c }); if (r.ok) { bal = Number(r.data.balance); hold = !!r.data.on_hold; } } draw(); };
    $('#cardbox').hidden = false;
    $('#card-list').replaceChildren(...cfg.card.packs.map((p) => el('button', { class: 'pill quiet sm', type: 'button', 'data-pack': p.id, text: `${usd(p.credit, 2)} of credit for $${(p.charge_cents / 100).toFixed(2)}` })));
    // Back from Stripe: the checkout is confirmed with the server, which reads it from Stripe itself.
    const q = new URLSearchParams(location.search), came = q.get('card');
    if (came) {
      q.delete('card'); history.replaceState(null, '', location.pathname + (q.size ? '?' + q : ''));
      const d = ss.get(DRAFT); if (d && !$('#input').value) $('#input').value = d; ss.set(DRAFT, null);
      if (came.startsWith('cs_')) {
        say('Checking your card payment…', 'note');
        let r; for (let i = 0; i < 6; i++) { r = await api('/api/credits/confirm', { session: came }); if (r.ok || !r.data.again) break; await new Promise((s) => setTimeout(s, 2500)); }
        say(r.ok ? `Added ${usd(r.data.credit, 2)} of credit. Press the button to run this unit.` : (r.data.error || 'The card payment could not be confirmed.'), r.ok ? 'ok' : 'err');
      }
    }
    await refresh();
    async function runCard(ticket, input) {
      let r;
      for (let tries = 0; tries < 60; tries++) {
        r = await api(`/a/${id}/run`, { input, ticket }, { 'x-credits': code() });
        if (r.ok || !r.data.again) break;
        await new Promise((s) => setTimeout(s, 5000));
      }
      if (r.data.again) throw new Error('This is taking longer than it should. Press the button again to pick the run up. If it never runs, the credit comes back.');
      ss.set(KEEPC, null);
      if (!r.ok) throw new Error(r.data.error || 'The run failed.');
      $('#out').hidden = false; $('#out').replaceChildren(...answer(r.data.output));
      $('#receipt').replaceChildren('Paid ' + usd(r.data.paid) + ' from credit · ', tx(r.data.tx)); say('');
      setTimeout(load, 9000);
    }
    go.addEventListener('click', async () => {
      const waiting = ss.get(KEEPC), input = $('#input').value.trim();
      if (!waiting && !(bal >= Number(A.price))) { $('#card-packs').hidden = !$('#card-packs').hidden; return; }
      if (!waiting && !input) { $('#input').focus(); say('Write what the unit should work on first.'); return; }
      go.disabled = true; say(''); go.replaceChildren(el('span', { class: 'spin' }), ' Working…');
      try { const w = waiting || { ticket: rnd(16), input }; ss.set(KEEPC, w); await runCard(w.ticket, w.input); } catch (x) { say(explain(x)); }
      await refresh();
    });
    $('#card-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pack]'); if (!b) return;
      if (!code() && !setCode(rnd(32))) { say('This browser will not keep the credit code, so credit bought here would be lost. Turn off private browsing and try again.'); return; }
      b.disabled = true; say('');
      ss.set(DRAFT, $('#input').value || null);
      const r = await api('/api/credits/checkout', { account: await account(code()), pack: b.dataset.pack, back: '/a/' + id });
      if (r.ok && r.data.url) { location.href = r.data.url; return; }
      b.disabled = false; say(r.data.error || 'The card checkout could not be opened.');
    });
    $('#card-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(code()); $('#card-copy').textContent = 'Copied'; } catch { $('#card-key').select(); } });
    $('#card-use').addEventListener('click', async () => {
      const v = $('#card-other').value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(v)) { say('That is not a credit code.'); return; }
      if (bal > 0 && v !== code()) { say('This browser still holds credit under its own code. Copy that code somewhere safe before switching, then press again.'); bal = 0; return; }
      setCode(v); $('#card-other').value = ''; say('Using that code.', 'ok'); await refresh();
    });
  })();

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

  // ---- profile: the owner's photo, tagline and links. Saved with a signed message, not a transaction. ----
  function drawProfile() {
    const f = $('#face'); f.src = A.photo || botFace(); f.hidden = false;
    const l = A.links || {}, pl = $('#plinks');
    pl.replaceChildren(...[l.x ? el('a', { href: 'https://x.com/' + l.x, target: '_blank', rel: 'noopener nofollow ugc', text: '@' + l.x }) : null,
      l.site && /^https:\/\//.test(l.site) ? el('a', { href: l.site, target: '_blank', rel: 'noopener nofollow ugc', text: l.site.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '') }) : null].filter(Boolean));
    pl.hidden = !(l.x || l.site);
    if (!$('#profile')) return;
    if (!pDirty) { $('#p-tag').value = A.tagline && A.tagline !== A.built_tagline ? A.tagline : ''; $('#p-x').value = l.x ? '@' + l.x : ''; $('#p-site').value = l.site || ''; }
    $('#p-tag').placeholder = A.built_tagline || '';
    $('#p-prev').src = typeof pPhoto === 'string' ? 'data:image/jpeg;base64,' + pPhoto : pPhoto === null ? botFace() : A.photo || botFace();
    $('#p-clear').hidden = !(typeof pPhoto === 'string' || (pPhoto === undefined && A.photo));
    $('#face-edit').textContent = A.photo ? 'Change picture' : 'Add a picture';
    // A wallet already connected to this site that owns the unit gets the button beside the picture. Asking which accounts are connected opens no prompt.
    if (!ownerAsked && A.owner) {
      ownerAsked = true;
      try { eth()?.request({ method: 'eth_accounts' }).then((got) => { if ((got || []).some((w) => String(w).toLowerCase() === A.owner.toLowerCase())) $('#face-edit').hidden = false; }).catch(() => {}); } catch {}
    }
  }
  // Opens the owner's section at the profile form and the file chooser, from the button beside the picture or on the new-agent notice.
  const toPhoto = () => { const f = $('#profile'); f.closest('details').open = true; f.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#p-file').click(); };
  // The chosen file is drawn onto a 512 by 512 square (centre crop) and saved as a JPEG, so what is sent is small and carries none of the file's hidden details.
  const squared = (file) => new Promise((done, fail) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return fail(new Error('Choose a JPEG, PNG or WebP picture.'));
    if (file.size > 20_000_000) return fail(new Error('That file is too large. Choose one under 20 MB.'));
    const rd = new FileReader();
    rd.onerror = () => fail(new Error('That file could not be read.'));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => fail(new Error('That file is not a picture this browser can open.'));
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight); if (!side) return fail(new Error('That picture is empty.'));
        const c = document.createElement('canvas'); c.width = c.height = 512;
        const g = c.getContext('2d'); g.fillStyle = '#05021A'; g.fillRect(0, 0, 512, 512); g.imageSmoothingQuality = 'high';
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
        for (const q of [.88, .8, .7, .55]) { const b64 = c.toDataURL('image/jpeg', q).split(',')[1] || ''; if (b64 && b64.length * 3 / 4 <= 290_000) return done(b64); }
        fail(new Error('That picture could not be made small enough. Try another.'));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
  if ($('#profile')) {
    for (const b of ['#face-edit', '#fresh-photo']) $(b).addEventListener('click', toPhoto);
    for (const i of ['#p-tag', '#p-x', '#p-site']) $(i).addEventListener('input', () => { pDirty = true; });
    $('#p-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      try { pPhoto = await squared(file); pDirty = true; psay('Not saved yet. Press Save profile.', 'note'); } catch (x) { psay(explain(x)); }
      drawProfile();
    });
    $('#p-clear').addEventListener('click', () => { pPhoto = typeof pPhoto === 'string' ? undefined : null; pDirty = true; psay(pPhoto === null ? 'Not saved yet. Press Save profile to take the photo down.' : '', 'note'); drawProfile(); });
    $('#profile').addEventListener('submit', async (e) => {
      e.preventDefault(); const b = $('#p-save'); if (b.disabled) return; b.disabled = true; psay('');
      try {
        const from = await connect();
        if (from.toLowerCase() !== A.owner.toLowerCase()) throw new Error('Connect the wallet that owns this unit (' + short(A.owner) + ').');
        const want = { tagline: $('#p-tag').value, x: $('#p-x').value, site: $('#p-site').value };
        let tag; // how the picture is named in the words to sign
        if (typeof pPhoto === 'string') {
          const bin = atob(pPhoto), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          tag = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
        } else if (pPhoto === null) tag = null;
        const path = '/api/agents/' + id + '/profile';
        const first = await api(path, { prepare: true, ...want, ...(tag !== undefined ? { photo: tag } : {}) });
        if (!first.ok) throw new Error(first.data.error || 'That did not go through. Try again.');
        const P = first.data, asHex = '0x' + [...new TextEncoder().encode(P.message)].map((v) => v.toString(16).padStart(2, '0')).join('');
        b.replaceChildren(el('span', { class: 'spin' }), ' Sign in your wallet…');
        const signature = await eth().request({ method: 'personal_sign', params: [asHex, from] });
        b.replaceChildren(el('span', { class: 'spin' }), ' Saving…');
        const r = await api(path, { tagline: P.tagline, x: P.x, site: P.site, time: P.time, signature, ...(pPhoto !== undefined ? { photo: pPhoto } : {}) });
        if (!r.ok) throw new Error(r.data.error || 'That did not go through. Try again.');
        A.photo = r.data.photo; A.links = r.data.links; A.tagline = r.data.tagline || A.built_tagline; pPhoto = undefined; pDirty = false;
        $('#tag').textContent = A.tagline || A.job;
        psay('Saved. The market shows it within a minute.', 'ok');
      } catch (x) { psay(explain(x)); }
      b.disabled = false; b.textContent = 'Save profile'; drawProfile();
    });
  }

  // ---- change what the unit does: a new version, saved with a signed message exactly as the profile is ----
  if ($('#revise')) {
    for (const i of ['#e-name', '#e-hint', '#e-instr', '#e-price']) $(i).addEventListener('input', () => { eDirty = true; });
    $('#e-addconn').addEventListener('click', () => { if (eConns.length < MAX_CONNS) { eConns.push({ name: '', url: '', key: null, secret: '', tools: [] }); eDirty = cDirty = true; drawConns(); } });
    $('#revise').addEventListener('submit', async (e) => {
      e.preventDefault(); const b = $('#e-save'); if (b.disabled) return; b.disabled = true; esay('');
      try {
        const from = await connect();
        if (from.toLowerCase() !== A.owner.toLowerCase()) throw new Error('Connect the wallet that owns this unit (' + short(A.owner) + ').');
        const want = { name: $('#e-name').value, input_hint: $('#e-hint').value, instructions: $('#e-instr').value, model: eModel, tools: [...eTools], price_usd: Number($('#e-price').value) };
        // Connections are sent only when a row was touched; otherwise they stay exactly as they are. The first step asks
        // each server for its tools; the second sends back the list that came from it, so what is signed is what is saved.
        const rows = eConns.map((c) => ({ ...c }));
        if (cDirty) want.connections = rows.map((c) => ({ name: c.name, url: c.url.trim(), ...(c.secret ? { secret: c.secret } : c.key ? { key: c.key } : {}) }));
        const path = '/api/agents/' + id + '/spec';
        b.replaceChildren(el('span', { class: 'spin' }), ' Checking…');
        const first = await api(path, { prepare: true, ...want });
        if (!first.ok) throw new Error(first.data.error || 'That did not go through. Try again.');
        const P = first.data;
        // The price is held between the lowest this model and these tools can run for and the most an agent may charge.
        if (P.spec.price !== Math.round(want.price_usd * 1e6)) { $('#e-price').value = (P.spec.price / 1e6).toFixed(2); throw new Error('That price is outside what this model and these tools allow. The box now shows the nearest one, ' + usd(P.spec.price) + '. Press Save changes again.'); }
        const asHex = '0x' + [...new TextEncoder().encode(P.message)].map((v) => v.toString(16).padStart(2, '0')).join('');
        b.replaceChildren(el('span', { class: 'spin' }), ' Sign in your wallet…');
        const signature = await eth().request({ method: 'personal_sign', params: [asHex, from] });
        b.replaceChildren(el('span', { class: 'spin' }), ' Saving…');
        const r = await api(path, { ...want, ...(cDirty ? { connections: (P.spec.connections || []).map((c, i) => ({ ...c, ...(rows[i]?.secret ? { secret: rows[i].secret } : {}) })) } : {}), revision: P.revision, time: P.time, signature });
        if (!r.ok) throw new Error(r.data.error || 'That did not go through. Try again.');
        eDirty = cDirty = false; await load();
        esay('Saved as version ' + r.data.revision + '. New runs use it from now.' + (r.data.note ? ' ' + r.data.note : ''), 'ok');
      } catch (x) { esay(explain(x)); }
      b.disabled = false; b.textContent = 'Save changes';
    });
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

// ---- lock $LUX ----
// A wallet locks $LUX in the lock contract (no owner, no early exit) and the agents it then builds get a lower fee rate.
// Everything here is sent from the visitor's own wallet: approve, lock, move the date later, withdraw once the date has come.
async function pageLock() {
  const cfg = await config(), K = cfg.lock, say = (t, cls = 'err') => { const e = $('#l-err'); e.textContent = t || ''; e.className = cls === 'err' ? 'err' : 'err ' + cls; };
  const n = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }), pct = (bps) => bps / 100 + '%';
  const day = (iso) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });
  const UNIT = 10n ** 18n, pause = (ms) => new Promise((s) => setTimeout(s, ms));
  let me = null, S = null, busy = false;
  if (!K?.locker) { $('#l-note').textContent = 'Locking is not switched on yet.'; $('#lockform').hidden = true; return; }
  $('#k-days').textContent = K.minDays; const kl = $('#k-locker'); kl.textContent = K.locker; kl.href = cfg.explorer + '/address/' + K.locker;
  const tiers = () => $('#tiers').replaceChildren(...[{ lux: '0', feeBps: K.standardBps }, ...K.tiers].map((t) => el('div', { class: 'tier glass' + (S && S.fee_bps === t.feeBps ? ' mine' : '') },
    el('span', { class: 'lbl', text: t.lux === '0' ? 'Nothing locked' : n(t.lux) + ' $LUX locked' }), el('b', { class: t.lux === '0' ? '' : 'heat', text: pct(t.feeBps) + ' fee' }),
    el('span', { text: t.lux === '0' ? 'The standard rate on every run.' : 'On every run of each agent you build, for the life of the agent.' }))));
  tiers();
  const draw = () => {
    tiers(); if (!S) return;
    $('#l-bal').textContent = n(BigInt(S.balance) / UNIT); $('#l-locked').textContent = n(S.locked_lux);
    $('#l-until').textContent = S.unlock_at && S.locked !== '0' ? day(S.unlock_at) + (S.open ? ' (open now)' : '') : '–';
    $('#l-fee').textContent = pct(S.fee_bps);
    const next = K.tiers.find((t) => BigInt(t.lux) * UNIT > BigInt(S.counted));
    $('#l-note').textContent = S.open ? 'Your lock has reached its date. You can withdraw it, or lock again for a lower fee.'
      : S.locked !== '0' && S.counted === '0' ? `Your lock has fewer than ${K.minDays} days left, so it gives no lower fee on new agents. Move the date later to build at a lower fee.`
      : S.discounted ? `Agents this wallet builds now pay a ${pct(S.fee_bps)} fee instead of ${pct(S.standard_bps)}.` + (next ? ` Lock ${n(BigInt(next.lux) - BigInt(S.counted) / UNIT)} more to reach ${pct(next.feeBps)}.` : '')
      : next ? `Lock ${n(BigInt(next.lux) - BigInt(S.counted) / UNIT)} $LUX for ${K.minDays} days or more and agents this wallet builds pay a ${pct(next.feeBps)} fee.` : '';
    $('#l-connect').textContent = short(me); $('#l-extend').hidden = S.locked === '0' || S.open; $('#l-withdraw').hidden = !S.open;
  };
  const load = async () => { const r = await api('/api/lock/' + me); if (!r.ok) throw new Error(r.data.error || 'Your lock could not be read. Try again.'); S = r.data; draw(); };
  const need = async () => { if (!me) { me = await connect(); await load(); } return me; };
  // Wait for a transaction the wallet sent: up to three minutes, then say where things stand.
  const mined = async (hash) => {
    for (let i = 0; i < 90; i++) {
      const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
      if (r) { if (r.status === '0x1') return; throw new Error('The chain refused that transaction. Nothing was locked.'); }
      await pause(2000);
    }
    throw new Error('The chain has not confirmed it yet. Check your wallet, then reload this page.');
  };
  const until = (days) => { const t = Math.floor(Date.now() / 1000) + days * 86_400, has = S?.unlock_at && S.locked !== '0' ? Math.floor(Date.parse(S.unlock_at) / 1000) : 0; return Math.max(t, has); };
  const act = async (label, fn) => {
    if (busy) return; busy = true; const b = $('#l-go'); b.disabled = true; say('');
    try { await need(); await fn(); await pause(1500); await load(); say(label, 'ok'); } catch (e) { say(explain(e)); }
    busy = false; b.disabled = false; b.textContent = 'Lock $LUX';
  };
  $('#l-connect').addEventListener('click', async () => { try { say(''); me = null; await need(); } catch (e) { say(explain(e)); } });
  document.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.amt !== 'max') { $('#l-amount').value = b.dataset.amt; return; }
    try { await need(); $('#l-amount').value = (BigInt(S.balance) / UNIT).toString(); } catch (e) { say(explain(e)); }
  }));
  $('#lockform').addEventListener('submit', (e) => {
    e.preventDefault();
    act('Locked. The lower fee applies to agents this wallet builds from now on.', async () => {
      const whole = String($('#l-amount').value).trim(); if (!/^[1-9]\d{0,11}$/.test(whole)) throw new Error('Enter a whole number of $LUX.');
      const units = BigInt(whole) * UNIT, days = Number($('#l-days').value);
      if (units > BigInt(S.balance)) throw new Error(`This wallet holds ${n(BigInt(S.balance) / UNIT)} $LUX, which is less than that.`);
      const b = $('#l-go');
      if (BigInt(S.allowance) < units) { b.textContent = 'Step 1 of 2: approve in your wallet…'; await mined(await sendTx(me, S.lux, '0x095ea7b3' + word(S.locker) + uintWord(units))); await pause(2500); }
      b.textContent = 'Lock in your wallet…';
      await mined(await sendTx(me, S.locker, '0x3efa9979' + uintWord(units) + uintWord(until(days)))); // lock(uint256,uint64)
    });
  });
  $('#l-extend').addEventListener('click', () => act('Done. The date has moved later.', async () => {
    const to = Math.floor(Date.now() / 1000) + Number($('#l-days').value) * 86_400;
    if (to <= Math.floor(Date.parse(S.unlock_at) / 1000)) throw new Error('Choose a longer time under "Locked for": the new date has to be later than ' + day(S.unlock_at) + '.');
    await mined(await sendTx(me, S.locker, '0x6c7709c0' + uintWord(to))); // extend(uint64)
  }));
  $('#l-withdraw').addEventListener('click', () => act('Withdrawn. Your $LUX is back in your wallet.', async () => { await mined(await sendTx(me, S.locker, '0x3ccfd60b')); })); // withdraw()
}

({ create: pageCreate, floor: pageFloor, agent: pageAgent, lock: pageLock })[document.body.dataset.page]?.().catch(() => {});
