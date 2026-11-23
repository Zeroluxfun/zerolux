// The calculator agents use. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, calculate } from '../src/calc.js';

test('the calculator gets ordinary sums right', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('-2 ^ 2'), -4);
  assert.equal(evaluate('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluate('2 ^ -1'), 0.5);
  assert.equal(evaluate('0.1 + 0.2'), 0.3);
  assert.equal(evaluate('10 % 4'), 2);
  assert.equal(evaluate('1.5e3 / 3'), 500);
  assert.equal(evaluate('round(1200 * 1.07 ^ 5)'), 1683);
  assert.equal(evaluate('max(3, sqrt(16), 2)'), 4);
  assert.equal(evaluate('PI'), Math.PI.toPrecision(15) * 1);
});

test('the calculator refuses what is not arithmetic', () => {
  for (const bad of ['', '2 +', '(1 + 2', '1 / 0', 'constructor(1)', 'toString', 'process.exit(1)', '1; 2', 'a = 1', '__proto__(1)', 'sqrt()', '2 2', 'x'.repeat(400)]) assert.throws(() => evaluate(bad), bad);
});

test('calculate answers each line and never throws', () => {
  assert.equal(calculate({ expressions: ['1+1', 'nope('] }).split('\n').length, 2);
  assert.match(calculate({ expressions: ['2*21'] }), /= 42$/);
  assert.match(calculate({}), /Give expressions/);
  assert.match(calculate({ expressions: ['<b>1</b>'] }), /^b1\/b/);
});

