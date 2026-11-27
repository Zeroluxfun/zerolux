// The verified-agent check (src/tap.js), against a stand-in registry. The signer here does what an agent's does:
// RFC 9421 over the profile Visa CLI's docs describe. Nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createVerifier, agentStatus, expirySeconds } from '../src/tap.js';

const ORIGIN = 'https://zerolux.fun';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const jkt = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x })).digest('base64url');
const keyId = randomUUID(), agentId = randomUUID();
const pemOf = (k) => Buffer.from(k.export({ type: 'spki', format: 'pem' })).toString('base64');
const listing = (over = {}, keyOver = {}) => ({
  id: agentId, name: 'fixture-agent', isActive: true, directoryOrigin: 'https://agenticdirectory.visa.com', ...over,
  keys: [{ id: keyId, agentId, keyName: jkt, status: 'active', algorithm: 'ed25519', publicKey: pemOf(publicKey), jkt, expirationDate: null, ...keyOver }],
});

function registry(mode = () => 'listed', doc = listing) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const id = decodeURIComponent(String(url).split('/').pop()), m = mode();
    if (m === 'down') return new Response('{}', { status: 503, headers: { 'retry-after': '7' } });
    if (m === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
    if (m === 'throw') throw new Error('network');
    if (m === 'junk') return new Response('not json', { status: 200 });
    if (m === 'paused' || (id !== keyId && id !== jkt && id !== agentId)) return new Response('{"code":"not_found"}', { status: 404 });
    return new Response(JSON.stringify(doc()), { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}
function nonces() { const seen = new Set(); return async (id) => (seen.has(id) ? false : (seen.add(id), true)); }

function signed(o = {}) {
  const { path = '/a/7/run', origin = ORIGIN, body = '{"input":"hello","ticket":"' + 'ab'.repeat(16) + '"}', id = keyId, label = 'sig2', signer = privateKey, created = Math.floor(Date.now() / 1000),
    lifetime = 60, nonce = randomBytes(32).toString('base64'), tag = 'agent-browser-auth', signatureAgent = '"https://agenticdirectory.visa.com"', alg = 'ed25519', extra = [] } = o;
  const url = new URL(origin + path);
  const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const app = [['accept', '*/*'], ['content-type', 'application/json'], ['signature-agent', signatureAgent], ...extra].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const values = [['@method', 'POST'], ['@scheme', 'https'], ['@authority', url.host], ['@path', url.pathname], ['@query', url.search || '?'], ['content-digest', digest], ...app];
  const params = `(${values.map(([n]) => `"${n}"`).join(' ')});created=${created};expires=${created + lifetime};keyid="${id}";alg="${alg}";nonce="${nonce}";tag="${tag}"`;
  const base = [...values.map(([n, v]) => `"${n}": ${v}`), `"@signature-params": ${params}`].join('\n');
  const signature = sign(null, Buffer.from(base), signer).toString('base64');
  return { path, body, headers: { ...Object.fromEntries(app), 'content-digest': digest, 'signature-input': `${label}=${params}`, signature: `${label}=:${signature}:` } };
}
const run = (verify, r, more = {}) => verify({ method: 'POST', publicOrigin: ORIGIN, target: r.path, headers: { ...r.headers, ...more }, rawBody: new TextEncoder().encode(r.body) });
const fresh = (mode, doc) => { const reg = registry(mode, doc); return { verify: createVerifier({ registryOrigin: 'https://registry.test', reserveNonce: nonces(), fetchImpl: reg.fetchImpl }), reg }; };
const says = (r) => (r.ok ? 'ok' : `${r.status} ${r.code} ${r.reason}`);

test('a correctly signed request passes, by directory id and by thumbprint', async () => {
  const { verify } = fresh();
  const a = await run(verify, signed());
  assert.equal(a.ok, true); assert.equal(a.agentId, agentId); assert.equal(a.keyId, keyId); assert.equal(a.jkt, jkt); assert.equal(a.agentName, 'fixture-agent');
  assert.equal(a.directoryOrigin, 'https://agenticdirectory.visa.com');
  assert.equal((await run(verify, signed({ id: jkt }))).ok, true);
  assert.equal((await run(verify, signed({ path: '/a/7/run?x=1' }))).ok, true);
});

test('anything changed after signing is refused', async () => {
  const { verify } = fresh();
  assert.equal(says(await run(verify, { ...signed(), body: '{"input":"other"}' })), '403 tap_signature_invalid body_digest_mismatch');
  assert.equal(says(await run(verify, { ...signed(), path: '/a/8/run' })), '403 tap_signature_invalid signature_mismatch');
  assert.equal(says(await run(verify, signed({ origin: 'https://other.example' }))), '403 tap_signature_invalid signature_mismatch');
  assert.equal(says(await run(verify, signed({ signer: stranger.privateKey }))), '403 tap_signature_invalid signature_mismatch');
  assert.equal(says(await run(verify, signed(), { 'x-task': '43' })), '403 tap_malformed uncovered_header');
  assert.equal(says(await run(verify, signed(), { 'content-type': 'text/plain' })), '403 tap_signature_invalid signature_mismatch');
});

test('the profile is enforced: label, tag, lifetime, clock, credentials, method, target', async () => {
  const { verify } = fresh();
  const t = Math.floor(Date.now() / 1000);
  assert.equal(says(await run(verify, signed({ label: 'sig1' }))), '403 tap_malformed signature_input_format');
  assert.equal(says(await run(verify, signed({ tag: 'agent-payer-auth' }))), '403 tap_malformed signature_input_format');
  assert.equal(says(await run(verify, signed({ created: t - 120 }))), '403 tap_expired expired');
  assert.equal(says(await run(verify, signed({ created: t + 300 }))), '403 tap_expired not_yet_valid');
  assert.equal(says(await run(verify, signed({ lifetime: 300 }))), '403 tap_expired lifetime_too_long');
  assert.equal(says(await run(verify, signed(), { authorization: 'Bearer x' })), '403 tap_malformed credential_header_present');
  assert.equal(says(await run(verify, signed(), { cookie: 'a=b' })), '403 tap_malformed credential_header_present');
  assert.equal(says(await run(verify, signed({ signatureAgent: '"https://other.example"' }))), '403 tap_signature_agent_not_accepted signature_agent_not_accepted');
  assert.equal(says(await run(verify, signed({ alg: 'ecdsa-p256-sha256' }))), '403 tap_signature_invalid algorithm_mismatch');
  const r = signed();
  assert.equal(says(await verify({ method: 'PUT', publicOrigin: ORIGIN, target: r.path, headers: r.headers, rawBody: new TextEncoder().encode(r.body) })), '403 tap_malformed method_not_allowed');
  for (const target of ['/a/8/../7/run', '/a/8/%2e%2e/7/run', '//a/7/run', '.attacker.example/a/7/run', '@attacker.example/a/7/run', '/a\\7\\run'])
    assert.equal(says(await verify({ method: 'POST', publicOrigin: ORIGIN, target, headers: r.headers, rawBody: new TextEncoder().encode(r.body) })), '403 tap_malformed request_target_invalid', target);
  assert.equal(says(await run(verify, { path: '/a/7/run', body: '{}', headers: {} })), '403 tap_missing no_signature_headers');
});

test('headers a proxy adds may be unsigned, and so may this site\'s credit code', async () => {
  const { verify } = fresh();
  assert.equal((await run(verify, signed(), { 'cf-ray': 'abc', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-proto': 'https', 'user-agent': 'x', 'accept-encoding': 'gzip', 'x-credits': 'c'.repeat(64) })).ok, true);
  // ...and it may be signed too, like any header the agent chooses.
  assert.equal((await run(verify, signed({ extra: [['x-credits', 'c'.repeat(64)]] }))).ok, true);
});

test('one signature is good once', async () => {
  const { verify } = fresh();
  const r = signed();
  assert.equal((await run(verify, r)).ok, true);
  assert.equal(says(await run(verify, r)), '403 tap_replayed nonce_reused');
});

test('a forged request does not use up the real one\'s nonce', async () => {
  const { verify } = fresh();
  const nonce = randomBytes(32).toString('base64');
  assert.equal((await run(verify, signed({ nonce, signer: stranger.privateKey }))).ok, false);
  assert.equal((await run(verify, signed({ nonce }))).ok, true);
});

test('a key the registry does not list is refused; a registry that cannot answer is "could not check"', async () => {
  let mode = 'listed';
  const { verify } = fresh(() => mode);
  assert.equal(says(await run(verify, signed({ id: randomUUID() }))), '403 tap_key_unknown key_not_listed');
  for (const m of ['down', 'redirect', 'throw']) { mode = m; const v = fresh(() => m).verify; const r = await run(v, signed()); assert.equal(says(r), '503 tap_trust_unavailable registry_unavailable', m); assert.equal(r.judged, false); }
  const d = await run(fresh(() => 'down').verify, signed()); assert.equal(d.retryAfterSeconds, 7);
  assert.equal(says(await run(fresh(() => 'junk').verify, signed())), '503 tap_trust_invalid listing_unusable');
  assert.equal(says(await run(fresh(() => 'paused').verify, signed())), '403 tap_key_unknown key_not_listed');
});

test('a listing is read strictly', async () => {
  const bad = (doc) => run(fresh(() => 'listed', doc).verify, signed());
  assert.equal(says(await bad(() => listing({ isActive: false }))), '403 tap_key_inactive agent_not_live');
  assert.equal(says(await bad(() => listing({ simulated: true }))), '403 tap_simulated_not_accepted simulated_listing');
  assert.equal(says(await bad(() => listing({}, { expirationDate: '2020-01-01T00:00:00Z' }))), '403 tap_key_inactive key_not_live');
  assert.equal(says(await bad(() => listing({}, { expirationDate: 'next year' }))), '503 tap_trust_invalid listing_unusable');
  assert.equal(says(await bad(() => listing({}, { status: 'revoked' }))), '503 tap_trust_invalid listing_unusable');
  assert.equal(says(await bad(() => listing({}, { algorithm: 'rsa' }))), '503 tap_trust_invalid listing_unusable');
  assert.equal(says(await bad(() => listing({}, { agentId: randomUUID() }))), '503 tap_trust_invalid listing_unusable');
  assert.equal(says(await bad(() => ({ hello: 'world' }))), '503 tap_trust_invalid listing_unusable');
  // A listing that pairs the key id with someone else's key: the thumbprint is computed here, never taken on its word.
  assert.equal(says(await bad(() => listing({}, { publicKey: pemOf(stranger.publicKey) }))), '403 tap_key_inactive key_not_live');
  assert.equal((await bad(() => listing({}, { expirationDate: '2999-01-01T00:00:00Z' }))).ok, true);
});

test('a good key is remembered for a minute, and a failed signature looks again before refusing', async () => {
  let t = 1_800_000_000;
  const reg = registry();
  const verify = createVerifier({ registryOrigin: 'https://registry.test', reserveNonce: nonces(), fetchImpl: reg.fetchImpl, now: () => t });
  assert.equal((await run(verify, signed({ created: t }))).ok, true);
  assert.equal((await run(verify, signed({ created: t }))).ok, true);
  assert.equal(reg.calls(), 1);
  assert.equal((await run(verify, signed({ created: t, signer: stranger.privateKey }))).ok, false);
  assert.equal(reg.calls(), 2);
  t += 61;
  assert.equal((await run(verify, signed({ created: t }))).ok, true);
  assert.equal(reg.calls(), 3);
});

test('a listing with no directory named is still a pass, and says so', async () => {
  const a = await run(fresh(() => 'listed', () => listing({ directoryOrigin: undefined })).verify, signed());
  assert.equal(a.ok, true); assert.equal(a.directoryOrigin, null);
});

test('whether an agent is still listed', async () => {
  assert.equal(await agentStatus('https://registry.test', agentId, registry().fetchImpl), 'listed');
  assert.equal(await agentStatus('https://registry.test', randomUUID(), registry().fetchImpl), 'not_listed');
  assert.equal(await agentStatus('https://registry.test', agentId, registry(() => 'down').fetchImpl), 'unavailable');
  assert.equal(await agentStatus('https://registry.test', agentId, registry(() => 'listed', () => listing({ isActive: false })).fetchImpl), 'not_listed');
});

test('dates', () => {
  assert.equal(expirySeconds('1970-01-01T00:00:00Z'), 0);
  assert.equal(expirySeconds('2027-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z') / 1000);
  assert.equal(expirySeconds('2027-01-01T02:00:00+02:00'), Date.parse('2027-01-01T00:00:00Z') / 1000);
  assert.equal(expirySeconds('2027-02-30T00:00:00Z'), null);
  assert.equal(expirySeconds('2027-01-01'), null);
});
