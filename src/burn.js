// Featuring an agent by burning $LUX: the parts that need no network and no database, so they can be
// tested with plain node (test/burn.test.mjs). A burn is an ordinary ERC-20 transfer of $LUX to the dead
// address. Nothing here holds anyone's tokens and no contract of ours is involved.
export const DEAD = '0x000000000000000000000000000000000000dEaD';
export const LUX_DEFAULT = '0x1640D5b6CfBDDABBDE8ae2401F7D4ec5A2026951';
// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const UNIT = 10n ** 18n; // $LUX has 18 decimals

// transfer(address,uint256)
export const TRANSFER_SELECTOR = '0xa9059cbb';
const positiveInt = (v, fallback) => (/^[1-9]\d{0,17}$/.test(String(v ?? '').trim()) ? String(v).trim() : fallback);

// What featuring costs, from the Worker's vars: the token, whole tokens per period, days per period, and
// the first block a burn may come from (burns made before featuring opened are not accepted).
// FEATURE_FROM_BLOCK has no default: until it is set, fromBlock is null, `open` is false and nothing is accepted.
export function luxConfig(env = {}) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(String(env.LUX || '')) ? String(env.LUX) : LUX_DEFAULT;
  return {
    address, burnAddress: DEAD,
    featureAmount: positiveInt(env.FEATURE_LUX, '100000'),
    featureDays: Number(positiveInt(env.FEATURE_DAYS, '7')),
    fromBlock: positiveInt(env.FEATURE_FROM_BLOCK, null) == null ? null : BigInt(positiveInt(env.FEATURE_FROM_BLOCK, null)),
    open: positiveInt(env.FEATURE_FROM_BLOCK, null) != null,
  };
}

// Token units (18 decimals) as a plain number of tokens, with no trailing zeros: "100000", "150000.5".
export function wholeTokens(units) {
  const n = BigInt(units), frac = (n % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return (n / UNIT).toString() + (frac ? '.' + frac : '');
}

const lower = (v) => String(v ?? '').toLowerCase();
const topicAddress = (t) => (/^0x0{24}[0-9a-f]{40}$/.test(lower(t)) ? '0x' + lower(t).slice(26) : null);

// The calldata the agent's page sends: transfer(dead address, amount) followed by one more 32-byte word, the
// agent's number. The token ignores the extra word; here it says which agent the burn is for, so nobody can
// take someone else's burn and use it for another agent.
export const burnData = (cfg, units, agentId) =>
  TRANSFER_SELECTOR + lower(cfg.burnAddress || DEAD).slice(2).padStart(64, '0') + BigInt(units).toString(16).padStart(64, '0') + BigInt(agentId).toString(16).padStart(64, '0');

// Reads the transaction itself and says whether it is a burn made for this agent.
//   tx: null (not on chain yet) or { to, input }
// It must be sent straight to the $LUX contract, and its input must be exactly the transfer selector, the dead
// address, an amount and the agent's number: 4 + 96 bytes, nothing more and nothing less.
// Returns { ok: true } or { ok: false, reason } with reason one of 'missing', 'route', 'selector', 'unbound',
// 'length', 'recipient', 'agent'.
export function checkInput(tx, cfg, agentId) {
  if (!tx) return { ok: false, reason: 'missing' };
  if (lower(tx.to) !== lower(cfg.address)) return { ok: false, reason: 'route' };
  const input = lower(tx.input ?? tx.data);
  if (!/^0x([0-9a-f]{2})*$/.test(input) || input.slice(0, 10) !== TRANSFER_SELECTOR) return { ok: false, reason: 'selector' };
  const body = input.slice(10);
  if (body.length === 128) return { ok: false, reason: 'unbound' }; // a plain transfer: it names no agent
  if (body.length !== 192) return { ok: false, reason: 'length' };
  if (topicAddress('0x' + body.slice(0, 64)) !== lower(cfg.burnAddress || DEAD)) return { ok: false, reason: 'recipient' };
  if (BigInt('0x' + body.slice(128)) !== BigInt(agentId)) return { ok: false, reason: 'agent' };
  return { ok: true };
}

// Reads one transaction receipt and says what it burned.
//   receipt: null (not on chain yet) or { status, blockNumber, logs: [{ address, topics, data }] }
//   cfg:     luxConfig(env)
// Only Transfer events emitted by the $LUX contract itself, to the dead address, count; several in one
// transaction are added up. A token at any other address is ignored, whatever it calls itself.
// Returns { ok: true, value, burner, periods, days } or { ok: false, reason, value? } with reason one of
// 'missing', 'failed', 'early', 'none', 'small'.
export function checkBurn(receipt, cfg) {
  if (!receipt) return { ok: false, reason: 'missing' };
  if (receipt.status !== 'success' && receipt.status !== '0x1') return { ok: false, reason: 'failed' };
  // No first block set means featuring is not open: nothing counts.
  if (cfg.fromBlock == null || receipt.blockNumber == null || BigInt(receipt.blockNumber) < cfg.fromBlock) return { ok: false, reason: 'early' };
  const token = lower(cfg.address), dead = lower(cfg.burnAddress || DEAD);
  let value = 0n, burner = null;
  for (const l of receipt.logs || []) {
    if (l.removed || lower(l.address) !== token) continue;
    const t = l.topics || [];
    // An ERC-20 Transfer has exactly three topics and one 32-byte word of data.
    if (t.length !== 3 || lower(t[0]) !== TRANSFER_TOPIC || topicAddress(t[2]) !== dead) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(l.data))) continue;
    const v = BigInt(l.data); if (v === 0n) continue;
    value += v; burner ||= topicAddress(t[1]);
  }
  if (value === 0n) return { ok: false, reason: 'none' };
  const periods = value / (BigInt(cfg.featureAmount) * UNIT);
  if (periods < 1n) return { ok: false, reason: 'small', value };
  return { ok: true, value, burner, periods: Number(periods), days: Number(periods) * cfg.featureDays };
}
