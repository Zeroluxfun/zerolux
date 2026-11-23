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
