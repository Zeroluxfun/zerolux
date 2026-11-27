import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, findTemplate, fromText, readFrom, copyMessage } from '../src/templates.js';

const TOOLS = ['web_search', 'fetch_url', 'market_data', 'read_chain', 'make_image', 'calculate', 'remember'];
const MODELS = ['fast', 'smart', 'grok', 'gemini', 'opus', 'gpt', 'fable'];

test('every template is a whole agent inside the bounds a spec allows', () => {
  assert.equal(new Set(TEMPLATES.map((t) => t.key)).size, TEMPLATES.length);
  for (const t of TEMPLATES) {
    assert.match(t.key, /^[a-z0-9-]{3,40}$/);
    assert.ok(t.name.length >= 3 && t.name.length <= 40, t.key);
    assert.ok(t.tagline.length >= 20 && t.tagline.length <= 110, t.key);
    assert.ok(t.job.length >= 12 && t.job.length <= 1200, t.key);
    assert.ok(t.instructions.length >= 600 && t.instructions.length <= 4000, t.key);
    assert.ok(t.input_hint.length <= 140 && t.example.length <= 200, t.key);
    assert.ok(MODELS.includes(t.model), t.key);
    assert.ok(t.tools.length && t.tools.every((x) => TOOLS.includes(x)), t.key);
    assert.ok(t.price_usd >= 0.05 && t.price_usd <= 2, t.key);
    assert.ok(['order', 'job', 'files', 'run'].includes(t.best), t.key);
    // each tool the agent is given is named in its instructions, so it knows when to use it
    for (const x of t.tools) assert.ok(t.instructions.includes(x), `${t.key} never mentions ${x}`);
    assert.ok(t.instructions.includes('Finish the job in one reply'), t.key);
    assert.ok(!/—/.test(JSON.stringify(t)), t.key);
  }
});

test('where a spec came from reads back, and nothing else does', () => {
  assert.deepEqual(readFrom(fromText('template', 'briefing')), { template: 'briefing', name: 'Morning Briefing' });
  assert.deepEqual(readFrom(fromText('agent', 12)), { agent: 12 });
  assert.deepEqual(readFrom('template:gone-one'), { template: 'gone-one', name: null });
  for (const bad of [null, '', 'agent:x', 'agent:', 'template:', 'other:1', 'agent:1\nx', 'template:Briefing']) assert.equal(readFrom(bad), null);
  assert.equal(findTemplate('nope'), null);
  assert.equal(findTemplate('briefing').name, 'Morning Briefing');
});

test('the words an owner signs say which agent, yes or no, and when', () => {
  const m = copyMessage({ id: 7, allow: false, time: '2026-11-25T00:00:00.000Z' });
  assert.ok(m.includes('agent 7') && m.includes(': no') && m.includes('2026-11-25T00:00:00.000Z') && m.includes('moves no money'));
  assert.notEqual(m, copyMessage({ id: 7, allow: true, time: '2026-11-25T00:00:00.000Z' }));
});
