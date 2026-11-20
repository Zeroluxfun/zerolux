// What an agent can read from Robinhood Chain during a run. Read-only: an agent holds no keys
// and every call here is an eth_call or a lookup, never a transaction.
import { isAddress, getAddress, parseAbi, formatUnits } from 'viem';

const erc20 = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
]);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const plain = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)).slice(0, 4000);
// An RPC error can carry the node's address, which is a secret.
const scrub = (e) => String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '[node]').slice(0, 220);

export const READ_CHAIN_DEF = {
  type: 'function',
  function: {
    name: 'read_chain',
    description: 'Read Robinhood Chain (chain id 4663). Actions: "account" says what an address is (ETH balance, whether it is a contract, and its name, symbol, decimals and supply if it is a token). "balance" says how much of a token an address holds (give token and address). "call" runs one read-only function on a contract (give address, a signature like "function owner() view returns (address)", and args as a list). "tx" says what a transaction did (give hash). "block" gives the latest block number and time.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['account', 'balance', 'call', 'tx', 'block'] },
        address: { type: 'string' }, token: { type: 'string' }, signature: { type: 'string' },
        args: { type: 'array', items: {} }, hash: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

// `c` is a viem public client for Robinhood Chain.
export async function readChain(c, a) {
  try {
    const addr = (x, what) => { if (!isAddress(String(x || ''))) throw new Error(`${what} is not a valid address`); return getAddress(String(x)); };
    switch (a?.action) {
      case 'block': {
        const b = await c.getBlock();
        return plain({ number: b.number, time: new Date(Number(b.timestamp) * 1000).toISOString() });
      }
      case 'account': {
        const address = addr(a.address, 'address');
        const [balance, code, sent] = await Promise.all([c.getBalance({ address }), c.getCode({ address }), c.getTransactionCount({ address })]);
        const out = { address, eth: formatUnits(balance, 18), is_contract: !!code && code !== '0x', transactions_sent: sent };
        if (out.is_contract) {
          out.code_bytes = (code.length - 2) / 2;
          const r = await c.multicall({ contracts: ['name', 'symbol', 'decimals', 'totalSupply'].map((functionName) => ({ address, abi: erc20, functionName })), allowFailure: true });
          if (r[1].status === 'success' && r[2].status === 'success') {
            out.token = { name: r[0].status === 'success' ? r[0].result : null, symbol: r[1].result, decimals: r[2].result, total_supply: r[3].status === 'success' ? formatUnits(r[3].result, r[2].result) : null };
          }
        }
        return plain(out);
      }
      case 'balance': {
        const token = addr(a.token, 'token'), holder = addr(a.address, 'address');
        const r = await c.multicall({ contracts: [{ address: token, abi: erc20, functionName: 'balanceOf', args: [holder] }, { address: token, abi: erc20, functionName: 'decimals' }, { address: token, abi: erc20, functionName: 'symbol' }], allowFailure: true });
        if (r[0].status !== 'success') throw new Error('that token did not answer balanceOf');
        const decimals = r[1].status === 'success' ? r[1].result : 18;
        return plain({ token, holder, symbol: r[2].status === 'success' ? r[2].result : null, balance: formatUnits(r[0].result, decimals), raw: r[0].result });
      }
      case 'call': {
        const address = addr(a.address, 'address');
        const signature = String(a.signature || '').trim().slice(0, 300);
        if (!/^function\s+\w+\s*\(/.test(signature)) throw new Error('signature must look like "function name(types) view returns (types)"');
        const abi = parseAbi([signature]);
        const args = (Array.isArray(a.args) ? a.args : []).slice(0, 8);
        const result = await c.readContract({ address, abi, functionName: abi[0].name, args });
        return plain({ address, function: abi[0].name, result });
      }
      case 'tx': {
        const hash = String(a.hash || '');
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('hash is not a transaction hash');
        const [tx, rc] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
        const transfers = rc.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length === 3).slice(0, 10)
          .map((l) => ({ token: l.address, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), raw_amount: BigInt(l.data === '0x' ? 0 : l.data) }));
        return plain({ hash, status: rc.status, block: rc.blockNumber, from: tx.from, to: tx.to, created_contract: rc.contractAddress || null, eth_sent: formatUnits(tx.value, 18), gas_used: rc.gasUsed, log_count: rc.logs.length, token_transfers: transfers });
      }
      default: throw new Error('action must be account, balance, call, tx or block');
    }
  } catch (e) { return 'Chain read failed: ' + scrub(e); }
}
