// Verified agents: checking a request an agent signed with the Trusted Agent Protocol (TAP), in Visa CLI's profile.
//
// An agent whose owner passed Visa CLI's card step holds a signing key, and that key is listed in Visa CLI's registry.
// The agent signs one HTTP request (RFC 9421: Signature-Input, Signature and Content-Digest headers). Anyone can check
// it with one public lookup of the key, GET {registry}/v1/tap/registry/keys/{keyid}. No account and no API key.
//
// What a pass says: a listed, active agent's key signed this exact request (method, host, path, query, body and the
// headers it chose). So a person who passed a card check stands behind the agent. It does not say who that is, and it
// says nothing about how good the agent's work is.
//
// This file follows Visa CLI's example verifier (the "Verifier code" page of its docs), check for check and in the same
// order, written for a Worker: Web Crypto, and no Node modules. It reads Visa CLI's registry only, and Ed25519 keys only.
// It never throws: a request it cannot read is refused, and a registry it cannot reach is "could not check" (503), which
// is never the same thing as a refusal.

export const REGISTRY = 'https://auth.visacli.sh';
export const DIRECTORY = 'https://agenticdirectory.visa.com'; // where a production key is listed; anything else is a test listing

const REASONS = {
  no_signature_headers: ['tap_missing', 'The request has no Signature-Input and Signature headers.'],
  signature_input_format: ['tap_malformed', 'Signature-Input must be label sig2, then the covered components, created, expires, keyid, alg, nonce and tag="agent-browser-auth", in that order. The nonce is 32 bytes of base64.'],
  signature_header_format: ['tap_malformed', 'Signature must be sig2=:<base64>:.'],
  components_invalid: ['tap_malformed', 'The covered components are unreadable or repeated.'],
  directory_components_missing: ['tap_malformed', 'A key named by directory ID must also cover @query, accept and content-type when sent.'],
  required_components_missing: ['tap_malformed', 'The signature must cover @method, @scheme, @authority, @path, @query and content-digest first, in that order.'],
  credential_header_present: ['tap_malformed', 'Authorization and Cookie are refused on a signed request. Remove them.'],
  method_not_allowed: ['tap_malformed', 'Only GET, HEAD and POST can be signed.'],
  signed_header_invalid: ['tap_malformed', 'A covered header is out of order, absent, starts or ends with a space, is not printable ASCII, is over 4096 characters, or is one this profile never signs.'],
  uncovered_header: ['tap_malformed', 'The request carries a header the signature does not cover. Only transport headers, x-credits and x-payment may go unsigned.'],
  nonce_format: ['tap_malformed', 'The nonce must be exactly 32 bytes of canonical base64.'],
  body_too_large: ['tap_malformed', 'The body is over 1 MiB.'],
  digest_format: ['tap_malformed', 'Content-Digest must be sha-256=:<base64>:.'],
  not_yet_valid: ['tap_expired', 'The signature was created in the future. Check the clock.'],
  expired: ['tap_expired', 'The signature has expired. Sign a new request.'],
  lifetime_too_long: ['tap_expired', 'The signature lives longer than 60 seconds.'],
  nonce_reused: ['tap_replayed', 'This key and nonce were already used for another request. Sign a new request.'],
  key_not_listed: ['tap_key_unknown', 'This key has no live listing. It may be unknown, paused or revoked; the registry does not say which.'],
  agent_not_live: ['tap_key_inactive', 'The registry reports this agent as not live.'],
  key_not_live: ['tap_key_inactive', "This key is not one of the agent's live keys: it was replaced, or its expirationDate has passed."],
  body_digest_mismatch: ['tap_signature_invalid', 'The body does not match the signed Content-Digest.'],
  signature_mismatch: ['tap_signature_invalid', 'The signature does not verify for this exact request. Sign for https://zerolux.fun and the exact path.'],
  algorithm_mismatch: ['tap_signature_invalid', "The signature's alg is not the algorithm of the listed key."],
  signature_agent_not_accepted: ['tap_signature_agent_not_accepted', 'Signature-Agent is not one this site accepts.'],
  simulated_listing: ['tap_simulated_not_accepted', 'This key belongs to a simulated test listing, which is not accepted.'],
  listing_unusable: ['tap_trust_invalid', 'The registry returned an unusable answer. The agent has not been judged.'],
  registry_unavailable: ['tap_trust_unavailable', 'The registry could not be reached. The agent has not been judged; try again later.'],
  nonce_store_unavailable: ['tap_trust_unavailable', 'The check could not be completed. The agent has not been judged; try again later.'],
  request_target_invalid: ['tap_malformed', 'The request target is not in normal form.'],
  request_unreadable: ['tap_malformed', 'The request could not be read.'],
};
const COULD_NOT_CHECK = new Set(['tap_trust_invalid', 'tap_trust_unavailable']);
function refusal(reason, retryAfterSeconds = null, header = null) {
  const [code, message] = REASONS[reason];
  const judged = !COULD_NOT_CHECK.has(code);
  return { ok: false, code, reason, message: header ? `${message} Header: ${header}.` : message, judged, status: judged ? 403 : 503, retryAfterSeconds, ...(header ? { header } : {}) };
}

const INPUT = /^sig2=\(([^)]+)\);created=(\d+);expires=(\d+);keyid="([A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";alg="(ed25519|Ed25519|ecdsa-p256-sha256)";nonce="([A-Za-z0-9+/]{43}=)";tag="agent-browser-auth"$/;
const SIGNATURE = /^sig2=:((?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=):$/;
const CORE = ['@method', '@scheme', '@authority', '@path', '@query', 'content-digest'];
// Headers that may arrive unsigned: what clients, proxies and Cloudflare add on the way. Every other header has to be signed.
export const TRANSPORT_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'accept', 'accept-language', 'accept-encoding', 'user-agent',
  'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-ssl', 'x-real-ip',
  'true-client-ip', 'cdn-loop', 'traceparent', 'tracestate', 'x-request-id', 'x-amzn-trace-id', 'x-cloud-trace-context',
  'b3', 'x-b3-traceid', 'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled',
  'cf-ray', 'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-pseudo-ipv4', 'cf-connecting-o2o', 'cf-ew-via', 'cf-worker', 'cf-visitor',
  'cf-ipcountry', 'cf-ipcity', 'cf-ipcontinent', 'cf-iplatitude', 'cf-iplongitude', 'cf-region', 'cf-region-code', 'cf-metro-code',
  'cf-postal-code', 'cf-timezone',
  'signature', 'signature-input', 'content-digest',
  // This site's own way of paying from card credit. It is the caller's login here, so it travels beside the signature.
  'x-credits',
]);
const CREDENTIALS = ['authorization', 'cookie'];
const NEVER_SIGNED = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'keep-alive', 'expect', 'via', 'forwarded', 'origin', 'referer', 'content-digest', 'signature', 'signature-input',
  'agent-payer-auth', 'payment', 'payment-signature', 'payment-required', 'payment-receipt', 'payment-response',
]);
const NEVER_SIGNED_PREFIX = /^(?:proxy-|sec-|x-forwarded-|x-visa(?:$|-)|x-stamp(?:$|-)|x-payment(?:$|-))/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/;
const DIGEST = /^sha-256=:[A-Za-z0-9+/]+={0,2}:$/;
const SIGNATURE_AGENTS = ['"https://sbx.agenticdirectory.visa.com"', '"https://agenticdirectory.visa.com"'];
const MAX_LIFETIME_SECONDS = 60, CLOCK_SKEW_SECONDS = 30;
export const MAX_BODY_BYTES = 1024 * 1024;

const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

const EXPIRY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;
// An RFC 3339 date-time with a zone, as seconds, or null if it is not one.
export function expirySeconds(value) {
  const found = typeof value === 'string' ? EXPIRY.exec(value) : null;
  if (!found) return null;
  const [year, month, day, hour, minute, second] = found.slice(1, 7).map(Number);
  const [offsetHours, offsetMinutes] = [Number(found[9] ?? 0), Number(found[10] ?? 0)];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!monthDays || day < 1 || day > monthDays || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return null;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400), yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const days = era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719468;
  const offset = (found[8] === '-' ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60);
  return days * 86400 + hour * 3600 + minute * 60 + second - offset + Number((found[7] ?? '').slice(0, 3).padEnd(3, '0')) / 1000;
}

// The request target, checked against the origin this site is pinned to. Null unless it is in normal form: the
// signature covers the host and path exactly, so anything else is refused, never tidied up.
function normalTarget(publicOrigin, target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.split('?')[0].includes('^')) return null;
  if (target.split('?')[0].split('/').some((segment) => segment === '.' || segment === '..')) return null;
  let url;
  try { url = new URL(`${publicOrigin}${target}`); } catch { return null; }
  if (url.origin !== publicOrigin || `${url.pathname}${url.search}` !== target) return null;
  if (/%2e|%2f|%5c/i.test(url.pathname)) return null;
  return url;
}

// A listing from the registry, read strictly. Null means the answer cannot be used at all ("could not check").
async function readListing(keyId, doc) {
  if (typeof doc?.id !== 'string' || typeof doc.name !== 'string' || typeof doc.isActive !== 'boolean' || !Array.isArray(doc.keys)) return null;
  for (const key of doc.keys) {
    if (typeof key?.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.jkt) || key.agentId !== doc.id) return null;
    if (key.status !== 'active' || key.algorithm !== 'ed25519') return null;
    if (key.expirationDate != null && expirySeconds(key.expirationDate) === null) return null;
  }
  const agent = { id: doc.id, name: doc.name, isActive: doc.isActive, simulated: doc.simulated === true, directoryOrigin: typeof doc.directoryOrigin === 'string' ? doc.directoryOrigin : null };
  const key = doc.keys.find((k) => k.id === keyId || k.jkt === keyId);
  if (!key) return { agent };
  // The key arrives as base64 of a PEM public key. It is used only if it is an Ed25519 key, and its thumbprint (RFC 7638) is computed here, never taken on the listing's word.
  const pem = new TextDecoder().decode(unb64(key.publicKey));
  const der = unb64(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  const publicKey = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null;
  const thumbprint = b64url(await sha256(new TextEncoder().encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))));
  return { agent, key: { id: key.id, jkt: key.jkt, expirationDate: key.expirationDate ?? null }, publicKey, thumbprint };
}

async function readRegistry(url, parse, fetchImpl) {
  let response;
  // A redirect is never followed: trust in a key must not move to another address.
  try { response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }); } catch { return { unavailable: true, retryAfterSeconds: null }; }
  if (response.status === 404) return { notListed: true };
  if (response.status !== 200) {
    const retry = response.headers.get('retry-after') ?? '';
    return { unavailable: true, retryAfterSeconds: /^[0-9]+$/.test(retry) && Number(retry) > 0 ? Number(retry) : null };
  }
  try { const listing = await parse(await response.json()); return listing ? { listed: true, ...listing } : { invalid: true }; } catch { return { invalid: true }; }
}

function judgeKey(keyId, answer, now) {
  if (answer.unavailable) return refusal('registry_unavailable', answer.retryAfterSeconds);
  if (answer.invalid) return refusal('listing_unusable');
  if (answer.notListed) return refusal('key_not_listed');
  if (answer.agent.simulated) return refusal('simulated_listing');
  if (!answer.agent.isActive) return refusal('agent_not_live');
  if (!answer.key) return refusal('key_not_live');
  const computed = answer.thumbprint;
  if (computed !== keyId && (keyId.length !== 36 || answer.key.id !== keyId || answer.key.jkt !== computed)) return refusal('key_not_live');
  if (answer.key.expirationDate != null && expirySeconds(answer.key.expirationDate) <= now) return refusal('key_not_live');
  return null;
}

// Is this agent still listed? For a step that should not act on an answer a minute old. 'listed', 'not_listed' or 'unavailable'.
export async function agentStatus(registryOrigin, agentId, fetchImpl = fetch, now = Math.floor(Date.now() / 1000)) {
  const answer = await readRegistry(`${registryOrigin}/v1/tap/registry/agents/${encodeURIComponent(agentId)}`, (doc) => readListing(undefined, doc), fetchImpl);
  if (answer.unavailable || answer.invalid) return 'unavailable';
  if (answer.notListed || answer.agent.simulated || !answer.agent.isActive) return 'not_listed';
  return 'listed';
}

// `reserveNonce(id, expires)` answers true the first time it sees an id and false after that, until `expires`.
export function createVerifier({ registryOrigin = REGISTRY, reserveNonce, now = () => Math.floor(Date.now() / 1000), fetchImpl = (...a) => fetch(...a), cacheSeconds = 60 }) {
  const cache = new Map();
  async function lookup(keyId, fresh = false) {
    const hit = cache.get(keyId);
    if (!fresh && hit && hit.until > now()) return hit.answer;
    const answer = await readRegistry(`${registryOrigin}/v1/tap/registry/keys/${encodeURIComponent(keyId)}`, (doc) => readListing(keyId, doc), fetchImpl);
    if (answer.unavailable || answer.invalid) return answer;
    cache.delete(keyId);
    if (answer.listed && answer.agent.isActive && answer.key) { if (cache.size > 500) cache.clear(); cache.set(keyId, { answer, until: now() + cacheSeconds }); }
    return answer;
  }
  const verifies = (found, base, signature) => crypto.subtle.verify({ name: 'Ed25519' }, found.publicKey, signature, base).catch(() => false);

  // `headers`: every header of the request, names in lowercase. `rawBody`: the bytes as they arrived, before anything parsed them.
  // `alsoTransport(name)`: headers the caller's own host adds on the way in, beyond the list above.
  async function check({ method, publicOrigin, target, headers, rawBody, reserveNonce: reserve = reserveNonce, alsoTransport = () => false }) {
    const input = headers['signature-input'], signatureHeader = headers['signature'];
    if (!input || !signatureHeader) return refusal('no_signature_headers');
    const parsed = INPUT.exec(input);
    if (!parsed) return refusal('signature_input_format');
    const signed = SIGNATURE.exec(signatureHeader);
    if (!signed) return refusal('signature_header_format');
    const parts = parsed[1].trim().split(/\s+/);
    if (!parts.every((part) => /^"[^"]+"$/.test(part))) return refusal('components_invalid');
    const components = parts.map((part) => part.slice(1, -1).toLowerCase());
    if (new Set(components).size !== components.length) return refusal('components_invalid');
    const created = Number(parsed[2]), expires = Number(parsed[3]), keyId = parsed[4], nonce = parsed[6];
    const alg = parsed[5] === 'ecdsa-p256-sha256' ? 'ecdsa-p256-sha256' : 'ed25519';
    const url = normalTarget(publicOrigin, target);
    if (!url) return refusal('request_target_invalid');
    if (keyId.length === 36) {
      const needed = [...(url.search ? ['@query'] : []), ...['accept', 'content-type'].filter((name) => headers[name] !== undefined)];
      if (needed.some((name) => !components.includes(name))) return refusal('directory_components_missing');
    }
    const t = now();
    if (created > t + CLOCK_SKEW_SECONDS) return refusal('not_yet_valid');
    if (expires <= t || expires <= created) return refusal('expired');
    if (expires - created > MAX_LIFETIME_SECONDS) return refusal('lifetime_too_long');
    if (JSON.stringify(components.slice(0, CORE.length)) !== JSON.stringify(CORE)) return refusal('required_components_missing');
    if (!['GET', 'HEAD', 'POST'].includes(method)) return refusal('method_not_allowed');
    if (CREDENTIALS.some((name) => headers[name] !== undefined)) return refusal('credential_header_present');
    if (components.length > 38) return refusal('signed_header_invalid');
    let previous = '', size = 0;
    for (const name of components.slice(CORE.length)) {
      const value = headers[name];
      if (!HEADER_NAME.test(name) || name <= previous || typeof value !== 'string' || value.trim() !== value || value.length > 4096 || /[^\x20-\x7e]/.test(value)) return refusal('signed_header_invalid');
      if (NEVER_SIGNED.has(name) || NEVER_SIGNED_PREFIX.test(name)) return refusal('signed_header_invalid');
      previous = name; size += name.length + value.length;
    }
    if (size > 16384) return refusal('signed_header_invalid');
    for (const name of Object.keys(headers)) {
      const transport = TRANSPORT_HEADERS.has(name) || name.startsWith('sec-fetch-') || alsoTransport(name);
      if (!components.includes(name) && !transport) return refusal('uncovered_header', null, name);
    }
    if (b64(unb64(nonce)) !== nonce) return refusal('nonce_format');
    if (rawBody.length > MAX_BODY_BYTES) return refusal('body_too_large');
    if (!DIGEST.test(headers['content-digest'] ?? '')) return refusal('digest_format');
    if (headers['content-digest'] !== `sha-256=:${b64(await sha256(rawBody))}:`) return refusal('body_digest_mismatch');
    const signatureAgent = headers['signature-agent'];
    if (signatureAgent !== undefined && !SIGNATURE_AGENTS.includes(signatureAgent)) return refusal('signature_agent_not_accepted');

    let found = await lookup(keyId);
    let refused = judgeKey(keyId, found, t);
    if (refused) return refused;
    // The signature base is rebuilt from this site's own address, never from the Host header.
    const derived = { '@method': method, '@scheme': 'https', '@authority': url.host, '@path': url.pathname || '/', '@query': url.search || '?' };
    const lines = components.map((name) => `"${name}": ${name.startsWith('@') ? derived[name] : headers[name]}`);
    lines.push(`"@signature-params": ${input.slice('sig2='.length)}`);
    const base = new TextEncoder().encode(lines.join('\n')), signature = unb64(signed[1]);
    if (alg !== 'ed25519' || !(await verifies(found, base, signature))) {
      // Once more with a fresh lookup before refusing, in case the key has just been replaced.
      found = await lookup(keyId, true);
      refused = judgeKey(keyId, found, t);
      if (refused) return refused;
      if (alg !== 'ed25519') return refusal('algorithm_mismatch');
      if (!(await verifies(found, base, signature))) return refusal('signature_mismatch');
    }
    // Last, so a forged request cannot use up a nonce.
    let reserved;
    try { reserved = await reserve(`${keyId}:${nonce}`, expires); } catch { return refusal('nonce_store_unavailable'); }
    if (!reserved) return refusal('nonce_reused');
    return { ok: true, keyId, jkt: found.key.jkt, agentId: found.agent.id, agentName: found.agent.name, directoryOrigin: found.agent.directoryOrigin, covered: components, expires };
  }
  return async (request) => { try { return await check(request); } catch { return refusal('request_unreadable'); } };
}
