// The answer renderer in public/zerolux.js: light Markdown becomes elements, and nothing an agent writes becomes HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerNodes } from '../public/zerolux.js';

// A stand-in for the browser's document: enough to see what was built.
const doc = { createElement: (tag) => ({ tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = String(v); }, append(...k) { this.kids.push(...k); } }) };
const show = (n) => typeof n === 'string' ? n : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.kids.map(show).join('')}</${n.tag}>`;
const draw = (text) => answerNodes(text, { doc, origin: 'https://zerolux.fun' }).map(show).join('');
const tags = (text) => { const out = []; const walk = (n) => { if (typeof n !== 'string') { out.push(n.tag); n.kids.forEach(walk); } }; answerNodes(text, { doc }).forEach(walk); return out; };

test('bold, italics and code are drawn, not shown as marks', () => {
  assert.equal(draw('This is **bold**, *soft* and `code`.'), '<p>This is <strong>bold</strong>, <em>soft</em> and <code>code</code>.</p>');
  assert.equal(draw('**Summary:** it works'), '<p><strong>Summary:</strong> it works</p>');
});
test('lists and headings', () => {
  assert.equal(draw('## Plan\n- one\n- **two**\n\n1. first\n2. second'), '<h3>Plan</h3><ul><li>one</li><li><strong>two</strong></li></ul><ol><li>first</li><li>second</li></ol>');
  assert.equal(draw('1. a\n\n2. b'), '<ol><li>a</li></ol><ol start="2"><li>b</li></ol>');
  assert.equal(draw('• dot one\n• dot two'), '<ul><li>dot one</li><li>dot two</li></ul>');
});
test('plain text stays as it was, line breaks kept', () => {
  assert.equal(draw('line one\nline two\n\nnext'), '<p>line one<br></br>line two</p><p>next</p>');
  assert.equal(draw('2 * 3 * 4 = 24 and a_b_c'), '<p>2 * 3 * 4 = 24 and a_b_c</p>');
  assert.equal(draw(''), ''); assert.equal(draw(null), '');
});
test('code blocks keep their text exactly', () => {
  assert.equal(draw('```\nconst a = **1**;\n<b>x</b>\n```\nafter'), '<pre><code>const a = **1**;\n<b>x</b></code></pre><p>after</p>');
});
test('links are http or https only', () => {
  assert.equal(draw('[site](https://example.com/a) and https://example.org/x.'), '<p><a href="https://example.com/a" target="_blank" rel="noopener nofollow">site</a> and <a href="https://example.org/x" target="_blank" rel="noopener nofollow">https://example.org/x</a>.</p>');
  assert.equal(draw('[bad](javascript:alert(1)) [worse](data:text/html,x)'), '<p>[bad](javascript:alert(1)) [worse](data:text/html,x)</p>');
});
test('HTML in an answer is only ever text', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> **<b>x</b>**';
  assert.deepEqual(tags(evil), ['p', 'strong']);
  assert.ok(draw(evil).includes('<img src=x onerror=alert(1)>')); // as a string inside a text node, never as an element
});
test('only pictures the agent made on Zero Lux are shown', () => {
  const id = 'a'.repeat(32);
  assert.equal(draw(`Here: https://zerolux.fun/api/images/${id}`), `<p>Here: <a class="pic" href="https://zerolux.fun/api/images/${id}" target="_blank" rel="noopener"><img src="https://zerolux.fun/api/images/${id}" alt="Picture made by this agent" loading="lazy"></img></a></p>`);
  assert.deepEqual(tags('![x](https://evil.example/p.png)').filter((t) => t === 'img'), []);
});

test('a code block that names a file type is also offered as that file', () => {
  const out = draw('```csv\nname,qty\n"a, b",2\n```');
  assert.ok(out.startsWith('<pre><code>name,qty\n"a, b",2</code></pre>'));
  assert.ok(out.includes('download="zerolux-1.csv"') && out.includes('href="data:text/csv;charset=utf-8,%EF%BB%BF' + encodeURIComponent('name,qty\n"a, b",2') + '"') && out.includes('Download as a .csv file'));
  assert.ok(draw('```json\n{}\n```\n```markdown\n# x\n```').includes('download="zerolux-2.md"'));
});
test('a block with no type, an unknown type or nothing in it gets no download', () => {
  for (const t of ['', 'constructor', 'exe', '__proto__']) assert.ok(!draw('```' + t + '\nx\n```').includes('download'));
  assert.ok(!draw('```csv\n\n```').includes('download'));
});
test('nothing that runs when opened is offered as a file', () => {
  for (const t of ['html', 'js', 'sh', 'py']) assert.ok(!draw('```' + t + '\n<script>alert(1)</script>\n```').includes('download'));
});
