// Locking $LUX for a lower fee.
//
// LuxLocker (contracts/src/LuxLocker.sol) holds $LUX for a wallet until a date that wallet chose. It has no owner: nobody
// can take a position out early, and its date can only be moved later. This file reads it.
//
// The rule: when an agent is built, the wallet that will own it is looked up in the locker. If it has enough $LUX in a
// position that stays locked for at least LOCK_MIN_DAYS more days, the agent's wallet contract is made with a lower fee
// rate than the standard one. A version 4 wallet's fee rate is fixed when it is made and can only ever go down
// (AgentWalletV4.markupBps), so the agent keeps that rate for life, whatever happens to the lock afterwards. Agents
// that already exist are not changed.
import { parseAbi, getAddress, isAddress } from 'viem';
import { reader } from './chain.js';
import { json, allow, clientKey } from './line.js';
import { luxConfig, wholeTokens } from './burn.js';

// Whole $LUX locked, and the fee rate (basis points of a run's cost) an agent built by that wallet gets. Largest first.
export const LOCK_TIERS = [
  { lux: 5_000_000, bps: 1000 },
  { lux: 1_000_000, bps: 1500 },
];
export const LOCK_MIN_DAYS = 90;
const UNIT = 10n ** 18n;

export const lockerAbi = parseAbi([
  'function locked(address account) view returns (uint256 amount, uint64 unlockAt)',
  'function lockedUntil(address account, uint64 time) view returns (uint256)',
  'function totalLocked() view returns (uint256)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)']);

export const lockerOf = (env) => (/^0x[0-9a-fA-F]{40}$/.test(String(env.LOCKER || '')) ? getAddress(env.LOCKER) : null);
// The fee rate for an amount (token units) that stays locked long enough. Never above the standard rate.
export function feeForLocked(units, standardBps) {
  const std = Number(standardBps);
  for (const t of LOCK_TIERS) if (BigInt(units) >= BigInt(t.lux) * UNIT) return Math.min(std, t.bps);
  return std;
}
// The moment a position has to reach to count: LOCK_MIN_DAYS from now, in chain seconds.
const mustReach = (now = Date.now()) => BigInt(Math.floor(now / 1000) + LOCK_MIN_DAYS * 86_400);

// The fee rate a new agent owned by `owner` gets. Throws if the chain cannot be read: the caller must not guess, because
// a rate, once given, is for the life of the agent.
export async function feeFor(env, owner, version) {
  const std = Number(env.MARKUP_BPS), locker = lockerOf(env);
  if (!(version >= 4) || !locker) return std;
  const units = await reader(env).readContract({ address: locker, abi: lockerAbi, functionName: 'lockedUntil', args: [getAddress(owner), mustReach()] });
  return feeForLocked(units, std);
}

// What the pages say about the tiers. No chain read.
export const lockConfig = (env) => ({
  locker: lockerOf(env), standardBps: Number(env.MARKUP_BPS), minDays: LOCK_MIN_DAYS,
  tiers: LOCK_TIERS.map((t) => ({ lux: String(t.lux), feeBps: Math.min(Number(env.MARKUP_BPS), t.bps) })).reverse(),
});

// GET /api/lock/{address}: one wallet's $LUX, its position in the locker, and the fee rate an agent it built now would get.
export async function lockOf(request, env, address) {
  const locker = lockerOf(env);
  if (!locker) return json({ error: 'Locking is not switched on.' }, 503);
  if (!isAddress(address)) return json({ error: 'That is not a wallet address.' }, 400);
  if (!(await allow(env, 'lock:' + clientKey(request), 600))) return json({ error: 'Too many lookups today. Come back tomorrow.' }, 429);
  const who = getAddress(address), lux = luxConfig(env).address, std = Number(env.MARKUP_BPS);
  let out;
  try {
    out = await reader(env).multicall({
      allowFailure: false,
      contracts: [
        { address: locker, abi: lockerAbi, functionName: 'locked', args: [who] },
        { address: locker, abi: lockerAbi, functionName: 'lockedUntil', args: [who, mustReach()] },
        { address: locker, abi: lockerAbi, functionName: 'totalLocked' },
        { address: lux, abi: erc20Abi, functionName: 'balanceOf', args: [who] },
        { address: lux, abi: erc20Abi, functionName: 'allowance', args: [who, locker] },
      ],
    });
  } catch { return json({ error: 'The chain is not answering. Try again in a minute.' }, 502); }
  const [[amount, unlockAt], counted, total, balance, allowance] = out;
  const fee = feeForLocked(counted, std);
  return json({
    address: who, locker, lux,
    // Token units (18 decimals) as strings, and the same as whole tokens for reading.
    balance: balance.toString(), allowance: allowance.toString(),
    locked: amount.toString(), locked_lux: wholeTokens(amount), unlock_at: Number(unlockAt) ? new Date(Number(unlockAt) * 1000).toISOString() : null,
    open: Number(unlockAt) > 0 && Number(unlockAt) * 1000 <= Date.now() && amount > 0n, // the date has passed: it can be withdrawn, and counts for nothing
    // What counts toward a lower fee: the position, if it stays locked for at least minDays more days.
    counted: counted.toString(), counted_lux: wholeTokens(counted), fee_bps: fee, standard_bps: std, discounted: fee < std,
    total_locked_lux: wholeTokens(total), ...lockConfig(env),
  }, 200, { 'cache-control': 'private, max-age=10' });
}
