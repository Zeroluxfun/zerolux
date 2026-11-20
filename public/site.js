// Zero Lux home page: reveals, the job box, live readings and floor read from the chain, the belt, the email form.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  requestAnimationFrame(() => root.classList.add('lit'));
  const $ = (s) => document.querySelector(s);
  const usd = (n) => '$' + (Number(n || 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.forEach((k) => e.append(k)); return e; };

  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.14 });
  document.querySelectorAll('.rv').forEach((n) => io.observe(n));

  // The hero print moves: the line carries the white-hot unit to the front, rests, and runs again.
  // Skipped for people who ask for less motion or less data; the still print stays in place.
  const loop = $('#heroloop');
  if (loop && !matchMedia('(prefers-reduced-motion: reduce)').matches && !navigator.connection?.saveData) {
    loop.addEventListener('playing', () => loop.classList.add('on'), { once: true });
    loop.src = innerWidth * (window.devicePixelRatio || 1) > 1400 ? '/media/print-line-loop.mp4' : '/media/print-line-loop-720.mp4';
    loop.play().catch(() => {});
  }

  // The job box: it grows with the text, Enter sends it to the line, the examples fill it.
  const job = $('#job');
  if (job) {
    const fit = () => { job.style.height = '52px'; job.style.height = Math.min(160, job.scrollHeight) + 'px'; };
    job.addEventListener('input', fit);
    job.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (job.value.trim()) job.form.requestSubmit(); } });
    document.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', () => { job.value = b.dataset.job; fit(); job.focus(); }));
  }

  document.querySelectorAll('pre[data-copy]').forEach((pre) => {
    pre.style.cursor = 'copy'; pre.title = 'Click to copy';
    pre.addEventListener('click', () => navigator.clipboard?.writeText(pre.textContent.trim()).then(() => { pre.title = 'Copied'; }).catch(() => {}));
  });

  // Readings, the floor and the belt, all counted from the agents' wallet contracts.
  const belt = $('#belt');
  const fillBelt = (inks) => { if (!belt) return; const one = inks.length ? inks : ['', '', '', '']; const row = []; while (row.length < 80) row.push(...one); belt.replaceChildren(...[...row, ...row].map((c) => el('i', { className: c }))); };
  fillBelt([]);
  fetch('/api/agents').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set('r-agents', d.totals.agents.toLocaleString('en-US'));
    set('r-runs', d.totals.runs.toLocaleString('en-US'));
    set('r-income', usd(d.totals.income));
    set('r-profit', usd(d.totals.profit));
    const agents = [...d.agents].sort((a, b) => Number(b.stats?.profit || 0) - Number(a.stats?.profit || 0));
    const top = Math.max(1, ...agents.map((a) => Number(a.stats?.profit || 0)));
    fillBelt(agents.map((a) => { const h = Number(a.stats?.profit || 0) / top; return h > 0.75 ? 'w' : h > 0.35 ? 'o' : h > 0 ? 'm' : ''; }));
    const rows = $('#f-rows');
    if (rows) {
      rows.replaceChildren(...(agents.length ? agents.slice(0, 5).map((a) => el('a', { className: 'row2', href: '/a/' + a.id },
        el('span', {}, el('b', { textContent: a.name }), el('small', { textContent: usd(a.price) + ' a call · ' + (a.runs || 0) + (a.runs === 1 ? ' run' : ' runs') })),
        el('span', { className: 'num hide', textContent: usd(a.stats?.income) }),
        el('span', { className: 'num', textContent: usd(a.stats?.profit) }),
        el('span', { className: 'go', textContent: 'HIRE →' }))) : [el('div', { className: 'row2' }, el('span', { className: 'lbl', textContent: 'No agents yet' }))]));
      set('f-at', agents.length + (agents.length === 1 ? ' agent' : ' agents') + ' · live');
    }
  }).catch(() => {});

  const form = $('form.join'), note = $('#join-note');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input'), button = form.querySelector('button'), email = input.value.trim();
    if (!email) return;
    button.disabled = true;
    try {
      const res = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (res.ok) { input.value = ''; note.textContent = 'Logged. An email only when something ships.'; }
      else { note.textContent = res.status === 400 ? 'That address does not look right.' : 'That did not go through. Try again.'; button.disabled = false; }
    } catch { note.textContent = 'That did not go through. Try again.'; button.disabled = false; }
  });
})();
