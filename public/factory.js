// The factory floor, live: one robot per agent, drawn with three.js in the site's print inks.
// Everything shown is read from /api/agents. A robot only works a moving belt if its agent has been paid
// for real runs; the rest wait, look around and watch the pointer. Nothing here invents activity.
import * as THREE from '/vendor/three.module.min.js';

const INK = { v: 0x7b3cff, vd: 0x4a2bb0, m: 0xe0218a, o: 0xff4b1f, w: 0xf3f1ea, k: 0x07031c, belt: 0x35208a };
const $ = (s) => document.querySelector(s);
const usd = (n) => '$' + (Number(n || 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.forEach((k) => k != null && e.append(k)); return e; };
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };

const canvas = $('#scene'), tags = $('#tags'), floats = $('#floats');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { /* no WebGL */ }
if (!renderer) { $('#nogl').hidden = false; throw new Error('no webgl'); }
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
const DIR = new THREE.Vector3(1, 0.86, 1).normalize();
const target = new THREE.Vector3(0, 0, 0), home = new THREE.Vector3();
let zoom = 1, fit = 14, grabbed = false, touched = 0;
scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(6, 14, 3); scene.add(sun);

const edge = new THREE.LineBasicMaterial({ color: INK.k });
function block(w, h, d, color, basic) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, basic ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color }));
  m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edge));
  return m;
}
const at = (mesh, x, y, z) => { mesh.position.set(x, y, z); return mesh; };

// the floor: dark paper with printed lane lines
const floor = new THREE.Group(); scene.add(floor);
function layFloor(w, d, cx, cz) {
  floor.clear();
  floor.add(at(new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x160b3d, transparent: true, opacity: 0.86 })), cx, -0.02, cz));
  const pts = [];
  for (let x = -w / 2; x <= w / 2 + 0.01; x += 2) pts.push(cx + x, 0, cz - d / 2, cx + x, 0, cz + d / 2);
  for (let z = -d / 2; z <= d / 2 + 0.01; z += 2) pts.push(cx - w / 2, 0, cz + z, cx + w / 2, 0, cz + z);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  floor.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: INK.v, transparent: true, opacity: 0.3 })));
}

const BELT = 11, UNITS = 5, ROW = 6.4, COL = 21;
const bots = new Map(); // agent id -> robot
let order = [];

function heatInk(h) { return h > 0.75 ? INK.w : h > 0.35 ? INK.o : h > 0 ? INK.m : INK.v; }

function makeBot(a) {
  const g = new THREE.Group(); g.userData.id = a.id;
  // belt and its legs
  g.add(at(block(BELT, 0.3, 1.5, INK.belt), -BELT / 2 - 0.4, 0.75, 0));
  for (const x of [-1.2, -BELT / 2 - 0.4, -BELT + 0.4]) g.add(at(block(0.25, 0.6, 1.3, INK.vd), x, 0.3, 0));
  // the out-tray the finished work drops into
  g.add(at(block(1.5, 0.5, 1.5, INK.vd), 2.9, 0.25, 0));
  const units = [];
  for (let i = 0; i < UNITS; i++) { const u = at(block(0.95, 0.75, 0.95, INK.v), 0, 1.28, 0); u.visible = false; g.add(u); units.push(u); }
  // the robot
  const bot = new THREE.Group(); bot.position.set(1.05, 0, 0); bot.scale.setScalar(1.35); g.add(bot);
  const legs = [at(block(0.34, 0.5, 0.34, INK.vd), 0, 0.25, -0.26), at(block(0.34, 0.5, 0.34, INK.vd), 0, 0.25, 0.26)];
  const body = at(block(0.95, 1.15, 1.05, INK.v), 0, 1.08, 0);
  const head = new THREE.Group(); head.position.set(0, 2.0, 0);
  head.add(block(0.8, 0.62, 0.8, 0x9a6bff));
  const eye = at(block(0.06, 0.18, 0.56, INK.o, true), -0.42, 0.02, 0); head.add(eye);
  head.add(at(block(0.08, 0.34, 0.08, INK.vd), 0.12, 0.46, 0.18));
  const arms = [-1, 1].map((s) => { const p = new THREE.Group(); p.position.set(0, 1.5, s * 0.64); p.add(at(block(0.24, 0.85, 0.24, 0x9a6bff), 0, -0.36, 0)); bot.add(p); return p; });
  bot.add(...legs, body, head);
  body.userData.id = a.id; head.children[0].userData.id = a.id;
  scene.add(g);
  const tag = el('a', { className: 'tag3', href: '/a/' + a.id });
  tags.append(tag);
  const r = { a, g, bot, body, head, eye, arms, units, tag, phase: Math.random() * 10, drop: 1, hop: 0, lift: null, wave: 0, isNew: false };
  bots.set(a.id, r);
  return r;
}

function dress(r, rank, top) {
  const a = r.a, profit = Number(a.stats?.profit || 0), h = top > 0 ? profit / top : 0;
  r.busy = (a.runs || 0) > 0; r.heat = h;
  r.eye.material.color.setHex(r.busy ? heatInk(h) : 0x6a4bd0);
  r.body.material.color.setHex(h > 0.75 ? INK.o : h > 0.35 ? INK.m : INK.v);
  r.speed = r.busy ? 0.9 + Math.min(a.runs, 20) * 0.07 : 0;
  r.units.forEach((u, i) => { u.visible = r.busy; u.material.color.setHex(i === 0 ? heatInk(Math.max(h, 0.4)) : i < Math.min(UNITS, a.runs + 1) ? INK.o : INK.v); });
  r.tag.replaceChildren(
    el('b', { textContent: (r.busy ? '#' + rank + ' ' : '') + a.name }),
    el('span', { textContent: r.busy ? `${usd(a.price)} a job · ${a.runs} done · ${usd(profit)} kept` : `${usd(a.price)} a job · waiting for a first job` }),
  );
  r.tag.classList.toggle('idle', !r.busy);
}

function arrange() {
  const cols = innerWidth <= 900 ? 1 : order.length > 16 ? 3 : order.length > 4 ? 2 : 1, rows = Math.ceil(order.length / cols) || 1;
  order.forEach((id, i) => { const r = bots.get(id); r.g.position.set((i % cols) * COL, 0, Math.floor(i / cols) * ROW); });
  const w = cols * COL - 4, d = rows * ROW + 2, cx = ((cols - 1) * COL) / 2 - BELT / 2 + 1.5, cz = ((rows - 1) * ROW) / 2;
  layFloor(w + 8, d + 6, cx, cz);
  const wide = innerWidth > 900; home.set(cx + (wide ? 2.2 : 0), 1, cz - (wide ? 2.2 : 0)); if (!touched) target.copy(home);
  fit = Math.max(8, Math.max(w * 0.3, d * 0.42));
  size();
}

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  const half = (fit / zoom) * Math.max(1, 1.15 / (w / h));
  camera.top = half; camera.bottom = -half; camera.left = -half * (w / h); camera.right = half * (w / h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', size);

// ---- what is going on: the shift log ----
const log = $('#log'); const seen = new Set();
function note(key, when, text, href) {
  if (seen.has(key)) return; seen.add(key);
  const row = el(href ? 'a' : 'div', { className: 'ev' }, el('span', { className: 'lbl', textContent: ago(when) }), el('span', { textContent: text }));
  if (href) row.href = href;
  row.dataset.at = new Date(when).getTime();
  const after = [...log.children].find((c) => Number(c.dataset.at) < Number(row.dataset.at));
  log.insertBefore(row, after || null);
  while (log.children.length > 40) log.lastChild.remove();
}
function pop(r, text) {
  r.hop = 1; r.lift = { t: 0 };
  const f = el('div', { className: 'float', textContent: text }); floats.append(f); r.float = { f, t: 0 };
}

let first = true;
async function load() {
  let d; try { const res = await fetch('/api/agents'); if (!res.ok) return; d = await res.json(); } catch { return; }
  const list = [...d.agents].sort((x, y) => Number(y.stats?.profit || 0) - Number(x.stats?.profit || 0) || x.id - y.id);
  const top = Math.max(0, ...list.map((a) => Number(a.stats?.profit || 0)));
  const before = new Map([...bots].map(([id, r]) => [id, r.a.runs || 0]));
  for (const id of [...bots.keys()]) if (!list.some((a) => a.id === id)) { const r = bots.get(id); scene.remove(r.g); r.tag.remove(); bots.delete(id); }
  list.forEach((a, i) => {
    let r = bots.get(a.id);
    if (!r) { r = makeBot(a); r.drop = first ? 1 + i * 0.12 : 1.4; if (!first) { r.isNew = true; note('new' + a.id, a.created_at, `${a.name} came off the line`, '/a/' + a.id); } }
    r.a = a; dress(r, i + 1, top);
    note('made' + a.id, a.created_at, `${a.name} came off the line`, '/a/' + a.id);
    if (!first && (a.runs || 0) > (before.get(a.id) ?? a.runs)) { pop(r, '+' + usd(a.price)); note('run' + a.id + ':' + a.runs, new Date().toISOString(), `${a.name} finished a job for ${usd(a.price)}`, '/a/' + a.id); }
  });
  order = list.map((a) => a.id); arrange();
  $('#r-agents').textContent = d.totals.agents; $('#r-runs').textContent = d.totals.runs; $('#r-income').textContent = usd(d.totals.income); $('#r-profit').textContent = usd(d.totals.profit);
  const lead = list.filter((a) => (a.runs || 0) > 0).slice(0, 3);
  $('#board').replaceChildren(...(lead.length ? lead.map((a, i) => el('a', { className: 'ev', href: '/a/' + a.id }, el('span', { className: 'lbl', textContent: '#' + (i + 1) }), el('span', { textContent: `${a.name} · ${usd(a.stats?.profit)}` }))) : [el('div', { className: 'ev' }, el('span', { textContent: 'No robot has been paid yet. Be the first to hire one.' }))]));
  const waiting = list.filter((a) => !(a.runs || 0)).length;
  $('#waiting').textContent = waiting ? `${waiting} ${waiting === 1 ? 'robot has' : 'robots have'} never been hired. Click one to give it its first job.` : 'Every robot on the floor has been hired at least once.';
  if (first) {
    // real past jobs, for the log
    for (const a of list.filter((x) => (x.runs || 0) > 0).slice(0, 6)) {
      fetch('/api/agents/' + a.id).then((r) => (r.ok ? r.json() : null)).then((x) => x && x.recent.forEach((run) => note('run' + run.id, run.created_at, `${a.name} finished a job for ${usd(run.paid)}`, '/api/runs/' + run.id))).catch(() => {});
    }
  }
  first = false;
}

// ---- pointer: drag to move, wheel to zoom, robots watch the pointer, click a robot to open it ----
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(9, 9), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), look = new THREE.Vector3(0, 0, 0);
let hover = null, down = null;
function pick() {
  ray.setFromCamera(ptr, camera);
  ray.ray.intersectPlane(ground, look);
  const hit = ray.intersectObjects([...bots.values()].flatMap((r) => [r.body, r.head.children[0]]), false)[0];
  const id = hit ? hit.object.userData.id : null;
  if (id !== hover) { if (hover != null && bots.get(hover)) bots.get(hover).tag.classList.remove('on'); hover = id; if (id != null) { bots.get(id).tag.classList.add('on'); bots.get(id).wave = 1; } canvas.style.cursor = id != null ? 'pointer' : grabbed ? 'grabbing' : 'grab'; }
}
canvas.addEventListener('pointermove', (e) => {
  const b = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  if (down) {
    const dx = e.clientX - down.x, dy = e.clientY - down.y; down.x = e.clientX; down.y = e.clientY; down.moved += Math.abs(dx) + Math.abs(dy);
    const k = (camera.top - camera.bottom) / b.height;
    const right = new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
    const fwd = new THREE.Vector3(right.z, 0, -right.x);
    target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * 1.5); touched = performance.now();
  } else pick();
});
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, moved: 0 }; grabbed = true; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
canvas.addEventListener('pointerup', (e) => { const was = down; down = null; grabbed = false; if (was && was.moved < 6) { pick(); if (hover != null) location.href = '/a/' + hover; } canvas.style.cursor = 'grab'; });
canvas.addEventListener('pointerleave', () => { ptr.set(9, 9); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.min(3.2, Math.max(0.55, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); touched = performance.now(); size(); }, { passive: false });

// ---- every frame ----
const v = new THREE.Vector3(), clock = new THREE.Clock();
function place(node, x, y, z) { v.set(x, y, z).project(camera); node.style.transform = `translate(-50%,-100%) translate(${((v.x + 1) / 2) * canvas.clientWidth}px,${canvas.offsetTop + ((1 - v.y) / 2) * canvas.clientHeight}px)`; }
function frame() {
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  // a slow drift until someone takes the camera
  const idle = !touched || performance.now() - touched > 9000;
  if (idle && !still) target.lerp(v.set(home.x + Math.sin(t * 0.12) * 1.6, 1, home.z + Math.cos(t * 0.1) * 1.2), 0.01);
  camera.position.copy(target).addScaledVector(DIR, 80); camera.lookAt(target);

  for (const r of bots.values()) {
    const p = r.g.position, ph = r.phase;
    // arrival: new robots drop onto the floor
    if (r.drop > 0) { r.drop = Math.max(0, r.drop - dt * 0.9); const k = Math.min(1, r.drop); r.bot.position.y = k * k * 9; r.bot.visible = r.drop < 1; } else r.bot.position.y = r.hop > 0 ? Math.abs(Math.sin(r.hop * Math.PI * 3)) * 0.55 * r.hop : 0;
    if (r.hop > 0) r.hop = Math.max(0, r.hop - dt * 0.8);
    // the belt
    if (r.busy) r.units.forEach((u, i) => { const x = ((t * r.speed + (i * BELT) / UNITS + ph) % BELT); u.position.x = -BELT + x + 0.1; u.scale.setScalar(x > BELT - 0.9 ? Math.max(0.05, (BELT - x) / 0.9) : x < 0.6 ? x / 0.6 : 1); });
    // arms: working robots hammer in time with their belt, waiting ones sway; a hovered robot waves
    const beat = r.busy ? Math.sin(t * r.speed * (Math.PI * 2 * UNITS / BELT) + ph * 2) : 0;
    r.arms[0].rotation.z = r.wave > 0 ? -2.4 + Math.sin(t * 12) * 0.5 : r.busy ? -0.9 + beat * 0.7 : Math.sin(t * 1.1 + ph) * 0.12;
    r.arms[1].rotation.z = r.busy ? -0.9 - beat * 0.7 : -Math.sin(t * 1.1 + ph) * 0.12;
    if (r.wave > 0) r.wave = hover === r.a.id ? 1 : Math.max(0, r.wave - dt * 1.2);
    // heads follow the pointer when it is near, otherwise they look around
    const dx = look.x - (p.x + 1.05), dz = look.z - p.z, near = ptr.x < 2 && dx * dx + dz * dz < 150;
    const want = near ? Math.atan2(-dz, -dx) : r.busy ? Math.sin(t * 0.9 + ph) * 0.25 : Math.sin(t * 0.5 + ph) * 0.9;
    r.head.rotation.y += (Math.max(-1.3, Math.min(1.3, want)) - r.head.rotation.y) * 0.12;
    r.head.position.y = 2.0 + (r.busy ? Math.abs(beat) * 0.04 : Math.sin(t * 1.6 + ph) * 0.03);
    // a finished paid job rises out of the tray
    if (r.lift) { r.lift.t += dt; const u = r.units[0]; u.visible = true; u.material.color.setHex(INK.w); u.position.set(2.9, 1.2 + r.lift.t * 2.4, 0); u.scale.setScalar(Math.max(0.05, 1 - r.lift.t / 1.6)); if (r.lift.t > 1.6) { r.lift = null; u.position.y = 1.28; } }
    place(r.tag, p.x + 1.05, 3.9 + r.bot.position.y, p.z);
    if (r.float) { r.float.t += dt; place(r.float.f, p.x + 2.9, 2.2 + r.float.t * 1.6, p.z); r.float.f.style.opacity = String(Math.max(0, 1 - r.float.t / 2.2)); if (r.float.t > 2.2) { r.float.f.remove(); r.float = null; } }
  }
  renderer.render(scene, camera);
  if (!still) requestAnimationFrame(frame);
}

await load();
size(); pick();
if (still) { for (const r of bots.values()) r.drop = 0; frame(); } else requestAnimationFrame(frame);
setInterval(() => { if (!document.hidden) load().then(() => still && frame()); }, 30000);
