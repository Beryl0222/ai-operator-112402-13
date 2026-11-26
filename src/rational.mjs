// Exact binary-rational helpers.
// A rational is represented as n * 2 ** e, where n is a BigInt and e is a
// safe integer.  This is sufficient for every wire constant in the project:
// mantissas, signed block exponents, and [numerator, binaryExponent] scales.

/**
 * @typedef {{ n: bigint, e: number }} BinaryRational
 */

/**
 * @param {bigint|number|string} n
 * @param {number} e
 * @returns {BinaryRational}
 */
export function bin(n = 0n, e = 0) {
  return { n: BigInt(n), e: Number(e) };
}

/** @param {[number|bigint|string, number]} pair */
export function fromPair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    throw new TypeError(`binary rational pair must have length 2: ${JSON.stringify(pair)}`);
  }
  return bin(pair[0], pair[1]);
}

/** @param {BinaryRational} a @param {BinaryRational} b */
export function add(a, b) {
  if (a.n === 0n) return { ...b };
  if (b.n === 0n) return { ...a };
  const e = Math.min(a.e, b.e);
  const an = a.n * (a.e >= e ? 1n << BigInt(a.e - e) : 0n);
  const bn = b.n * (b.e >= e ? 1n << BigInt(b.e - e) : 0n);
  return { n: an + bn, e };
}

/** @param {BinaryRational} a @param {BinaryRational} b */
export function sub(a, b) {
  return add(a, { n: -b.n, e: b.e });
}

/** @param {BinaryRational} a @param {BinaryRational} b */
export function mul(a, b) {
  return { n: a.n * b.n, e: a.e + b.e };
}

/** Multiply by an ordinary integer. @param {BinaryRational} a @param {number|bigint} k */
export function mulInt(a, k) {
  return { n: a.n * BigInt(k), e: a.e };
}

/** @param {BinaryRational} a */
export function abs(a) {
  return { n: a.n < 0n ? -a.n : a.n, e: a.e };
}

/** @param {BinaryRational} a @param {BinaryRational} b @returns {-1|0|1} */
export function cmp(a, b) {
  const d = sub(a, b);
  if (d.n < 0n) return -1;
  if (d.n > 0n) return 1;
  return 0;
}

/** @param {BinaryRational} a @param {BinaryRational} b */
export function max(a, b) {
  return cmp(a, b) >= 0 ? a : b;
}

/** @param {BinaryRational} a @param {BinaryRational} b */
export function min(a, b) {
  return cmp(a, b) <= 0 ? a : b;
}

/** Convert only when the requested operation needs a host number. @param {BinaryRational} a */
export function toNumber(a) {
  return Number(a.n) * 2 ** a.e;
}

/** Exact decimal-string to BinaryRational. @param {string} text */
export function fromDecimalText(text) {
  const s = String(text).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!match) {
    // Values such as Infinity are not quotas used here.
    return { n: BigInt(Math.trunc(Number(s))), e: 0 };
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const integer = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '');
  let n = digits === '' ? 0n : BigInt(digits);
  n *= sign;
  // decimal value = n * 10 ** (exponent - fraction.length)
  const tenExp = exponent - fraction.length;
  if (tenExp >= 0) {
    return { n: n * 10n ** BigInt(tenExp), e: 0 };
  }
  // n / 10**k is generally not binary.  Callers comparing with a binary
  // rational should use cmpDecimal; this helper preserves it as a decimal
  // rational instead.  Return a tagged decimal via toDecimalRational.
  return { decimalN: n, decimalExp: tenExp, n: 0n, e: 0 };
}

/**
 * Compare a binary rational with a finite JSON number exactly, using the
 * number's shortest decimal representation.
 * @param {BinaryRational} a
 * @param {number} number
 */
export function cmpNumber(a, number) {
  if (!Number.isFinite(number)) throw new RangeError(`cannot compare ${number}`);
  const text = Object.is(number, -0) ? '0' : String(number);
  const d = fromDecimalText(text);
  if ('decimalN' in d) {
    const k = -d.decimalExp;
    // Compare a.n*2^a.e with dN/10^k.  Normalize a to integer numerator at e=0
    // when possible; otherwise cross-multiply by a power of two.
    let an = a.n;
    let ae = a.e;
    if (ae < 0) {
      // an / 2^(-ae); compare an*10^k with dN*2^(-ae).
      const left = an * 10n ** BigInt(k);
      const right = d.decimalN * 2n ** BigInt(-ae);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    an *= 2n ** BigInt(ae);
    const left = an * 10n ** BigInt(k);
    const right = d.decimalN;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return cmp(a, d);
}

/**
 * Round r / 2**targetExponent to a signed integer mantissa using
 * round-to-nearest, ties-to-even.
 * @param {BinaryRational} r
 * @param {number} targetExponent
 */
export function roundToExponent(r, targetExponent) {
  const e = Number(targetExponent);
  if (r.e >= e) {
    const shift = BigInt(r.e - e);
    return r.n * (1n << shift);
  }
  const denominatorShift = BigInt(e - r.e);
  const d = 1n << denominatorShift;
  const negative = r.n < 0n;
  const absN = negative ? -r.n : r.n;
  let q = absN / d;
  const rem = absN % d;
  const twice = rem * 2n;
  if (twice > d) q += 1n;
  else if (twice === d && (q & 1n) === 1n) q += 1n;
  return negative ? -q : q;
}

/** Number-friendly nearest-even integer rounding. */
export function roundTiesEven(value, targetExponent = 0) {
  if (value && typeof value === 'object' && 'n' in value) {
    return roundToExponent(value, targetExponent);
  }
  const x = Number(value) / 2 ** Number(targetExponent);
  if (Number.isInteger(x)) return BigInt(x);
  const f = Math.floor(x);
  const d = x - f;
  let n = f;
  if (d > 0.5 || (d === 0.5 && Math.abs(f) % 2 === 1)) n = f + 1;
  return BigInt(n);
}

/** Quantize an ordinary Number for callers that do not need exact decimal I/O. */
export function quantizeNumber(value, exponent, bits) {
  const rounded = Number(roundTiesEven(value, exponent));
  const min = -(2 ** (bits - 1));
  const max = 2 ** (bits - 1) - 1;
  const mantissa = Math.max(min, Math.min(max, rounded));
  return {
    roundedMantissa: rounded,
    mantissa,
    exponent,
    bits,
    saturated: rounded < min || rounded > max,
    reconstructed: bin(mantissa, exponent),
  };
}

/**
 * Quantize a binary rational and return the stored mantissa, reconstructed
 * rational, and saturation flag for a signed two's-complement-style range.
 * @param {BinaryRational} r
 * @param {number} exponent
 * @param {6|10|8|number} bits
 */
export function quantizeRational(r, exponent, bits) {
  const min = -(2n ** BigInt(bits - 1));
  const max = 2n ** BigInt(bits - 1) - 1n;
  const rounded = roundToExponent(r, exponent);
  const saturated = rounded < min || rounded > max;
  const mantissa = rounded < min ? min : rounded > max ? max : rounded;
  return {
    roundedMantissa: Number(rounded),
    mantissa: Number(mantissa),
    exponent,
    bits,
    saturated,
    reconstructed: bin(mantissa, exponent),
  };
}

/** Exact sign category. @param {BinaryRational} r */
export function signOf(r) {
  if (r.n === 0n) return 'zero';
  return r.n < 0n ? 'negative' : 'positive';
}

/** Stable JSON representation of an exact rational. @param {BinaryRational} r */
export function rationalToJSON(r) {
  return { n: r.n.toString(), e: r.e, number: toNumber(r) };
}
