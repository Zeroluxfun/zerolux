// MCP server (streamable HTTP, stateless): lets any AI client browse the floor,
// put an agent on the line, and hire one. Each tool calls the same handlers the
// site uses, so limits and payment checks are identical.
import { json, line, createAgent } from './line.js';
import { listAgents, findAgent, getAgent } from './api.js';
import { hire } from './run.js';

const TOOLS = [
  { name: 'zerolux_list_agents', description: 'List every agent on the Zero Lux floor with its price per call in USDG and its on-chain income and profit.', inputSchema: { type: 'object', properties: {} } },
  { name: 'zerolux_get_agent', description: 'One agent: what it does, its price, wallet, on-chain record and recent paid runs.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'zerolux_draft_agent', description: 'Turn a written job into an agent draft (name, instructions, tools, price). Nothing goes on chain yet.', inputSchema: { type: 'object', properties: { job: { type: 'string', description: 'The job the agent should sell, in a sentence or two.' } }, required: ['job'] } },
  { name: 'zerolux_create_agent', description: 'Put a draft on Robinhood Chain as a live agent with its own wallet and ERC-8004 identity. Zero Lux pays the gas. The owner address controls the wallet and its earnings. Ask the user before calling.', inputSchema: { type: 'object', properties: { draft: { type: 'string' }, owner: { type: 'string', description: 'Wallet address that will own the agent.' }, price_usd: { type: 'number' } }, required: ['draft', 'owner'] } },
  { name: 'zerolux_hire', description: 'Run an agent once. Call without `payment` to get the exact USDG payment to sign (EIP-3009 TransferWithAuthorization, typed data in `sign`). Call again with `payment` = {authorization: {from, to, value, validAfter, validBefore, nonce}, signature} to pay and get the result. The payer needs USDG on Robinhood Chain and no gas. If a reply says again:true, call again with the identical payment: one payment buys one run and is never charged twice. Ask the user before paying.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, input: { type: 'string' }, payment: { type: 'object' } }, required: ['id', 'input'] } },
];

const post = (request, body) => new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': request.headers.get('cf-connecting-ip') || 'local' }, body: JSON.stringify(body) });

async function call(name, args, request, env, ctx) {
  if (name === 'zerolux_list_agents') return listAgents(env);
  if (name === 'zerolux_draft_agent') return line(post(request, { job: args.job }), env);
  if (name === 'zerolux_create_agent') return createAgent(post(request, args), env);
  if (name === 'zerolux_get_agent' || name === 'zerolux_hire') {
    const a = await findAgent(env, String(args.id));
    if (!a) return json({ error: 'No agent with that id.' }, 404);
    if (name === 'zerolux_get_agent') return getAgent(env, a);
    return hire(post(request, { input: args.input, payment: args.payment }), env, ctx, a);
  }
  return null;
}

export async function mcp(request, env, ctx) {
  if (request.method !== 'POST') return json({ jsonrpc: '2.0', error: { code: -32000, message: 'POST JSON-RPC here.' }, id: null }, 405, { allow: 'POST' });
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json') || Number(request.headers.get('content-length') || 0) > 80_000) return json({ jsonrpc: '2.0', error: { code: -32600, message: 'Send application/json.' }, id: null }, 400);
  let msg; try { msg = JSON.parse((await request.text()).slice(0, 80_000)); } catch { return json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400); }
  const reply = (result) => json({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications
  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'zerolux', version: '1.0.0' },
      instructions: 'Zero Lux is an agent factory on Robinhood Chain. Agents sell one job per call for USDG, paid to a wallet contract that keeps a public record of income and profit.',
    });
  }
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const res = await call(msg.params?.name, msg.params?.arguments || {}, request, env, ctx);
    if (!res) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
    const text = await res.text();
    return reply({ content: [{ type: 'text', text }], isError: res.status >= 400 && res.status !== 402 });
  }
  return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}
