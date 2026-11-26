import { evaluateCandidate, selectBestEffort, selectCheapestFeasible } from './blocks.mjs';
import { add, bin, mulInt, toNumber } from './rational.mjs';

/**
 * Solve the compact calibration tile.  Its `targetBlock` is a block size (3),
 * so four left-to-right records form a full block of three and a true
 * one-element remainder block.
 */
export function solveSmallTile(data, options = {}) {
  const tile = data.smallTile;
  const size = tile.targetBlock;
  const blockCount = Math.ceil(tile.records.length / size);
  const missingPolicy = options.missingPolicy ?? 'strict-interval';

  const blocks = Array.from({ length: blockCount }, (_, b) => {
    const slice = tile.records.slice(b * size, Math.min(tile.records.length, (b + 1) * size));
    const points = slice.map(([m, e, valid], localIndex) => {
      let interval;
      if (valid) {
        const r = bin(m, e);
        interval = { lo: r, hi: r, bounded: true };
      } else if (missingPolicy === 'zero') {
        const r = bin(0, 0);
        interval = { lo: r, hi: r, bounded: true };
      } else if (missingPolicy === 'wire-code') {
        const r = bin(m, e);
        interval = { lo: r, hi: r, bounded: true };
      } else {
        interval = { lo: null, hi: null, bounded: false };
      }
      return { p: b * size + localIndex, valid: !!valid, interval };
    });

    const residue = b % data.candidates.length;
    const exponents = data.candidates[residue];
    const quota = data.blockAbs[residue];
    const candidates = exponents.flatMap((exponent, ordinal) => [6, 10].map((bits) => {
      const result = evaluateCandidate(points, exponent, bits, quota);
      result.candidateRow = residue;
      result.candidateOrdinal = ordinal;
      return result;
    }));
    const feasible = selectCheapestFeasible(candidates);
    const selected = feasible ?? selectBestEffort(candidates.filter((c) => c.bits === 6));
    return {
      block: b,
      residue,
      priority: tile.priorities?.[b] ?? null,
      positions: points.map((p) => p.p),
      exponent: selected.exponent,
      bits: selected.bits,
      mantissas: selected.mantissas,
      valid: slice.map(([, , valid]) => !!valid),
      linf: selected.linf,
      quota,
      feasible: !!feasible,
      extensionBytes: selected.extensionBytes,
      candidates: candidates.map((c) => ({ exponent: c.exponent, bits: c.bits, linf: c.linf, feasible: c.strictFeasible })),
    };
  });

  // Weighted fixed-point sum of the selected calibration representation.
  let sum = bin(0, 0);
  tile.weights.forEach((w, i) => {
    const b = Math.floor(i / size);
    const local = i % size;
    const block = blocks[b];
    if (!block) return;
    const m = BigInt(block.mantissas[local] ?? 0);
    sum = add(sum, bin(BigInt(w) * m, block.exponent));
  });

  const wireCodesWeightedReal = tile.records.reduce((acc, [m, e], i) => acc + tile.weights[i] * m * 2 ** e, 0);
  const knownSum = tile.records.reduce((acc, [m, e, valid], i) => {
    if (!valid && missingPolicy !== 'zero' && missingPolicy !== 'wire-code') return acc;
    const value = valid || missingPolicy === 'wire-code' ? m * 2 ** e : 0;
    return acc + tile.weights[i] * value;
  }, 0);

  return {
    targetBlock: size,
    missingPolicy,
    weights: tile.weights,
    wireCodesWeightedReal,
    blocks,
    weightedMantissa: sum.n.toString(),
    weightedExponent: sum.e,
    weightedReal: toNumber(sum),
    knownSourceWeightedReal: knownSum,
    sign: sum.n === 0n ? 'zero' : sum.n < 0n ? 'negative' : 'positive',
  };
}
