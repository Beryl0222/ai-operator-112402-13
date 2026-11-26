import {
  abs,
  bin,
  cmp,
  cmpNumber,
  max as maxRat,
  quantizeRational,
  sub,
  toNumber,
} from './rational.mjs';

export const MANTISSA_BITS = Object.freeze({ normal: 6, extended: 10, source: 8 });

/** @param {number} validCount @param {number} [extraBitsPerPoint] */
export function extensionCostBits(validCount, extraBitsPerPoint = 4) {
  return extraBitsPerPoint * validCount;
}

/** @param {number} validCount */
export function extensionCostBytes(validCount) {
  return Math.ceil(extensionCostBits(validCount) / 8);
}

/**
 * Evaluate one exponent/precision pair against the endpoint envelope of every
 * point in a target block.
 *
 * @param {Array<any>} points
 * @param {number} exponent
 * @param {6|10} bits
 * @param {number|null|undefined} quota
 */
export function evaluateCandidate(points, exponent, bits, quota) {
  let validCount = 0;
  let boundedCount = 0;
  let saturatedCount = 0;
  let unboundedCount = 0;
  /** @type {import('./rational.mjs').BinaryRational|null} */
  let worstError = null;
  let worstErrorRat = null;
  let worstPoint = null;
  const mantissas = new Array(points.length);
  const roundedMantissas = new Array(points.length);

  points.forEach((point, index) => {
    const isValid = point.valid !== false;
    if (isValid) validCount++;
    const interval = point.interval ?? point;
    if (!interval?.bounded || !interval.lo || !interval.hi) {
      unboundedCount++;
      mantissas[index] = 0;
      roundedMantissas[index] = 0;
      return;
    }
    boundedCount++;
    const midSum = { n: interval.lo.n + interval.hi.n, e: interval.lo.e };
    // lo and hi were added with the same alignment in captureWireFrame; guard
    // against independently supplied intervals by normalizing through add().
    const mid = { n: midSum.n, e: midSum.e - 1 };
    const q = quantizeRational(mid, exponent, bits);
    mantissas[index] = q.mantissa;
    roundedMantissas[index] = q.roundedMantissa;
    if (q.saturated) saturatedCount++;

    const errLo = abs(sub(q.reconstructed, interval.lo));
    const errHi = abs(sub(q.reconstructed, interval.hi));
    const pointError = maxRat(errLo, errHi);
    if (!worstErrorRat || cmp(pointError, worstErrorRat) > 0) {
      worstError = pointError;
      worstErrorRat = pointError;
      worstPoint = {
        index,
        p: point.p ?? null,
        channel: point.channel ?? null,
        error: toNumber(pointError),
      };
    }
  });

  const linf = worstError ? toNumber(worstError) : Number.POSITIVE_INFINITY;
  const quotaSatisfied =
    quota !== null && quota !== undefined && unboundedCount === 0 && worstError !== null
      ? cmpNumber(worstError, quota) <= 0
      : false;
  const rangeFeasible = saturatedCount === 0;
  const strictFeasible = quotaSatisfied && rangeFeasible;
  const extBits = bits === 10 ? extensionCostBits(validCount) : 0;
  return {
    exponent,
    bits,
    precision: bits === 10 ? 'extended10' : 'normal6',
    validCount,
    boundedCount,
    unboundedCount,
    saturatedCount,
    rangeFeasible,
    mantissas,
    roundedMantissas,
    linf,
    worstPoint,
    worstErrorRat,
    quota: quota ?? null,
    quotaSatisfied,
    strictFeasible,
    extensionBits: extBits,
    extensionBytes: bits === 10 ? extensionCostBytes(validCount) : 0,
  };
}

/**
 * Build all target block descriptors for a parsed wire frame.  Target blocks
 * are every `targetBlock` positions in row-major (y then x) order within one
 * channel.  A block may cross a source-row boundary; each point retains its
 * own source exponent.
 */
export function buildTargetBlocks(data, frame) {
  const [channels, rows, width] = data.shape;
  const spatial = rows * width;
  const size = data.targetBlock;
  const perChannel = spatial / size;
  /** @type {any[]} */
  const blocks = [];
  for (let c = 0; c < channels; c++) {
    for (let b = 0; b < perChannel; b++) {
      const globalIndex = c * perChannel + b;
      const start = b * size;
      const end = Math.min(spatial, start + size);
      const positions = [];
      const points = [];
      for (let p = start; p < end; p++) {
        positions.push(p);
        points.push(frame.pointsByChannel[c][p]);
      }
      blocks.push({
        id: `c${c}-b${b}`,
        channel: c,
        indexInChannel: b,
        globalIndex,
        residue: globalIndex % data.candidates.length,
        start,
        end,
        positions,
        points,
        partial: end - start < size,
      });
    }
  }
  return blocks;
}

/** Evaluate every declared exponent/precision candidate for a block. */
export function evaluateBlockCandidates(data, block, quotaMode = 'row') {
  const row = block.residue;
  const exponents = data.candidates[row];
  const rowQuota = data.blockAbs[row];
  const candidates = [];
  exponents.forEach((exponent, ordinal) => {
    const quota = quotaMode === 'ordinal' ? data.blockAbs[ordinal] : rowQuota;
    for (const bits of [6, 10]) {
      const result = evaluateCandidate(block.points, exponent, bits, quota);
      result.candidateRow = row;
      result.candidateOrdinal = ordinal;
      result.quotaMode = quotaMode;
      result.rowQuota = rowQuota;
      result.ordinalQuota = data.blockAbs[ordinal];
      result.withinRowQuota =
        result.unboundedCount === 0 && result.worstErrorRat !== null
          ? cmpNumber(result.worstErrorRat, rowQuota) <= 0
          : false;
      result.withinOrdinalQuota =
        result.unboundedCount === 0 && result.worstErrorRat !== null
          ? cmpNumber(result.worstErrorRat, data.blockAbs[ordinal]) <= 0
          : false;
      if (quotaMode === 'ordinal') result.strictFeasible = result.withinOrdinalQuota && result.rangeFeasible;
      candidates.push(result);
    }
  });
  return candidates;
}

/**
 * Select the cheapest strict candidate.  Normal 6-bit is preferred; within a
 * precision the first declared exponent is returned (the contract permits any
 * feasible candidate at the same exponent/precision).
 */
export function selectCheapestFeasible(candidates) {
  const feasible = candidates.filter((c) => c.strictFeasible);
  if (feasible.length === 0) return null;
  return (
    feasible.find((c) => c.bits === 6) ??
    feasible.find((c) => c.bits === 10) ??
    null
  );
}

/** Best-effort choice when no strict candidate exists. */
export function selectBestEffort(candidates) {
  return [...candidates].sort((a, b) => {
    if (Number.isFinite(a.linf) && Number.isFinite(b.linf) && a.linf !== b.linf) {
      return a.linf - b.linf;
    }
    if (a.saturatedCount !== b.saturatedCount) return a.saturatedCount - b.saturatedCount;
    if (a.extensionBytes !== b.extensionBytes) return a.extensionBytes - b.extensionBytes;
    if (a.bits !== b.bits) return a.bits - b.bits;
    return a.candidateOrdinal - b.candidateOrdinal;
  })[0];
}

export function blockPriority(data, block) {
  return data.priority?.[block.residue] ?? 0;
}
