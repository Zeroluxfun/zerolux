// Chain access for the Zero Lux runtime: read client, contract ABIs, and the
// Signer Durable Object that sends every transaction from the operator key.
//
// Threat model. This Worker is treated as untrusted by the contracts. The
// operator key it holds can do exactly two things with other people's money:
//   1. charge an agent wallet for a run, which pays only that wallet's pinned
//      treasury and only inside the caps the wallet's owner set;
//   2. submit a payment a customer already signed, which can only move the
//      signed amount from the signer to the address they signed for.
// It cannot withdraw from any wallet, change where charges go, or touch a lien.
// If the key leaks: rotate it with factory.setOperator. Worst case before
// rotation is one day cap per wallet, paid into our own treasury.
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DurableObject } from 'cloudflare:workers';

export const CHAIN_ID = 4663;
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const USDG_DOMAIN = { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG };

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const factoryAbi = parseAbi([
  'function createAgent(address agentOwner, uint128 perRunCap, uint128 perDayCap, bytes32 specHash, string agentURI, address expectedTreasury, uint16 expectedMarkupBps) returns (uint256 id, address wallet)',
  'function treasury() view returns (address)',
  'function agentCount() view returns (uint256)',
  'function isAgentWallet(address) view returns (bool)',
  'function agentIdOf(address) view returns (uint256)',
  'function operator() view returns (address)',
  'function markupBps() view returns (uint16)',
  'event AgentCreated(uint256 indexed id, address indexed wallet, address indexed creator, bytes32 specHash)',
  'event IdentityRegistered(uint256 indexed id, uint256 indexed identityId)',
]);

export const walletAbi = parseAbi([
  'function charge(bytes32 runId, uint256 cost)',
  'function chargeAndSettle(bytes32 runId, uint256 cost, uint256 settledUpTo)',
  'function settle(uint256 settledUpTo)',
  'function settledProfit() view returns (uint256)',
  'function unsettled() view returns (uint256)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function perRunCap() view returns (uint128)',
  'function perDayCap() view returns (uint128)',
  'function markupBps() view returns (uint16)',
  'function remainingToday() view returns (uint256)',
  'function income() view returns (uint256)',
  'function profit() view returns (uint256)',
  'function totalCharged() view returns (uint256)',
  'function withdrawable() view returns (uint256)',
  'function lienUnpaid() view returns (uint256)',
  'function lien() view returns (address payee, uint16 bps, uint128 cap, uint128 paid, uint256 baseProfit)',
  'function runCharged(bytes32) view returns (bool)',
]);

export const usdgAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

// Error text from the RPC library can include the RPC address, which is a secret.
const why = (e) => String(e?.shortMessage || e?.name || 'error').replace(/https?:\/\/\S+/g, '[rpc]').slice(0, 200);

export function reader(env) {
  return createPublicClient({ chain: robinhood, transport: http(env.RPC_URL), batch: { multicall: true } });
}

// One instance sends every transaction, one at a time, so nonces never collide.
export class Signer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
  }

  // call = { to, abi: 'factory' | 'wallet' | 'usdg', functionName, args }
  send(call) {
    const job = this.queue.then(() => this._send(call));
    this.queue = job.catch(() => {});
    return job;
  }

  async _send({ to, abi, functionName, args }) {
    const abis = { factory: factoryAbi, wallet: walletAbi, usdg: usdgAbi };
    const account = privateKeyToAccount(this.env.OPERATOR_KEY);
    const transport = http(this.env.RPC_URL);
    const pub = createPublicClient({ chain: robinhood, transport });
    const wal = createWalletClient({ account, chain: robinhood, transport });
    const data = encodeFunctionData({ abi: abis[abi], functionName, args });
    let gas;
    try {
      gas = await pub.estimateGas({ account: account.address, to, data });
    } catch (e) {
      // Only a revert from the contract itself means "refused". A timeout, a rate
      // limit or an empty gas tank is our problem and must never be read as one.
      const reverted = !!e?.walk?.((x) => x?.name === 'ExecutionRevertedError' || x?.name === 'ContractFunctionRevertedError');
      return { ok: false, stage: reverted ? 'revert' : 'rpc', error: why(e) };
    }
    let hash;
    try {
      hash = await wal.sendTransaction({ to, data, gas: (gas * 13n) / 10n });
    } catch (e) {
      return { ok: false, stage: 'rpc', error: why(e) };
    }
    try {
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 700, timeout: 45_000 });
      return {
        ok: r.status === 'success', stage: r.status === 'success' ? 'mined' : 'revert', hash,
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      };
    } catch (e) {
      return { ok: false, stage: 'wait', hash, error: why(e) };
    }
  }

  // Bill one run. Everything is read inside this object's one-at-a-time queue,
  // right before sending, so no payment can slip between the reads and the charge:
  // payments are submitted through this same queue and their rows exist before
  // they are submitted.
  bill(run) {
    const job = this.queue.then(async () => {
      let upTo = null;
      try {
        const row = await this.env.DB.prepare("SELECT COALESCE(SUM(paid), 0) AS n FROM runs WHERE agent_id = ? AND id != ? AND status IN ('paying', 'paid', 'running', 'ran')").bind(run.agent_id, run.id).first();
        const c = reader(this.env);
        const [profit, markup] = await Promise.all([
          c.readContract({ address: run.wallet, abi: walletAbi, functionName: 'profit' }),
          c.readContract({ address: run.wallet, abi: walletAbi, functionName: 'markupBps' }),
        ]);
        const cost = BigInt(run.cost);
        // Final profit once this run is billed: today's, less this charge, less money held for runs still to bill.
        upTo = profit - cost - (cost * BigInt(markup)) / 10_000n - BigInt(row.n);
        if (upTo < 0n) upTo = 0n;
      } catch { upTo = null; }
      // If the figure could not be worked out, charge without moving the checkpoint at all.
      return upTo === null
        ? this._send({ to: run.wallet, abi: 'wallet', functionName: 'charge', args: [run.id, BigInt(run.cost)] })
        : this._send({ to: run.wallet, abi: 'wallet', functionName: 'chargeAndSettle', args: [run.id, BigInt(run.cost), upTo] });
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async address() {
    return privateKeyToAccount(this.env.OPERATOR_KEY).address;
  }
}

export const signer = (env) => env.SIGNER.get(env.SIGNER.idFromName('operator'));

// USDG amounts are integers with 6 decimals.
export const usd = (units) => (Number(units) / 1e6).toFixed(Number(units) % 10_000 === 0 ? 2 : 4);
