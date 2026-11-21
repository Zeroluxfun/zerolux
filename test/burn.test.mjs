// Run with: node --test test/burn.test.mjs
// Checks how a transaction receipt is read as a $LUX burn (src/burn.js). No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBurn, checkInput, burnData, luxConfig, wholeTokens, DEAD, LUX_DEFAULT, TRANSFER_TOPIC } from '../src/burn.js';

const cfg = luxConfig({ FEATURE_FROM_BLOCK: '100' });
const UNIT = 10n ** 18n;
const topic = (addr) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const data = (tokens) => '0x' + (BigInt(Math.round(tokens * 1000)) * UNIT / 1000n).toString(16).padStart(64, '0');
const BURNER = '0x1111111111111111111111111111111111111111';
const FAKE = '0x2222222222222222222222222222222222222222';
const log = (tokens, { address = LUX_DEFAULT, from = BURNER, to = DEAD } = {}) => ({ address, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: data(tokens) });
const receipt = (logs, extra = {}) => ({ status: 'success', blockNumber: 500n, logs, ...extra });

test('config: defaults, and vars override them', () => {
  assert.deepEqual(luxConfig({}), { address: LUX_DEFAULT, burnAddress: DEAD, featureAmount: '100000', featureDays: 7, fromBlock: null, open: false });
  assert.deepEqual(luxConfig({ LUX: FAKE, FEATURE_LUX: '250', FEATURE_DAYS: '3', FEATURE_FROM_BLOCK: '42' }), { address: FAKE, burnAddress: DEAD, featureAmount: '250', featureDays: 3, fromBlock: 42n, open: true });
  for (const bad of ['', '0', 'abc', '-5', '1.5']) assert.equal(luxConfig({ FEATURE_FROM_BLOCK: bad }).open, false, bad);
  assert.equal(luxConfig({ FEATURE_LUX: '0', FEATURE_DAYS: '-1' }).featureAmount, '100000');
  assert.equal(luxConfig({ FEATURE_LUX: 'abc', FEATURE_DAYS: '1.5' }).featureDays, 7);
});

test('a correct burn buys one period', () => {
  const r = checkBurn(receipt([log(100000)]), cfg);
  assert.deepEqual(r, { ok: true, value: 100000n * UNIT, burner: BURNER, periods: 1, days: 7 });
});

test('a raw receipt with status 0x1 and a mixed-case token address counts', () => {
  const r = checkBurn({ status: '0x1', blockNumber: '0x100', logs: [log(100000, { address: LUX_DEFAULT.toUpperCase().replace('0X', '0x') })] }, cfg);
  assert.equal(r.ok, true);
});

test('wrong token address: a fake token does not count', () => {
  assert.deepEqual(checkBurn(receipt([log(100000, { address: FAKE })]), cfg), { ok: false, reason: 'none' });
  // a fake token beside a real burn that is too small does not top it up
  const r = checkBurn(receipt([log(99999, {}), log(5000000, { address: FAKE })]), cfg);
  assert.equal(r.ok, false); assert.equal(r.reason, 'small'); assert.equal(r.value, 99999n * UNIT);
});

test('wrong recipient: a transfer to anyone but the dead address does not count', () => {
  assert.deepEqual(checkBurn(receipt([log(100000, { to: BURNER })]), cfg), { ok: false, reason: 'none' });
  assert.deepEqual(checkBurn(receipt([log(100000, { to: '0x0000000000000000000000000000000000000000' })]), cfg), { ok: false, reason: 'none' });
  // dirt in the top bytes of the recipient word is not the dead address
  const dirty = log(100000); dirty.topics[2] = '0x01' + dirty.topics[2].slice(4);
  assert.deepEqual(checkBurn(receipt([dirty]), cfg), { ok: false, reason: 'none' });
});

test('other events from the token do not count', () => {
  const approval = log(100000); approval.topics[0] = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const nft = log(100000); nft.topics.push(topic(BURNER)); // four topics is an ERC-721 Transfer, not ERC-20
  const removed = { ...log(100000), removed: true };
  assert.deepEqual(checkBurn(receipt([approval, nft, removed]), cfg), { ok: false, reason: 'none' });
});

test('amount too small', () => {
  const r = checkBurn(receipt([log(99999.999)]), cfg);
  assert.equal(r.ok, false); assert.equal(r.reason, 'small'); assert.equal(wholeTokens(r.value), '99999.999');
});

test('a failed transaction does not count, whatever its logs say', () => {
  assert.deepEqual(checkBurn(receipt([log(100000)], { status: 'reverted' }), cfg), { ok: false, reason: 'failed' });
  assert.deepEqual(checkBurn(receipt([log(100000)], { status: '0x0' }), cfg), { ok: false, reason: 'failed' });
});

test('two burns in one transaction are added up', () => {
  const r = checkBurn(receipt([log(60000), log(1, { address: FAKE }), log(40000, { from: FAKE })]), cfg);
  assert.equal(r.ok, true); assert.equal(r.value, 100000n * UNIT); assert.equal(r.periods, 1); assert.equal(r.burner, BURNER);
});

test('a larger burn buys several whole periods', () => {
  const r = checkBurn(receipt([log(350000)]), cfg);
  assert.deepEqual(r, { ok: true, value: 350000n * UNIT, burner: BURNER, periods: 3, days: 21 });
  assert.equal(checkBurn(receipt([log(500)]), luxConfig({ FEATURE_LUX: '250', FEATURE_DAYS: '3', FEATURE_FROM_BLOCK: '100' })).days, 6);
});

test('a missing receipt is reported as missing', () => {
  assert.deepEqual(checkBurn(null, cfg), { ok: false, reason: 'missing' });
  assert.deepEqual(checkBurn(undefined, cfg), { ok: false, reason: 'missing' });
});

test('a burn from before featuring opened is refused', () => {
  const late = luxConfig({ FEATURE_FROM_BLOCK: '501' });
  assert.deepEqual(checkBurn(receipt([log(100000)]), late), { ok: false, reason: 'early' });
  assert.equal(checkBurn(receipt([log(100000)], { blockNumber: 501n }), late).ok, true);
  assert.deepEqual(checkBurn(receipt([log(100000)], { blockNumber: undefined }), late), { ok: false, reason: 'early' });
});

test('with no first block set, featuring is closed and no burn counts', () => {
  assert.deepEqual(checkBurn(receipt([log(100000)]), luxConfig({})), { ok: false, reason: 'early' });
});

// ---- the transaction input: which agent a burn is for ----
const AMOUNT = 100000n * UNIT;
const sent = (input, to = LUX_DEFAULT) => ({ to, input });

test('input: the calldata the page builds is transfer(dead, amount) plus the agent number', () => {
  assert.equal(burnData(cfg, AMOUNT, 7), '0xa9059cbb' + '000000000000000000000000000000000000dead'.padStart(64, '0') + AMOUNT.toString(16).padStart(64, '0') + '7'.padStart(64, '0'));
  assert.equal((burnData(cfg, AMOUNT, 7).length - 2) / 2, 4 + 96);
});

test('input: the right agent id is accepted', () => {
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7)), cfg, 7), { ok: true });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 0)), cfg, 0), { ok: true });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7).toUpperCase().replace('0X', '0x'), LUX_DEFAULT.toLowerCase()), cfg, 7), { ok: true });
});

test('input: another agent\'s id is refused', () => {
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 8)), cfg, 7), { ok: false, reason: 'agent' });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7)), cfg, 0), { ok: false, reason: 'agent' });
  // an id with dirt in its top bytes is a different number
  const dirty = burnData(cfg, AMOUNT, 7); assert.deepEqual(checkInput(sent(dirty.slice(0, 138) + '01' + dirty.slice(140)), cfg, 7), { ok: false, reason: 'agent' });
});

test('input: a plain transfer with no agent word is refused', () => {
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7).slice(0, -64)), cfg, 7), { ok: false, reason: 'unbound' });
});

test('input: extra junk after the agent word, or a cut-off word, is refused', () => {
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7) + '00'), cfg, 7), { ok: false, reason: 'length' });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7) + '7'.padStart(64, '0')), cfg, 7), { ok: false, reason: 'length' });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7).slice(0, -2)), cfg, 7), { ok: false, reason: 'length' });
  assert.deepEqual(checkInput(sent('0xa9059cbb'), cfg, 7), { ok: false, reason: 'length' });
});

test('input: a wrong selector is refused', () => {
  assert.deepEqual(checkInput(sent('0x23b872dd' + burnData(cfg, AMOUNT, 7).slice(10)), cfg, 7), { ok: false, reason: 'selector' });
  assert.deepEqual(checkInput(sent('0x'), cfg, 7), { ok: false, reason: 'selector' });
  assert.deepEqual(checkInput(sent(undefined), cfg, 7), { ok: false, reason: 'selector' });
  assert.deepEqual(checkInput(sent('0xa9059cbbzz'), cfg, 7), { ok: false, reason: 'selector' });
});

test('input: a transaction not sent to the token (routed through another contract) is refused', () => {
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7), FAKE), cfg, 7), { ok: false, reason: 'route' });
  assert.deepEqual(checkInput(sent(burnData(cfg, AMOUNT, 7), null), cfg, 7), { ok: false, reason: 'route' }); // a contract creation
});

test('input: the recipient in the calldata must be the dead address', () => {
  const d = burnData(cfg, AMOUNT, 7);
  assert.deepEqual(checkInput(sent(d.slice(0, 10) + BURNER.slice(2).padStart(64, '0') + d.slice(74)), cfg, 7), { ok: false, reason: 'recipient' });
});

test('input: a transaction that is not on chain yet is reported as missing', () => {
  assert.deepEqual(checkInput(null, cfg, 7), { ok: false, reason: 'missing' });
});

test('whole tokens are written without trailing zeros', () => {
  assert.equal(wholeTokens(0n), '0');
  assert.equal(wholeTokens(100000n * UNIT), '100000');
  assert.equal(wholeTokens((3n * UNIT) / 2n), '1.5');
  assert.equal(wholeTokens('1'), '0.000000000000000001');
});
