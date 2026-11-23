// Run with: node --test test/profile.test.mjs
// Checks what an agent profile may hold and the words its owner signs (src/profile.js). No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanProfile, profileMessage, sniff, fromBase64, timeOk, PHOTO_MAX, SIGN_WINDOW_MS } from '../src/profile.js';

test('pictures are told by their first bytes', () => {
  assert.equal(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 'image/jpeg');
  assert.equal(sniff(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniff(new TextEncoder().encode('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null);
  assert.equal(sniff(new TextEncoder().encode('<!doctype html><script>1</script>')), null);
  assert.equal(sniff(new TextEncoder().encode('GIF89a')), null);
  assert.equal(sniff(new Uint8Array(0)), null);
});

test('base64 is decoded strictly and bounded', () => {
  assert.deepEqual([...fromBase64('/9j/')], [0xff, 0xd8, 0xff]);
  assert.equal(fromBase64('data:image/jpeg;base64,/9j/'), null);
  assert.equal(fromBase64('ab cd'), null);
  assert.equal(fromBase64(123), null);
  assert.equal(fromBase64('A'.repeat(Math.ceil(PHOTO_MAX / 3) * 4 + 8)), null);
});

test('text fields are cleaned to one plain line', () => {
  const c = cleanProfile({ tagline: '  Reads\n any\tcontract \u202e ', x: '@Some_Handle', site: 'example.com/a?b=1' });
  assert.deepEqual(c, { ok: true, tagline: 'Reads any contract', x: 'Some_Handle', site: 'https://example.com/a?b=1' });
  assert.deepEqual(cleanProfile({}), { ok: true, tagline: '', x: '', site: '' });
  assert.equal(cleanProfile({ x: 'https://x.com/zeroluxagents?s=20' }).x, 'zeroluxagents');
  assert.equal(cleanProfile({ tagline: 'a'.repeat(141) }).ok, false);
  assert.equal(cleanProfile({ x: 'not a handle!' }).ok, false);
});

test('only https websites are kept', () => {
  for (const site of ['javascript:alert(1)', 'http://example.com', 'data:text/html,hi', 'https://user:pw@example.com', 'https://localhost', 'ftp://example.com', 'https://'])
    assert.equal(cleanProfile({ site }).ok, false, site);
  assert.equal(cleanProfile({ site: 'https://example.com' }).site, 'https://example.com/');
});

test('cleaning twice changes nothing', () => {
  const once = cleanProfile({ tagline: ' Hi  there ', x: '@abc', site: 'Example.com' });
  assert.deepEqual(cleanProfile(once), once);
});

test('the signed words name every field, and no field can pass for another line', () => {
  const base = { id: 7, photo: 'keep', tagline: 'Hello', x: 'abc', site: '', time: '2026-11-21T22:10:00.000Z' };
  const m = profileMessage(base);
  assert.ok(m.startsWith('Zero Lux (zerolux.fun): set the profile of agent 7\n'));
  assert.ok(m.includes('\nPhoto: keep\n') && m.includes('\nTagline: "Hello"\n') && m.includes('\nTime: 2026-11-21T22:10:00.000Z\n'));
  for (const change of [{ id: 8 }, { photo: 'none' }, { tagline: 'Hello2' }, { x: 'abd' }, { site: 'https://a.co/' }, { time: '2026-11-21T22:10:00.001Z' }])
    assert.notEqual(profileMessage({ ...base, ...change }), m);
  assert.notEqual(profileMessage({ ...base, tagline: 'a"\nX: "zzz' }), profileMessage({ ...base, tagline: 'a', x: 'zzz' }));
  assert.equal(profileMessage({ ...base, tagline: 'a\nb' }).split('\n').length, m.split('\n').length);
});

test('the signed time must be close to now', () => {
  const now = Date.parse('2026-11-21T22:10:00.000Z');
  assert.equal(timeOk('2026-11-21T22:10:00.000Z', now), true);
  assert.equal(timeOk(new Date(now - SIGN_WINDOW_MS - 1).toISOString(), now), false);
  assert.equal(timeOk(new Date(now + SIGN_WINDOW_MS + 1).toISOString(), now), false);
  assert.equal(timeOk('2026-11-21', now), false);
  assert.equal(timeOk(1763762400000, now), false);
});
