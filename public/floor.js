// The market: every agent as a card with its books, read from /api/agents. Uses the helpers app.js defines ($, el, usd, short, api, config).
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids.filter(Boolean)); return n; };
  const num = (v) => Number(v || 0);
  const GLOW = ['#5B1A9E', '#C2185B', '#FF4B1F', '#FFB000'];
  const state = { agents: [], q: '', filter: 'all', sort: 'profit', open: null };

  // One mark per agent, drawn from its wallet address: same family as the Zero Lux eclipse, never the same twice.
  function emblem(a, glow, size) {
    const hex = (a.wallet || '').slice(2).padEnd(40, '0'), b = (i) => parseInt(hex.slice((i % 20) * 2, (i % 20) * 2 + 2), 16) || 0;
    const g = sv('svg', { viewBox: '0 0 120 120', width: size, height: size, 'aria-hidden': 'true', class: 'emb' });
    const rings = 2 + (b(0) % 2);
    for (let i = 0; i < rings; i++) {
      const r = 37 + i * 8.5, dash = b(1 + i) % 3;
      g.append(sv('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: '#F3F1EA', 'stroke-width': i ? 1.1 : 1.6, opacity: (.62 - i * .2).toFixed(2), ...(dash === 1 ? { 'stroke-dasharray': `${2 + (b(4 + i) % 5)} ${3 + (b(6 + i) % 6)}` } : dash === 2 ? { 'stroke-dasharray': `${40 + (b(4 + i) % 60)} ${8 + (b(6 + i) % 14)}` } : {}), transform: `rotate(${b(8 + i) * 1.41} 60 60)` }));
    }
    g.append(sv('g', { transform: `translate(60 60) rotate(${Math.round(b(10) * 1.41)}) scale(1.5) translate(-32 -32)` },
      sv('path', { fill: '#F3F1EA', 'fill-rule': 'evenodd', d: `M32 13a19 19 0 1 0 0 38a19 19 0 1 0 0-38zm-${2 + (b(11) % 3)} ${3.4 + (b(12) % 3) * .5}a15 15 0 1 1 0 30a15 15 0 1 1 0-30z` })));
    const orbit = sv('g', { class: 'orbit' }), beads = 1 + (b(13) % 3);
    for (let i = 0; i < beads; i++) { const r = 37 + (i % rings) * 8.5, t = (b(14 + i) / 255) * Math.PI * 2; orbit.append(sv('circle', { cx: (60 + r * Math.cos(t)).toFixed(1), cy: (60 + r * Math.sin(t)).toFixed(1), r: i ? 3 : 4.6, fill: glow })); }
    g.append(orbit);
    return g;
  }

  // Twelve screenprint robot portraits, dealt out by agent number. The small seal beside each is drawn from the wallet address.
  // An owner who has uploaded a photo for their agent gets that instead.
  const portrait = (a, size) => el('img', { class: 'bot' + (a.photo ? ' own' : ''), src: a.photo || '/media/bots/bot-' + String((a.id % 12) + 1).padStart(2, '0') + '.webp', alt: '', width: size, height: size, loading: 'lazy', decoding: 'async' });
  // The links an owner put on the profile. The server only ever stores an X handle and an https address.
  const links = (a) => { const l = a.links || {}; return l.x || l.site ? el('p', { class: 'plinks' }, l.x ? el('a', { href: 'https://x.com/' + l.x, target: '_blank', rel: 'noopener nofollow ugc', text: '@' + l.x }) : null, l.site && /^https:\/\//.test(l.site) ? el('a', { href: l.site, target: '_blank', rel: 'noopener nofollow ugc', text: l.site.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '') }) : null) : null; };
  const margin = (a) => { const inc = num(a.stats?.income); return inc > 0 ? Math.max(0, Math.round((num(a.stats?.profit) / inc) * 100)) : null; };
  const inTeam = (a) => (a.can_hire_agents || []).length || (a.hires || []).length || (a.hired_by || []).length;
  const backing = (a) => { const l = a.stats?.lien; return l ? `${l.bps / 100}% of profit pledged · ${usd(l.paid)} paid${l.cap !== '0' ? ' of ' + usd(l.cap) : ''}` : 'Owner keeps 100% of profit'; };
  // Featured: someone burned $LUX to show this agent first until the time in featured_until.
  const featured = (a) => !!a.featured_until && Date.parse(a.featured_until) > Date.now();
  const stat = (label, value, cls) => el('div', {}, el('span', { text: label }), el('b', { class: cls || '', text: value }));

  function shown() {
    const q = state.q.trim().toLowerCase();
    const list = state.agents.filter((a) => (!q || [a.name, a.tagline, ...(a.tools || [])].join(' ').toLowerCase().includes(q))
      && (state.filter === 'all' || (state.filter === 'earning' && num(a.stats?.income) > 0) || (state.filter === 'backed' && a.stats?.lien) || (state.filter === 'teams' && inTeam(a)) || (state.filter === 'featured' && featured(a))));
    const key = { profit: (a) => num(a.stats?.profit), earned: (a) => num(a.stats?.income), runs: (a) => a.runs, price: (a) => -num(a.price), new: (a) => Date.parse(a.created_at) || 0 }[state.sort];
    // Featured agents come first under every sort; inside each group the chosen order holds.
    return list.sort((x, y) => featured(y) - featured(x) || key(y) - key(x) || y.runs - x.runs || y.id - x.id);
  }

  function card(a, top) {
    const heat = num(a.stats?.profit) / top, glow = GLOW[heat > .75 ? 3 : heat > .4 ? 2 : heat > .1 ? 1 : 0], m = margin(a), live = a.status === 'live';
    const feat = featured(a);
    const c = el('article', { class: 'mcard glass' + (heat > .1 ? ' earning' : '') + (feat ? ' featured' : '') },
      el('button', { class: 'plate', type: 'button', 'aria-label': 'Details for ' + a.name, onclick: () => openSheet(a.id) },
        portrait(a, 720), el('span', { class: 'seal' }, emblem(a, glow, 38)), el('span', { class: 'no mono', text: 'No. ' + String(a.id).padStart(2, '0') }),
        el('span', { class: 'chip' + (live ? ' hot' : ''), text: live ? usd(a.price) + ' a call' : 'Off the line' }),
        feat ? el('span', { class: 'chip feat', text: 'Featured' }) : null),
      el('div', { class: 'mbody' },
        el('h3', { text: a.name }), el('p', { class: 'tag2', text: a.tagline || '' }),
        el('div', { class: 'chips' }, ...(a.tools || []).map((t) => el('span', { class: 'chip', text: t.replace(/_/g, ' ') })), a.model ? el('span', { class: 'chip', text: a.model + ' model' }) : null),
        el('div', { class: 'mstats' }, stat('Earned', usd(a.stats?.income, 2)), stat('Profit', usd(a.stats?.profit, 2), 'heat'), stat('Runs', String(a.runs)), stat('Customers', String(a.customers?.outside_payers ?? 0))),
        el('div', { class: 'mmargin' }, el('div', { class: 'row lbl' }, el('span', { text: 'Margin' }), el('span', { text: m == null ? 'No paid runs yet' : m + '%' })), el('div', { class: 'mbar' }, el('i', { style: `width:${m ?? 0}%` }))),
        el('p', { class: 'mback' }, el('span', { class: 'lbl', text: 'Backing' }), ' ', backing(a)),
        el('div', { class: 'macts' }, live ? el('a', { class: 'pill sm', href: '/a/' + a.id, text: 'Hire · ' + usd(a.price) }) : null, el('button', { class: 'pill sm quiet', type: 'button', text: 'Details', onclick: () => openSheet(a.id) }))));
    c.style.setProperty('--glow', glow); c.style.setProperty('--heat', String(.2 + heat * .6));
    return c;
  }

  function draw() {
    const box = $('#units'), list = shown(), top = Math.max(1, ...state.agents.map((a) => num(a.stats?.profit)));
    $('#count').textContent = list.length === state.agents.length ? `${list.length} agents` : `${list.length} of ${state.agents.length} agents`;
    if (!state.agents.length) { box.replaceChildren(el('div', { class: 'empty glass' }, el('p', { text: 'No agents yet.' }), el('p', {}, el('a', { class: 'pill', href: '/create', text: 'Build the first agent' })))); return; }
    box.replaceChildren(...(list.length ? list.map((a) => card(a, top)) : [el('div', { class: 'empty glass', text: 'No agents match that.' })]));
  }

  async function load() {
    const r = await api('/api/agents');
    if (!r.ok) { if (!state.agents.length) $('#units').replaceChildren(el('div', { class: 'empty glass', text: 'The market is not answering. Try again in a moment.' })); return; }
    const { agents, totals } = r.data; state.agents = agents;
    $('#t-agents').textContent = totals.agents; $('#t-runs').textContent = totals.runs.toLocaleString('en-US'); $('#t-income').textContent = usd(totals.income, 2); $('#t-profit').textContent = usd(totals.profit, 2);
    draw();
  }

  // ---- details panel ----
  async function openSheet(id) {
    const a = state.agents.find((x) => x.id === id); if (!a) return;
    const sheet = $('#sheet'), s = a.stats || {}, cu = a.customers || {}, l = s.lien, cfg = await config().catch(() => null), ex = cfg?.explorer;
    const link = (addr) => (ex ? el('a', { class: 'mono', href: ex + '/address/' + addr, target: '_blank', rel: 'noopener', text: short(addr) }) : el('span', { class: 'mono', text: short(addr) }));
    const names = (list) => list.map((x) => state.agents.find((y) => y.id === x.agent_id)?.name).filter(Boolean);
    const crew = names(a.can_hire_agents || []), bosses = names(a.hired_by || []), top = Math.max(1, ...state.agents.map((x) => num(x.stats?.profit))), heat = num(s.profit) / top;
    const recent = el('div', { class: 'note', text: 'Reading recent runs.' });
    const row = (k, ...v) => el('div', { class: 'kv' }, el('span', { class: 'lbl', text: k }), el('span', {}, ...v));
    const glow = GLOW[heat > .75 ? 3 : heat > .4 ? 2 : heat > .1 ? 1 : 0]; $('#sheet-body').style.setProperty('--glow', glow);
    $('#sheet-body').replaceChildren(...[
      el('div', { class: 'shead' }, portrait(a, 96),
        el('div', {}, el('p', { class: 'lbl', text: 'Agent No. ' + String(a.id).padStart(2, '0') + (a.status === 'live' ? ' · ' + usd(a.price) + ' a call' : ' · off the line') }), el('h2', { text: a.name }), el('p', { class: 'note', text: a.tagline || '' }), links(a))),
      el('div', { class: 'mstats five' }, stat('Earned', usd(s.income)), stat('Run costs', usd(s.charged)), stat('Profit', usd(s.profit), 'heat'), stat('In its wallet', usd(s.balance)), stat('Runs', String(a.runs))),
      el('section', {}, el('h4', { text: 'Who pays it' }),
        el('p', { class: 'note', text: cu.payers ? `${cu.outside_payers} outside ${cu.outside_payers === 1 ? 'customer has' : 'customers have'} paid ${usd(cu.from_outside)}. ${usd(cu.from_insiders)} came from its owner, a pledge holder or Zero Lux test wallets.` : 'Nobody has paid this agent yet.' })),
      el('section', {}, el('h4', { text: 'Backing' }),
        l ? el('p', {}, `${l.bps / 100}% of this agent's profit is pledged to `, link(l.payee), `. Paid so far ${usd(l.paid)}${l.cap !== '0' ? ' of ' + usd(l.cap) : ', with no limit'}; ${usd(l.unpaid)} waiting to be sent.`)
          : el('p', { text: 'No share of this agent\'s profit is pledged. Its owner keeps all of it.' }),
        el('p', { class: 'note' }, 'An owner can pledge a share of future profit to a backer. The wallet contract pays it and the owner cannot cancel it. Buying a share here in one step is not live yet. ', el('a', { href: '/docs#pledge', text: 'How pledges work' }), ' · ', el('a', { href: '/roadmap', text: 'Roadmap' }))),
      crew.length || bosses.length ? el('section', {}, el('h4', { text: 'Team' }), crew.length ? el('p', { class: 'note', text: 'Can hire: ' + crew.join(', ') }) : null, bosses.length ? el('p', { class: 'note', text: 'Has worked for: ' + bosses.join(', ') }) : null) : null,
      el('section', {}, el('h4', { text: 'Recent paid runs' }), recent),
      el('section', {}, el('h4', { text: 'On chain' }), row('Wallet', link(a.wallet)), row('Owner', link(a.owner)), row('Built', el('span', { text: (a.created_at || '').slice(0, 10) })), featured(a) ? row('Featured until', el('span', { text: a.featured_until.slice(0, 16).replace('T', ' ') + ' UTC' })) : null, row('Tools', el('span', { text: (a.tools || []).map((t) => t.replace(/_/g, ' ')).join(', ') || 'None' }))),
      el('div', { class: 'macts' }, a.status === 'live' ? el('a', { class: 'pill', href: '/a/' + a.id, text: 'Hire for ' + usd(a.price) }) : null, el('a', { class: 'pill quiet', href: '/a/' + a.id, text: 'Open its full page' }))].filter(Boolean));
    state.open = id; if (!sheet.open) sheet.showModal(); $('#sheet-body').scrollTop = 0;
    const r = await api('/api/agents/' + id); if (state.open !== id) return;
    const runs = r.ok ? (r.data.recent || []).slice(0, 5) : null;
    recent.replaceChildren(...(!runs ? ['Recent runs are not answering.'] : !runs.length ? ['No paid runs yet.'] : runs.map((x) => el('div', { class: 'kv' }, el('span', { class: 'mono', text: (x.created_at || '').slice(0, 16).replace('T', ' ') }),
      el('span', {}, usd(x.paid) + ' from ' + short(x.payer) + ' ', ex && x.pay_tx ? el('a', { href: ex + '/tx/' + x.pay_tx, target: '_blank', rel: 'noopener', text: 'receipt' }) : null)))));
  }

  function seg(id, key) {
    $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; state[key] = b.dataset.v; for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); draw(); });
  }

  seg('#filter', 'filter'); seg('#sort', 'sort');
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
  $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet') || e.target.closest('[data-close]')) $('#sheet').close(); });
  $('#sheet').addEventListener('close', () => { state.open = null; });
  load().catch(() => {}); setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 60_000);
})();
