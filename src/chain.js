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
// On a version 3 wallet it can also refund a run it let in, which sends that
// run's payment back to the address that paid it and to nobody else; and it can
// pay another agent's wallet out of a run it let in, but only a wallet the paying
// wallet's owner has put on its own list (setPayable), and only up to that run's budget.
//
// ROTATING THE KEY. A version 3 hold answers only to the address that opened it:
// after factory.setOperator the new key can neither charge nor refund a run the
// old key let in. So the key must not be rotated while any version 3 run is in
// 'paying', 'paid', 'running', 'ran' or 'refunding'. Stop new payments, let the
// sweep bill and refund what is open, and check that openV3Runs(env) is 0 first.
// If the key has leaked and cannot wait: every hold the old key opened can be
// released by anyone once it is a day old, and a recorded payment then goes back
// to its payer in full (the sweep does this for rows it has closed).
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

// Version 2 wallets: a run's cost is set aside before the work is done.
export const wallet2Abi = parseAbi([
  'function pay(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s, bytes32 runId, uint256 budget)',
  'function open(bytes32 runId, uint256 budget)',
  'function release(bytes32 runId)',
  'function holds(bytes32) view returns (uint128 amount, uint64 day, uint64 openedAt)',
  'function heldTotal() view returns (uint256)',
]);

// Version 3 wallets: a payment taken through `pay` is held whole, with a record of who paid, until the run is
// charged, refunded or released. Every charge carries a receipt fingerprint. Only the address that opened a hold
// (called `pay` or `open`) may later charge, refund or early-release it.
export const wallet3Abi = parseAbi([
  'function pay(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s, bytes32 runId, uint256 budget, bool receiveOnly)',
  'function open(bytes32 runId, uint256 budget)',
  'function release(bytes32 runId)',
  'function charge(bytes32 runId, uint256 cost, bytes32 receipt)',
  'function chargeAndSettle(bytes32 runId, uint256 cost, uint256 settledUpTo, bytes32 receipt)',
  'function refund(bytes32 runId, uint256 cost, bytes32 receipt)',
  // One agent's run paying another agent's wallet: the money leaves the paying run's hold and budget, and the receiving
  // wallet files it as a paid run under subRunKey(payingWallet, subRunId) = keccak256(abi.encode(payingWallet, subRunId)).
  'function payAgent(bytes32 runId, address toWallet, uint256 value, bytes32 subRunId, uint256 subBudget)',
  'function retryReturn(bytes32 runId)',
  'function owedBack(bytes32) view returns (uint256)',
  'function payableCount() view returns (uint256)',
  'function payableAt(uint256 i) view returns (address)',
  'function holds(bytes32) view returns (address opener, uint32 day, uint64 openedAt, uint96 amount, uint80 budget, uint80 reserved)',
  'function payments(bytes32) view returns (address payer, uint80 value, bool outside, bool refunded)',
  'function runCharged(bytes32) view returns (bool)',
  'function operator() view returns (address)',
  'function customOperator() view returns (address)',
  'function externalIncome() view returns (uint256)',
  'function insiderIncome() view returns (uint256)',
  'function payerCount() view returns (uint256)',
  'function topPayer() view returns (address)',
  'function topPayerPaid() view returns (uint256)',
  'function totalRefunded() view returns (uint256)',
  'function heldTotal() view returns (uint256)',
  'event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside)',
  'event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury, bytes32 receipt)',
  'event Refunded(bytes32 indexed runId, address indexed payer, uint256 amount, bool parked)',
]);
export const factory3Abi = parseAbi(['function operatorPaused() view returns (bool)']);

// How many version 3 runs are open under the operator key right now. Must be 0 before the key is rotated (see the top of this file).
export const openV3Runs = async (env) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.v = 3 AND (r.status IN ('paying', 'paid', 'running', 'ran', 'refunding') OR (r.held > 0 AND r.status IN ('failed', 'forfeit')))").first()).n;

// The factory that made an agent: each wallet version has its own.
export const factoryOf = (env, agent) => (agent.v === 3 ? env.FACTORY3 : agent.v === 2 ? env.FACTORY2 : env.FACTORY);
// The address our transactions come from. A version 3 hold answers only to the address that opened it.
export const operatorAddress = (env) => privateKeyToAccount(env.OPERATOR_KEY).address;

export const registryAbi = parseAbi(['function getAgentWallet(uint256 agentId) view returns (address)']);

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

  // call = { to, abi: 'factory' | 'wallet' | 'wallet2' | 'wallet3' | 'usdg', functionName, args }
  send(call) {
    const job = this.queue.then(() => this._send(call));
    this.queue = job.catch(() => {});
    return job;
  }

  async _send({ to, abi, functionName, args }) {
    const abis = { factory: factoryAbi, wallet: walletAbi, wallet2: wallet2Abi, wallet3: wallet3Abi, usdg: usdgAbi };
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
      return { ok: false, stage: 'send', error: why(e) }; // it may or may not have gone out
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
  // run = { id, agent_id, wallet, cost } and, for a version 3 wallet, v: 3 and the run's receipt fingerprint.
  bill(run) {
    const job = this.queue.then(async () => {
      let upTo = null;
      try {
        const row = await this.env.DB.prepare("SELECT COALESCE(SUM(paid), 0) AS n FROM runs WHERE agent_id = ? AND id != ? AND status IN ('paying', 'paid', 'running', 'ran', 'refunding')").bind(run.agent_id, run.id).first();
        const c = reader(this.env);
        const [profit, markup, settled] = await Promise.all([
          c.readContract({ address: run.wallet, abi: walletAbi, functionName: 'profit' }),
          c.readContract({ address: run.wallet, abi: walletAbi, functionName: 'markupBps' }),
          c.readContract({ address: run.wallet, abi: walletAbi, functionName: 'settledProfit' }),
        ]);
        const cost = BigInt(run.cost);
        // Final profit once this run is billed: today's, less this charge, less money held for runs still to bill.
        upTo = profit - cost - (cost * BigInt(markup)) / 10_000n - BigInt(row.n);
        // Never pull the checkpoint back: profit already counted as final stays final
        // (the contract itself lowers it if a charge takes profit below it).
        if (upTo < settled) upTo = settled;
      } catch { upTo = null; }
      // If the figure could not be worked out, charge without moving the checkpoint at all.
      // A version 3 wallet takes the same two calls with the receipt fingerprint added, and bounds the checkpoint itself.
      const abi = run.v === 3 ? 'wallet3' : 'wallet', tail = run.v === 3 ? [run.receipt] : [];
      return upTo === null
        ? this._send({ to: run.wallet, abi, functionName: 'charge', args: [run.id, BigInt(run.cost), ...tail] })
        : this._send({ to: run.wallet, abi, functionName: 'chargeAndSettle', args: [run.id, BigInt(run.cost), upTo, ...tail] });
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
