// Exact arithmetic for agents (the calculate tool). No network, no eval: a small parser.
// A model that does sums in its head gets them wrong. This works them out: + - * / % ^, brackets, and a few functions.

const FN = {
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONST = { pi: Math.PI, e: Math.E };

export const CALC_DEF = {
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Work out arithmetic exactly. Give expressions as a list of strings, for example ["1200 * 1.07 ^ 5", "(84.5 - 61.2) / 61.2 * 100"]. Allowed: numbers, + - * / % (remainder) ^ (power), brackets, pi, e, and sqrt, abs, ln, log (base 10), exp, round, floor, ceil, min, max, pow. Use it for every sum that matters.',
    parameters: { type: 'object', properties: { expressions: { type: 'array', items: { type: 'string' } } }, required: ['expressions'] },
  },
};

export function evaluate(src) {
  const text = String(src);
  if (text.length > 300) throw new Error('too long');
  const toks = []; const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([-+*/^%(),]))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at; const m = re.exec(text);
    if (!m) throw new Error('cannot read "' + text.slice(at, at + 12).trim() + '"');
    toks.push(m[1] !== undefined ? { n: Number(m[1]) } : m[2] !== undefined ? { id: m[2].toLowerCase() } : { op: m[3] });
    at = re.lastIndex;
  }
  let i = 0, depth = 0;
  const is = (op) => toks[i]?.op === op;
  const expr = () => { let v = term(); while (is('+') || is('-')) v = toks[i++].op === '+' ? v + term() : v - term(); return v; };
  const term = () => { let v = unary(); while (is('*') || is('/') || is('%')) { const op = toks[i++].op, r = unary(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; };
  const unary = () => { if (is('-')) { i++; return -unary(); } if (is('+')) { i++; return unary(); } return power(); };
  const power = () => { const b = primary(); if (is('^')) { i++; return Math.pow(b, unary()); } return b; };
  const primary = () => {
    if (++depth > 60) throw new Error('nested too deep');
    try {
      const t = toks[i++];
      if (!t) throw new Error('the expression ends early');
      if (t.n !== undefined) return t.n;
      if (t.op === '(') { const v = expr(); if (!is(')')) throw new Error('a bracket is not closed'); i++; return v; }
      if (t.id !== undefined) {
        if (is('(')) {
          if (!Object.hasOwn(FN, t.id)) throw new Error('unknown function ' + t.id);
          i++; const args = [];
          if (!is(')')) { args.push(expr()); while (is(',')) { i++; args.push(expr()); } }
          if (!is(')')) throw new Error('a bracket is not closed'); i++;
          if (!args.length || args.length > 8) throw new Error(t.id + ' needs between one and eight values');
          return FN[t.id](...args);
        }
        if (Object.hasOwn(CONST, t.id)) return CONST[t.id];
        throw new Error('unknown name ' + t.id);
      }
      throw new Error('unexpected "' + t.op + '"');
    } finally { depth--; }
  };
  const v = expr();
  if (i < toks.length) throw new Error('unexpected "' + (toks[i].op ?? toks[i].id ?? toks[i].n) + '"');
  if (!Number.isFinite(v)) throw new Error('the result is not a finite number');
  return Number(v.toPrecision(15));
}

export function calculate(a) {
  const list = (Array.isArray(a?.expressions) ? a.expressions : [a?.expression]).filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
  if (!list.length) return 'Give expressions as a list of strings, for example ["1200 * 1.07 ^ 5"].';
  return list.map((src) => { const shown = src.slice(0, 120).replace(/[^\x20-\x7e]/g, '').replace(/[<>]/g, '').trim(); try { return shown + ' = ' + evaluate(src); } catch (e) { return shown + ' : could not be worked out (' + e.message + ')'; } }).join('\n');
}

