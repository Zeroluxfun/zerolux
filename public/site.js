// Zero Lux page behaviour: nav state, reveals, hero depth, waitlist forms.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('solid', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  requestAnimationFrame(() => root.classList.add('lit'));

  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.14 });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));

  // The wordmark drifts a little against the machinery in front of it.
  const hero = document.querySelector('.hero');
  const word = document.querySelector('.word');
  if (hero && word && !still && matchMedia('(pointer: fine)').matches) {
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
    const tick = () => {
      x += (tx - x) * 0.07; y += (ty - y) * 0.07;
      word.style.setProperty('--dx', x.toFixed(2) + 'px');
      word.style.setProperty('--dy', y.toFixed(2) + 'px');
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.05 ? requestAnimationFrame(tick) : 0;
    };
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * -34;
      ty = ((e.clientY - r.top) / r.height - 0.5) * -16;
      if (!raf) raf = requestAnimationFrame(tick);
    });
  }

  // Glass panels: the highlight follows the pointer.
  if (matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.glass').forEach((el) => el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--gx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--gy', (e.clientY - r.top) + 'px');
    }));
  }

  // Live readings, counted from the units' wallet contracts.
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  fetch('/api/agents').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    set('r-agents', d.totals.agents.toLocaleString('en-US'));
    set('r-runs', d.totals.runs.toLocaleString('en-US'));
    set('r-income', '$' + (Number(d.totals.income) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }).catch(() => {});

  document.querySelectorAll('form.join').forEach((form) => {
    const input = form.querySelector('input');
    const button = form.querySelector('button');
    const note = form.parentElement.querySelector('.note');
    const first = note ? note.textContent : '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!email) return;
      button.disabled = true;
      try {
        const res = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (res.ok) {
          form.classList.add('done');
          input.value = ''; input.placeholder = 'You are on the list';
          if (note) note.textContent = 'Logged. An email only when something ships.';
        } else {
          if (note) note.textContent = res.status === 400 ? 'That address does not look right.' : 'That did not go through. Try again.';
          button.disabled = false;
        }
      } catch {
        if (note) note.textContent = 'That did not go through. Try again.';
        button.disabled = false;
      }
    });
    input.addEventListener('input', () => { if (note && !form.classList.contains('done')) note.textContent = first; });
  });
})();
