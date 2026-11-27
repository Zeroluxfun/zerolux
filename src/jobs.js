// Long jobs: work too big for one answer.
//
// An ordinary run is one request and one answer inside about a hundred seconds. A long job is the same agent run several
// times in a row on one piece of work: each step does one part with the agent's tools and leaves notes, the next step
// reads the notes and carries on, and the last step writes the finished result. Each step is an ordinary paid run,
// paid from the customer's Zero Lux credit (src/credits.js) at the agent's price, with its own public receipt, so the
// agent, its books and its owner cannot tell it from any other run. The customer says the most runs the job may use
// and pays only for the steps that deliver.
//
// Nobody has to keep a page open. One Durable Object per job (JobRunner) wakes itself with an alarm, does the next
// step, and sets the alarm again until the job is over. The timer in worker.js wakes any job that has gone quiet.
//
//   POST /api/jobs       x-credits, {"agent", "goal", "max_steps"}    -> the job, with the id its page lives at
//   GET  /api/jobs       x-credits                                    -> the account's jobs
//   GET  /api/jobs/:id                                                -> the job and its steps (the id is the secret)
//   POST /api/jobs/:id   x-credits, {"action": "cancel"|"resume"}
import { verifiedOnly } from './tap-api.js';
import { DurableObject } from 'cloudflare:workers';
import { json, allow, clientKey, readJson } from './line.js';
import { cardOn, spendRun, afterCard, balanceOf, sha, isAccount } from './credits.js';
import { hire } from './run.js';
import { findAgent } from './api.js';
import { withReview } from './reviews.js';
import { keepFiles } from './files.js';
import { deliver } from './deliver.js';

export const JOB_STEPS = [3, 4, 6]; // the most runs a job may use, as offered on the page
const MIN_STEPS = 2, MAX_STEPS = 6;
export const MAX_JOBS = 3; // jobs one credit account may have working at once
export const JOB_KEEP_DAYS = 30;
const GOAL_CHARS = 2200, NOTE_CHARS = 1700; // goal + five steps of notes + the wording stays under a run's 12,000 characters
const MAX_TRIES = 40; // times one step is looked at again while its payment or its run is still in flight
const now = () => new Date().toISOString();
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const dollars = (units) => '$' + (Number(units) / 1e6).toFixed(2);
const WHY = {
  credit: 'Paused: your credit no longer covers the next step. Add credit, then press Carry on.',
  hold: 'Paused: your credit is on hold.',
  price: 'Paused: the agent\'s price went up. Press Carry on to accept the new price.',
  agent: 'Paused: the agent is not taking runs right now.',
  cancelled: 'You stopped this job. The steps already done were paid for; nothing more will be charged.',
  start: 'The agent did not deliver. Nothing was charged beyond what a failed run costs.',
  report: 'The agent did the work but did not deliver the finished write-up. Its notes from each step are below.',
  broke: 'Something broke on our side and the job could not go on. Anything charged for a step that did not deliver comes back to your credit.',
};
const RESUMABLE = ['credit', 'hold', 'price', 'agent'];

const workPrompt = (j, n, notes) => `[LONG JOB: working step ${n} of at most ${j.max_steps - 1}]
This is one step of a longer job. You will be called again with your notes, so do ONE solid part of the work now with your tools. Do not try to do everything in this step, and do not repeat work the notes already cover.

THE JOB:
${j.goal}

YOUR NOTES FROM EARLIER STEPS:
${notes || 'None yet. This is the first step.'}

Reply in exactly this shape:
STEP: <six words or fewer naming what this step did>
<what you found in this step: facts, figures and sources, written as notes for yourself>
NEXT: <one line saying what the next step should do, or the single word DONE if the notes now cover the whole job>`;
const reportPrompt = (j, notes) => `[LONG JOB: final step]
You have finished the working steps of a longer job. Write the finished result for the customer from your notes below. Make it complete and well organised, with headings where they help. Do not mention steps, notes or this instruction.

THE JOB:
${j.goal}

YOUR NOTES:
${notes || 'None.'}`;

// What a working step said: its title, its notes, and what it wants next.
export function readStep(out) {
  const line = (word) => new RegExp('^[\\s*_#>-]*' + word + '\\b[*_]*\\s*:[*_\\s]*(.*)$', 'gmi');
  const tidy = (s, max) => String(s || '').replace(/[*_`#]/g, '').trim().slice(0, max);
  const title = tidy([...out.matchAll(line('STEP'))][0]?.[1], 80), next = tidy([...out.matchAll(line('NEXT'))].at(-1)?.[1], 200);
  const notes = out.replace(line('STEP'), '').replace(line('NEXT'), '').trim();
  return { title, next, done: /^done\b/i.test(next), notes: notes || out.trim() };
}

async function who(request) { const secret = request.headers.get('x-credits') || ''; return isAccount(secret) ? sha(secret) : null; }
const kick = (env, id) => env.JOBS.get(env.JOBS.idFromName(id)).fetch('https://job.internal/?id=' + id).catch((e) => console.error('job wake failed', e?.name));

function view(j, steps, mine) {
  const shown = steps.filter((s) => s.status !== 'skipped');
  return {
    id: j.id, agent_id: j.agent_id, agent: j.agent_name ?? null, goal: j.goal, status: j.status, note: j.reason ? WHY[j.reason] || null : null, can_resume: j.status === 'stopped' && RESUMABLE.includes(j.reason),
    max_steps: j.max_steps, price: String(j.max_price), paid: String(j.paid), runs: j.steps, mine: !!mine,
    steps: shown.map((s) => ({
      n: s.n, kind: s.kind, status: s.status === 'pending' ? 'working' : s.status,
      title: s.status === 'pending' ? (s.kind === 'report' ? 'Writing the result' : j.next || (s.n === 1 ? 'Starting the work' : 'Working')) : s.title || (s.kind === 'report' ? 'Wrote the result' : 'Step ' + s.n),
      notes: s.kind === 'work' && s.status === 'done' ? s.output : null, error: s.status === 'failed' ? s.error || 'This step did not deliver.' : null,
      paid: s.paid == null ? null : String(s.paid), run: s.run_id, at: s.finished_at || s.created_at,
    })),
    report: j.report, run: j.run_id, review: mine && j.review && !j.reviewed ? { token: j.review } : null,
    created_at: j.created_at, finished_at: j.finished_at,
  };
}
const stepsOf = async (env, id) => (await env.DB.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq').bind(id).all()).results;
const jobRow = (env, id) => env.DB.prepare('SELECT j.*, a.name AS agent_name, (SELECT 1 FROM reviews v WHERE v.run_id = j.run_id) AS reviewed FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = ?').bind(id).first();

export async function createJob(request, env) {
  if (!cardOn(env)) return json({ error: 'Long jobs are paid from card credit, and card payment is not switched on.' }, 503);
  if (!env.JOBS) return json({ error: 'Long jobs are not switched on.' }, 503);
  const account = await who(request), body = await readJson(request);
  if (!account || !body) return json({ error: 'Send JSON with your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'jobnew:' + clientKey(request), 20))) return json({ error: 'That is enough new long jobs for today.' }, 429);
  const goal = String(body.goal ?? body.input ?? '').trim().slice(0, GOAL_CHARS), max = Number(body.max_steps ?? 4);
  if (!goal) return json({ error: 'Write what the job is.' }, 400);
  if (!Number.isInteger(max) || max < MIN_STEPS || max > MAX_STEPS) return json({ error: `max_steps is a whole number from ${MIN_STEPS} to ${MAX_STEPS}.` }, 400);
  const a = await findAgent(env, String(body.agent));
  if (!a || a.status !== 'live') return json({ error: 'That agent is not taking runs.' }, 409);
  if (await verifiedOnly(env, a.id)) return json({ error: 'That agent takes work only from verified agents, one signed request at a time.' }, 409);
  if ((await balanceOf(env, account)) < Number(a.price)) return json({ error: `Your credit does not cover one step (${dollars(a.price)}). Add credit by card first.`, topup: true }, 402);
  const id = hexOf(crypto.getRandomValues(new Uint8Array(16))), t = now();
  const made = await env.DB.prepare(
    `INSERT INTO jobs (id, account, agent_id, goal, max_steps, max_price, status, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'working', ?7, ?7 WHERE (SELECT COUNT(*) FROM jobs WHERE account = ?2 AND status = 'working') < ?8`,
  ).bind(id, account, a.id, goal, max, Number(a.price), t, MAX_JOBS).run();
  if (!made.meta.changes) return json({ error: `An account can have ${MAX_JOBS} long jobs working at once. Wait for one to finish, or stop one.` }, 400);
  await keepFiles(env, goal, JOB_KEEP_DAYS);
  await kick(env, id);
  return json({ ok: true, job: view(await jobRow(env, id), [], true) });
}

export async function listJobs(request, env) {
  const account = await who(request); if (!account) return json({ error: 'Send your credit code in x-credits.' }, 400);
  if (!(await allow(env, 'joblist:' + clientKey(request), 3000))) return json({ error: 'Too many requests.' }, 429);
  const rows = (await env.DB.prepare('SELECT j.id, j.agent_id, a.name AS agent, j.goal, j.status, j.reason, j.steps, j.max_steps, j.paid, j.created_at, j.finished_at FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.account = ? ORDER BY j.created_at DESC LIMIT 30').bind(account).all()).results;
  return json({ jobs: rows.map((j) => ({ id: j.id, agent_id: j.agent_id, agent: j.agent, goal: j.goal, status: j.status, note: j.reason ? WHY[j.reason] || null : null, runs: j.steps, max_steps: j.max_steps, paid: String(j.paid), created_at: j.created_at, finished_at: j.finished_at })), keep_days: JOB_KEEP_DAYS });
}

export async function getJob(request, env, id) {
  if (!(await allow(env, 'jobget:' + clientKey(request), 8000))) return json({ error: 'Too many requests.' }, 429);
  const j = await jobRow(env, id); if (!j) return json({ error: 'No long job with that id.' }, 404);
  return json({ job: view(j, await stepsOf(env, id), (await who(request)) === j.account) }, 200, { 'cache-control': 'no-store' });
}

export async function changeJob(request, env, id) {
  const account = await who(request), body = await readJson(request);
  if (!account || !body) return json({ error: 'Send JSON with your credit code in x-credits.' }, 400);
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id = ? AND account = ?').bind(id, account).first();
  if (!j) return json({ error: 'No long job with that id under this credit code.' }, 404);
  if (body.action === 'cancel') {
    if (j.status !== 'working' && j.status !== 'stopped') return json({ error: 'This job is already over.' }, 409);
    await env.DB.prepare("UPDATE jobs SET status = 'stopped', reason = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('working', 'stopped')").bind(now(), now(), id).run();
    await kick(env, id); // a step already paid for is seen through and kept
  } else if (body.action === 'resume') {
    if (j.status !== 'stopped' || !RESUMABLE.includes(j.reason)) return json({ error: 'This job cannot be carried on.' }, 409);
    const a = await findAgent(env, String(j.agent_id));
    if (!a || a.status !== 'live') return json({ error: 'That agent is not taking runs.' }, 409);
    if ((await balanceOf(env, account)) < Number(a.price)) return json({ error: `Your credit does not cover one step (${dollars(a.price)}). Add credit by card first.`, topup: true }, 402);
    const on = await env.DB.prepare(`UPDATE jobs SET status = 'working', reason = NULL, finished_at = NULL, max_price = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'stopped' AND (SELECT COUNT(*) FROM jobs WHERE account = ?4 AND status = 'working') < ?5`).bind(Number(a.price), now(), id, account, MAX_JOBS).run();
    if (!on.meta.changes) return json({ error: `An account can have ${MAX_JOBS} long jobs working at once.` }, 400);
    await kick(env, id);
  } else return json({ error: 'action is cancel or resume.' }, 400);
  return json({ ok: true, job: view(await jobRow(env, id), await stepsOf(env, id), true) });
}

// ---- the runner ----
// A job that ends by itself (paused for its customer, or failed) tells them, since they are probably not watching.
async function end(env, id, status, reason) {
  const done = await env.DB.prepare("UPDATE jobs SET status = ?, reason = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'working'").bind(status, reason, now(), now(), id).run();
  if (!done.meta.changes) return done;
  const j = await env.DB.prepare('SELECT j.account, a.name FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = ?').bind(id).first();
  if (j) await deliver(env, j.account, { title: `${j.name}: long job ${status === 'failed' ? 'did not finish' : 'paused'}`, body: WHY[reason] || 'It stopped.', link: 'https://zerolux.fun/job?id=' + id });
  return done;
}

// The next step this job owes, written once. Null when the job is over.
async function openStep(env, j) {
  const rows = (await env.DB.prepare('SELECT seq, n, round, kind, status, output FROM job_steps WHERE job_id = ? ORDER BY seq').bind(j.id).all()).results;
  const settled = rows.filter((r) => r.status === 'done' || r.status === 'failed'), done = settled.filter((r) => r.status === 'done'), last = settled.at(-1);
  let kind, round = 0;
  if (last?.status === 'failed' && last.round < 1) { kind = last.kind; round = last.round + 1; } // a step that did not deliver gets one more try
  else if (last?.status === 'failed') {
    if (last.kind === 'work' && done.length) kind = 'report'; // it cannot go further: write up what it has
    else { await end(env, j.id, 'failed', done.length ? 'report' : 'start'); return null; }
  } else kind = j.wrap || done.length >= j.max_steps - 1 ? 'report' : 'work';
  const seq = rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1, n = done.length + 1, id = j.id + ':' + seq;
  const notes = done.filter((r) => r.kind === 'work').map((r, i) => `Step ${i + 1}: ${String(r.output || '').slice(0, NOTE_CHARS)}`).join('\n\n');
  const input = kind === 'work' ? workPrompt(j, n, notes) : reportPrompt(j, notes);
  const ticket = hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zerolux long job|' + id))).slice(0, 32);
  await env.DB.prepare("INSERT OR IGNORE INTO job_steps (id, job_id, seq, n, round, kind, ticket, input, status, tries, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)").bind(id, j.id, seq, n, round, kind, ticket, input, now()).run();
  return env.DB.prepare('SELECT * FROM job_steps WHERE id = ?').bind(id).first();
}

// One look at one job: does its next step, or sees the step in flight a little further. Answers how many milliseconds
// until it should be looked at again, or 0 when there is nothing more to do.
export async function stepJob(env, ctx, id) {
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!j) return 0;
  let s = await env.DB.prepare("SELECT * FROM job_steps WHERE job_id = ? AND status = 'pending' ORDER BY seq LIMIT 1").bind(id).first();
  // Once a step is paid for it is seen through, even if the job has been stopped since.
  const begun = s ? await env.DB.prepare('SELECT 1 FROM credit_events WHERE account = ? AND instr(meta, ?) > 0').bind(j.account, `"slot":"${s.id}"`).first() : null;
  if (j.status !== 'working') {
    if (!s || !begun) { if (s) await env.DB.prepare("UPDATE job_steps SET status = 'skipped', finished_at = ? WHERE id = ? AND status = 'pending'").bind(now(), s.id).run(); return 0; }
  } else if (!s) { s = await openStep(env, j); if (!s) return 0; }
  await env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(now(), id).run();

  const fail = async (error) => { await env.DB.prepare("UPDATE job_steps SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(String(error).slice(0, 400), now(), s.id).run(); return 500; };
  // The job waits for its customer: nothing was charged for this step, and it is not counted as a failure.
  const halt = async (reason) => { await env.DB.prepare("UPDATE job_steps SET status = 'skipped', finished_at = ? WHERE id = ? AND status = 'pending'").bind(now(), s.id).run(); await end(env, id, 'stopped', reason); return 0; };
  const later = async () => { const t = await env.DB.prepare('UPDATE job_steps SET tries = tries + 1 WHERE id = ? RETURNING tries').bind(s.id).first(); if (t && t.tries >= MAX_TRIES) return fail('The step did not finish. Anything charged for it comes back to your credit.'); return t && t.tries > 12 ? 30_000 : 6_000; };

  const agent = await findAgent(env, String(j.agent_id));
  if (!begun) {
    if (!agent || agent.status !== 'live') return halt('agent');
    if (Number(agent.price) > j.max_price) return halt('price');
  }
  if (!agent) return fail(WHY.agent);
  // The request the run path reads, made here rather than sent over the network. Its limits are counted per credit account.
  const request = new Request(`https://zerolux.fun/a/${agent.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': 'job-' + j.account.slice(0, 20) }, body: JSON.stringify({ input: s.input }) });
  let res;
  try {
    const paid = await spendRun(request, env, agent, s.input, {
      account: j.account, seed: `job|${j.account}|${agent.id}|${s.ticket}`, meta: { job: id, slot: s.id }, admit: async () => null,
      held: () => json({ stop: 'hold' }, 403), poor: async () => json({ stop: 'credit' }, 402),
    });
    if (paid.reply) {
      const why = await paid.reply.json().catch(() => ({}));
      return why.stop ? halt(why.stop) : later();
    }
    res = await withReview(env, await hire(request, env, ctx, agent, { pay: paid.pay }));
    await afterCard(env, request);
  } catch (e) { console.error('long job step threw', e?.name, String(e?.message || '').slice(0, 200)); return later(); }
  const out = await res.json().catch(() => ({}));
  if (!(res.ok && typeof out.output === 'string')) return out.again ? later() : fail(out.error || 'The step did not deliver.');

  const paid = Number(out.paid) || 0, t = now();
  if (s.kind === 'work') {
    const got = readStep(out.output);
    await env.DB.prepare("UPDATE job_steps SET status = 'done', title = ?, output = ?, paid = ?, run_id = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(got.title || null, got.notes.slice(0, 6000), paid, out.run || null, t, s.id).run();
    await env.DB.prepare('UPDATE jobs SET steps = steps + 1, paid = paid + ?, next = ?, wrap = ?, updated_at = ? WHERE id = ?').bind(paid, got.done ? null : got.next || null, got.done ? 1 : 0, t, id).run();
    return j.status === 'working' ? 500 : 0;
  }
  await env.DB.prepare("UPDATE job_steps SET status = 'done', output = ?, paid = ?, run_id = ?, finished_at = ? WHERE id = ? AND status = 'pending'").bind(out.output, paid, out.run || null, t, s.id).run();
  // The result is the job's, whether or not it was stopped while this last step was in flight.
  await env.DB.prepare("UPDATE jobs SET status = 'done', reason = NULL, steps = steps + 1, paid = paid + ?, report = ?, run_id = ?, review = ?, next = NULL, updated_at = ?, finished_at = ? WHERE id = ?").bind(paid, out.output, out.run || null, out.review?.token || null, t, t, id).run();
  // It also goes to the inbox, beside what standing orders deliver.
  const total = await env.DB.prepare('SELECT steps, paid FROM jobs WHERE id = ?').bind(id).first();
  await env.DB.prepare("INSERT OR IGNORE INTO deliveries (id, sub_id, account, agent_id, run_id, ticket, input, note, status, output, paid, review, tries, sent, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, 0, 0, ?, ?)")
    .bind('job:' + id, 'job:' + id, j.account, j.agent_id, out.run || null, s.ticket, j.goal, `Long job, ${total.steps} runs`, out.output, total.paid, out.review?.token || null, t, t).run();
  const sent = await deliver(env, j.account, { title: `${agent.name}: long job finished`, body: out.output, link: 'https://zerolux.fun/job?id=' + id });
  if (sent.webhook || sent.telegram) await env.DB.prepare('UPDATE deliveries SET sent = 1 WHERE id = ?').bind('job:' + id).run();
  return 0;
}

// One per job. It holds nothing but the job's id and an alarm; everything else is in the database.
export class JobRunner extends DurableObject {
  async fetch(request) {
    const id = new URL(request.url).searchParams.get('id');
    if (!/^[0-9a-f]{32}$/.test(id || '')) return new Response('bad id', { status: 400 });
    await this.ctx.storage.put('id', id);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 50);
    return new Response('ok');
  }
  async alarm() {
    const id = await this.ctx.storage.get('id'); if (!id) return;
    let wait = 0;
    try { wait = await stepJob(this.env, this.ctx, id); await this.ctx.storage.delete('errs'); }
    catch (e) {
      console.error('long job failed', e?.name, String(e?.message || '').slice(0, 200));
      const errs = ((await this.ctx.storage.get('errs')) || 0) + 1; await this.ctx.storage.put('errs', errs);
      if (errs >= 20) await end(this.env, id, 'failed', 'broke').catch(() => {}); else wait = 15_000;
    }
    if (wait > 0) await this.ctx.storage.setAlarm(Date.now() + wait); // otherwise it sleeps until it is woken again
  }
}

// From the timer: wakes jobs that have gone quiet (their alarm was lost), and deletes old ones.
export async function jobsTick(env) {
  if (!env.JOBS) return;
  const quiet = (await env.DB.prepare("SELECT id FROM jobs WHERE status = 'working' AND updated_at < ? ORDER BY updated_at LIMIT 20").bind(new Date(Date.now() - 4 * 60_000).toISOString()).all()).results;
  for (const j of quiet) await kick(env, j.id);
  const old = new Date(Date.now() - JOB_KEEP_DAYS * 86_400_000).toISOString();
  await env.DB.prepare('DELETE FROM job_steps WHERE job_id IN (SELECT id FROM jobs WHERE created_at < ?)').bind(old).run();
  await env.DB.prepare('DELETE FROM jobs WHERE created_at < ?').bind(old).run();
}
