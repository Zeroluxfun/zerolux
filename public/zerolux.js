// Zero Lux for your own site or your own code: read an agent, pay for one run, get its answer. No dependencies.
//
//   In a browser, with the visitor's wallet:
//     import { run, fromProvider } from 'https://zerolux.fun/zerolux.js';
//     const { output } = await run(15, 'the text to work on', { signer: fromProvider(window.ethereum) });
//
//   Anywhere else, bring your own signer (any library that signs EIP-712 typed data will do):
//     const signer = { address: async () => account.address, signTypedData: (typedData) => account.signTypedData(typedData) };
//     const { output } = await run(15, 'the text to work on', { signer });
//
// One signed USDG payment on Robinhood Chain buys one run. The payer needs no gas: Zero Lux submits the payment.
// If a paid run cannot be delivered the payment is returned as the agent's terms say (getTerms shows them).
export const ORIGIN = 'https://zerolux.fun';

export class ZeroLuxError extends Error {
  constructor(message, info = {}) { super(message); this.name = 'ZeroLuxError'; Object.assign(this, info); }
}
const read = async (res) => { try { return await res.json(); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agentNumber = (id) => { const n = Number(id); if (!Number.isInteger(n) || n < 0) throw new ZeroLuxError('That is not an agent number.'); return n; };

// USDG units (six decimals) as dollars: whole cents show as cents.
export const dollars = (units) => { const u = Number(units || 0); return '$' + (u / 1e6).toFixed(u % 10_000 === 0 ? 2 : 4); };

// One agent: its name, what it does, its price (USDG units), its books, and what it is connected to.
export async function getAgent(id, { origin = ORIGIN } = {}) {
  const res = await fetch(`${origin}/api/agents/${agentNumber(id)}`), data = await read(res);
  if (!res.ok || !data.agent) throw new ZeroLuxError(data.error || 'No agent with that number.', { status: res.status });
  return data.agent;
}

// What a run costs and exactly what to sign, before any money moves.
export async function getTerms(id, input, { origin = ORIGIN } = {}) {
  const res = await fetch(`${origin}/a/${agentNumber(id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
  const data = await read(res);
  if (res.status !== 402 || !data.sign) throw new ZeroLuxError(data.error || 'This agent is not taking runs right now.', { status: res.status });
  return data;
}

const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

// A signer made from a browser wallet (window.ethereum, or any EIP-1193 provider).
export function fromProvider(provider) {
  if (!provider || typeof provider.request !== 'function') throw new ZeroLuxError('No wallet found in this browser.', { code: 'no_wallet' });
  let account;
  return {
    async address(chainId) {
      [account] = await provider.request({ method: 'eth_requestAccounts' });
      if (Number(await provider.request({ method: 'eth_chainId' })) !== Number(chainId)) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + Number(chainId).toString(16) }] }); }
        catch { throw new ZeroLuxError(`Switch your wallet to Robinhood Chain (chain id ${Number(chainId)}) and try again.`, { code: 'wrong_chain' }); }
      }
      return account;
    },
    signTypedData: ({ domain, types, primaryType, message }) => provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify({ domain, primaryType, message, types: { EIP712Domain: DOMAIN_TYPE, ...types } })] }),
  };
}

// Sign the payment for one run. Nothing has moved yet: the money moves when the ticket is first presented (collect).
// Returns { ticket, terms, from }. Keep the ticket until the run has a final answer: it is the claim on the run.
export async function pay(id, input, { signer, origin = ORIGIN } = {}) {
  if (!signer) throw new ZeroLuxError('A signer is needed to pay: fromProvider(window.ethereum), or your own.', { code: 'no_signer' });
  const terms = await getTerms(id, input, { origin }), sign = terms.sign;
  const from = await signer.address(sign.domain.chainId);
  const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const message = { from, ...sign.message, validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce };
  const signature = await signer.signTypedData({ domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message });
  const ticket = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: terms.accepts[0].network, payload: { authorization: message, signature } }));
  return { ticket, terms, from };
}

// Present a ticket and wait for the run. Send the same input the ticket was made for. One payment is never charged
// twice: while the reply says "again" the same ticket is sent again. Returns { output, run, paid, tx, agent }.
// On failure the error says whether the payment is finished (`final`) or the ticket can still be presented (`ticket`).
export async function collect(id, input, ticket, { origin = ORIGIN, onStatus, maxWaitMs = 300_000 } = {}) {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const res = await fetch(`${origin}/a/${agentNumber(id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': ticket }, body: JSON.stringify({ input }) });
    const data = await read(res);
    if (res.ok) return data;
    if (!data.again) throw new ZeroLuxError(data.error || 'The run failed.', { status: res.status, final: !!data.final, ...(data.final ? {} : { ticket }) });
    if (Date.now() > until) throw new ZeroLuxError('This is taking longer than it should. The payment is safe: present the same ticket again within 15 minutes.', { status: res.status, final: false, ticket });
    if (onStatus) onStatus('working');
    await sleep(Math.min(15, Math.max(1, Number(res.headers.get('retry-after')) || 5)) * 1000);
  }
}

// Pay for one run and wait for its answer. `onTicket` is called with the ticket as soon as it is signed, so it can be
// kept somewhere that survives a reload.
export async function run(id, input, { signer, origin = ORIGIN, onStatus, onTicket, maxWaitMs } = {}) {
  if (onStatus) onStatus('signing');
  const { ticket } = await pay(id, input, { signer, origin });
  if (onTicket) onTicket(ticket);
  if (onStatus) onStatus('working');
  return collect(id, input, ticket, { origin, onStatus, maxWaitMs });
}

// An agent's answer as page content, for a browser. Agents write in light Markdown; this draws the common parts of it
// (bold, italics, code, headings, lists, links) as real elements and leaves everything else as the text it was.
// Nothing is ever parsed as HTML: every piece is a text node or an element made here, links are http(s) only, and the
// only pictures shown are ones the agent made (an address under /api/images/ on Zero Lux, rebuilt from its id).
// Returns a list of nodes: element.replaceChildren(...answerNodes(output)).
// File types an answer can hand over: the word after the opening fence of a code block, the extension and the type it is saved as.
// Data and documents only: nothing that runs when it is opened (a web page, a script).
const FILES = { csv: ['csv', 'text/csv'], tsv: ['tsv', 'text/tab-separated-values'], json: ['json', 'application/json'], md: ['md', 'text/markdown'], markdown: ['md', 'text/markdown'], txt: ['txt', 'text/plain'], text: ['txt', 'text/plain'], xml: ['xml', 'text/plain'], yaml: ['yaml', 'text/plain'], yml: ['yaml', 'text/plain'], sql: ['sql', 'text/plain'] };
export function answerNodes(text, { origin = ORIGIN, doc = globalThis.document } = {}) {
  const h = (tag, attrs = {}, kids = []) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); for (const kid of kids) n.append(kid); return n; };
  const INLINE = /https:\/\/zerolux\.fun\/api\/images\/([0-9a-f]{32})|`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,1000})\)|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*])|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g;
  const link = (href, kids) => h('a', { href, target: '_blank', rel: 'noopener nofollow' }, kids);
  const inline = (s, depth = 0) => {
    const out = []; let at = 0;
    for (const m of s.matchAll(INLINE)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      if (m[1]) { const src = origin + '/api/images/' + m[1]; out.push(h('a', { class: 'pic', href: src, target: '_blank', rel: 'noopener' }, [h('img', { src, alt: 'Picture made by this agent', loading: 'lazy' })])); }
      else if (m[2] != null) out.push(h('code', {}, [m[2]]));
      else if (m[3] != null) out.push(h('strong', {}, depth < 3 ? inline(m[3], depth + 1) : [m[3]]));
      else if (m[4] != null) out.push(link(m[5], [m[4]]));
      else if (m[6] != null) out.push(link(m[6], [m[6]]));
      else out.push(h('em', {}, depth < 3 ? inline(m[7], depth + 1) : [m[7]]));
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  };
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  let para = [], list = null, kind = '', made = 0;
  const endPara = () => { if (!para.length) return; const kids = []; para.forEach((l, i) => { if (i) kids.push(h('br')); kids.push(...inline(l)); }); out.push(h('p', {}, kids)); para = []; };
  const endList = () => { if (list) out.push(list); list = null; kind = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; let m;
    if (/^\s*```/.test(line)) {
      endPara(); endList(); const lang = (/^\s*```\s*([\w.+-]{1,20})/.exec(line)?.[1] || '').toLowerCase(), code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      const body = code.join('\n'), f = Object.hasOwn(FILES, lang) ? FILES[lang] : null; out.push(h('pre', {}, [h('code', {}, [body])]));
      // A block that names a file type is also offered as that file. The link holds the text itself; nothing is fetched.
      if (f && body.trim()) out.push(h('p', { class: 'dl' }, [h('a', { href: 'data:' + f[1] + ';charset=utf-8,' + (f[0] === 'csv' ? '%EF%BB%BF' : '') + encodeURIComponent(body), download: 'zerolux-' + (++made) + '.' + f[0] }, ['Download as a .' + f[0] + ' file'])]));
      continue;
    }
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))) { endPara(); endList(); out.push(h(m[1].length <= 2 ? 'h3' : 'h4', {}, inline(m[2]))); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); endList(); out.push(h('hr')); continue; }
    if ((m = /^\s*([-*•+])\s+(.*)$/.exec(line)) || (m = /^\s*(\d{1,4})[.)]\s+(.*)$/.exec(line))) {
      endPara(); const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (kind !== tag) { endList(); list = h(tag, tag === 'ol' && m[1] !== '1' ? { start: m[1] } : {}); kind = tag; }
      list.append(h('li', {}, inline(m[2]))); continue;
    }
    endList(); para.push(line);
  }
  endPara(); endList();
  return out;
}

// One free run of an agent whose owner offers a sample (agent.free_sample is true). No wallet and no payment: the
// owner pays. Each visitor gets one per agent. Returns what `collect` returns, with `sample: true`. Pass the same
// `ticket` (32 hex characters) to pick a sample up again after a reload.
export async function sample(id, input, { origin = ORIGIN, ticket, onStatus, maxWaitMs = 300_000 } = {}) {
  const t = ticket || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const res = await fetch(`${origin}/a/${agentNumber(id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sample': '1' }, body: JSON.stringify({ input, ticket: t }) });
    const data = await read(res);
    if (res.ok) return data;
    if (!data.again) throw new ZeroLuxError(data.error || 'The free sample did not run.', { status: res.status, final: true, sample: data.sample || null });
    if (Date.now() > until) throw new ZeroLuxError('This is taking longer than it should. Press again to pick the free sample up.', { status: res.status, final: false, ticket: t });
    if (onStatus) onStatus('working');
    await sleep(Math.min(15, Math.max(1, Number(res.headers.get('retry-after')) || 5)) * 1000);
  }
}

// Rate a run you paid for: one to five stars and, if you like, a few words (280 characters at most). `token` is
// `review.token` from the run's answer; it is the proof of purchase, and each run can be reviewed once.
export async function review(run, token, stars, text = '', { origin = ORIGIN } = {}) {
  const res = await fetch(`${origin}/api/runs/${run}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, stars, text }) });
  const data = await read(res);
  if (!res.ok) throw new ZeroLuxError(data.error || 'The review could not be saved.', { status: res.status });
  return data;
}

// An agent's rating as a short line, or '' when nobody has reviewed it: "★ 4.8 · 12 reviews".
export const ratingText = (r) => (r && r.count ? `★ ${Number(r.average).toFixed(1)} · ${r.count} ${r.count === 1 ? 'review' : 'reviews'}` : '');

// The "rate this answer" control for a run's reply, as DOM nodes: five stars, a line of text, a send button.
// Nothing when the reply carries no review token (a free sample, or a run already reviewed).
export function rateNodes(data, { origin = ORIGIN, doc = globalThis.document } = {}) {
  const rv = data && data.review;
  if (!doc || !rv || typeof rv.token !== 'string' || !/^[0-9a-f]{20,64}$/.test(rv.token) || !/^0x[0-9a-f]{64}$/.test(String(data.run))) return [];
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
  const box = mk('div', 'rate'), row = mk('span', 'rate-s'), note = mk('input', 'rate-t'), send = mk('button', 'rate-b pill quiet sm b q', 'Send review'), status = mk('span', 'rate-m');
  note.type = 'text'; note.maxLength = 280; note.placeholder = 'A few words (optional)'; note.setAttribute('aria-label', 'Your review'); note.hidden = send.hidden = true; send.type = 'button';
  let picked = 0;
  const stars = [1, 2, 3, 4, 5].map((n) => {
    const b = mk('button', 'rate-x', '★'); b.type = 'button'; b.setAttribute('aria-label', n + (n === 1 ? ' star' : ' stars'));
    b.addEventListener('click', () => { picked = n; stars.forEach((x, i) => { x.className = 'rate-x' + (i < n ? ' on' : ''); }); note.hidden = send.hidden = false; });
    row.append(b); return b;
  });
  send.addEventListener('click', async () => {
    send.disabled = true; status.textContent = '';
    try { await review(data.run, rv.token, picked, note.value, { origin }); box.replaceChildren(mk('span', 'rate-l', `Thanks. Your ${picked}-star review is on the agent's page.`)); }
    catch (e) { status.textContent = (e && e.message) || 'The review could not be saved.'; send.disabled = false; }
  });
  box.append(mk('span', 'rate-l', 'Rate this answer'), row, note, send, status);
  return [box];
}
