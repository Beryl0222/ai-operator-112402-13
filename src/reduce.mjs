import {
  abs,
  add,
  bin,
  cmp,
  cmpNumber,
  fromPair,
  mul,
  mulInt,
  roundToExponent,
  signOf,
  sub,
  toNumber,
} from './rational.mjs';

const ZERO = bin(0, 0);

function classFromInterval(min, max) {
  const minCmp = cmp(min, ZERO);
  const maxCmp = cmp(max, ZERO);
  if (minCmp === 0 && maxCmp === 0) return 'zero';
  if (minCmp > 0) return 'positive';
  if (maxCmp < 0) return 'negative';
  if (minCmp < 0 && maxCmp > 0) return 'mixed';
  if (minCmp === 0 && maxCmp > 0) return 'nonNegative';
  if (minCmp < 0 && maxCmp === 0) return 'nonPositive';
  return 'mixed';
}

function signGuaranteeFor(sourceClass, outputSign) {
  switch (sourceClass) {
    case 'positive':
      return outputSign === 'positive';
    case 'negative':
      return outputSign === 'negative';
    case 'zero':
      return outputSign === 'zero';
    case 'nonNegative':
      return outputSign !== 'negative';
    case 'nonPositive':
      return outputSign !== 'positive';
    default:
      return false;
  }
}

function rationalJSON(r) {
  return { numerator: r.n.toString(), exponent: r.e, real: toNumber(r) };
}

/**
 * Evaluate one protected weighted read using one shared representation per
 * target block.  The source side is an endpoint interval envelope; the output
 * side is the actual quantized package tensor.
 */
export function evaluateRead({
  data,
  frame,
  channel,
  setIndex,
  representations,
  targetBlock = data.targetBlock,
}) {
  const [readRow, positions] = data.protectedReadSets[setIndex];
  const weights = data.reads[readRow][1];
  const readName = data.reads[readRow][0];
  const bound = data.readBounds[setIndex];
  const coefficientScale = fromPair(bound.coefficientScale ?? [1, 0]);
  const firstPoint = frame?.pointsByChannel?.[channel]?.[positions[0]];
  const offsetPair = firstPoint?.offsetPair ?? data.scale?.[channel % data.scale.length] ?? [0, 0];
  const channelOffset = fromPair(offsetPair);
  const weightSum = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  const offsetRawContribution = mulInt(channelOffset, weightSum);
  const offsetScaledContribution = mul(offsetRawContribution, coefficientScale);

  let sourceMin = bin(0, 0);
  let sourceMax = bin(0, 0);
  let sourceBounded = true;
  /** @type {any[]} */
  const dependencies = [];
  const blockSet = new Set();

  positions.forEach((p, i) => {
    const w = BigInt(weights[i]);
    const point = frame.pointsByChannel[channel][p];
    const interval = point.interval;
    const blockIndex = Math.floor(p / targetBlock);
    const localIndex = p - blockIndex * targetBlock;
    const positionPriority = data.priority?.[i] ?? null;
    blockSet.add(blockIndex);
    dependencies.push({ p, coefficientIndex: i, priority: positionPriority, weight: weights[i], blockIndex, localIndex, valid: point.valid });

    // A missing/unbounded datum has no effect when its signed coefficient is
    // zero.  This is the reduction-side "missing item does not matter" case.
    if (w === 0n) return;
    if (!interval.bounded) {
      sourceBounded = false;
      return;
    }
    if (w >= 0n) {
      sourceMin = add(sourceMin, mulInt(interval.lo, w));
      sourceMax = add(sourceMax, mulInt(interval.hi, w));
    } else {
      sourceMin = add(sourceMin, mulInt(interval.hi, w));
      sourceMax = add(sourceMax, mulInt(interval.lo, w));
    }
  });

  let outputRaw = bin(0, 0);
  let outputAvailable = true;
  for (const dep of dependencies) {
    const repr = representations?.[dep.blockIndex];
    if (!repr) {
      outputAvailable = false;
      continue;
    }
    const m = BigInt(repr.mantissas[dep.localIndex] ?? 0);
    outputRaw = add(outputRaw, bin(BigInt(dep.weight) * m, repr.exponent));
  }

  let worstRawError = null;
  if (sourceBounded && outputAvailable) {
    const rawErrMin = abs(sub(outputRaw, sourceMin));
    const rawErrMax = abs(sub(outputRaw, sourceMax));
    worstRawError = cmp(rawErrMin, rawErrMax) >= 0 ? rawErrMin : rawErrMax;
  }

  const sourceScaledMin = mul(sourceMin, coefficientScale);
  let sourceScaledMax = mul(sourceMax, coefficientScale);
  let scaledMin = sourceScaledMin;
  let scaledMax = sourceScaledMax;
  if (cmp(scaledMin, scaledMax) > 0) [scaledMin, scaledMax] = [scaledMax, scaledMin];
  const outputScaled = mul(outputRaw, coefficientScale);
  const outputRawNumber = outputAvailable ? toNumber(outputRaw) : null;

  let worstAbsError = null;
  let absErrorNumber = null;
  if (sourceBounded && outputAvailable) {
    if (worstRawError) {
      const absScale = coefficientScale.n < 0n ? { n: -coefficientScale.n, e: coefficientScale.e } : coefficientScale;
      worstAbsError = mul(worstRawError, absScale);
    }
    absErrorNumber = toNumber(worstAbsError);
  }

  const sourceClass = sourceBounded ? classFromInterval(scaledMin, scaledMax) : 'unknown';
  const outputClass = outputAvailable ? signOf(outputScaled) : 'unknown';
  const signGuaranteed = sourceBounded && outputAvailable && signGuaranteeFor(sourceClass, outputClass);
  const signRequired = bound.rule === 'sign';

  let absoluteSatisfied = null;
  if (bound.maxAbs !== null && bound.maxAbs !== undefined && worstAbsError) {
    absoluteSatisfied = cmpNumber(worstAbsError, bound.maxAbs) <= 0;
  }

  // Worst-case relative error.  It is finite only when the envelope does not
  // approach zero; exact zero originals fall back to absolute error only.
  let relativeErrorBound = null;
  let relativeSatisfied = null;
  const threshold = bound.relativeEnergy ?? null;
  const exactZeroEnvelope = sourceBounded && cmp(scaledMin, ZERO) === 0 && cmp(scaledMax, ZERO) === 0;
  if (threshold !== null && sourceBounded && worstAbsError) {
    if (exactZeroEnvelope) {
      relativeErrorBound = 0;
      relativeSatisfied = true;
    } else if (cmp(scaledMin, ZERO) <= 0 && cmp(scaledMax, ZERO) >= 0) {
      relativeErrorBound = Number.POSITIVE_INFINITY;
      relativeSatisfied = false;
    } else {
      const endpoints = [scaledMin, scaledMax].map((r) => {
        const error = abs(sub(outputScaled, r));
        // |error| / |r| = (error.n * 2^error.e) / (abs(r).n * 2^r.e)
        const ar = r.n < 0n ? { n: -r.n, e: r.e } : r;
        return (toNumber(error) / toNumber(ar));
      });
      relativeErrorBound = Math.max(...endpoints);
      relativeSatisfied = relativeErrorBound <= threshold + 1e-15;
    }
  }

  // Exact fixed-point accumulator at the finest exponent touched by the sum.
  let fixedPoint = null;
  if (outputAvailable) {
    const termExponents = dependencies.map((d) => {
      const repr = representations[d.blockIndex];
      return repr.exponent + (bound.coefficientScale?.[1] ?? 0);
    });
    const fixedExponent = Math.min(...termExponents, outputScaled.e);
    const fixedMantissa = roundToExponent(outputScaled, fixedExponent);
    fixedPoint = {
      mantissa: fixedMantissa.toString(),
      exponent: fixedExponent,
      real: toNumber(outputScaled),
    };
  }

  const levelRequired = bound.rule === 'linear-error';
  const usable =
    sourceBounded &&
    outputAvailable &&
    (!signRequired || signGuaranteed) &&
    (!levelRequired || absoluteSatisfied === true) &&
    (!levelRequired || relativeSatisfied !== false);

  return {
    channel,
    setIndex,
    readRow,
    readName,
    boundId: bound.id,
    rule: bound.rule,
    signRequired,
    levelRequired,
    positions,
    weights,
    blockIndices: [...blockSet].sort((a, b) => a - b),
    coefficientScale: bound.coefficientScale,
    offsetApplied: firstPoint?.offsetApplied ?? true,
    offsetPair,
    weightCoefficientSum: weightSum.toString(),
    offsetRawContribution: toNumber(offsetRawContribution),
    offsetScaledContribution: toNumber(offsetScaledContribution),
    sourceBounded,
    sourceSign: sourceClass,
    outputSign: outputClass,
    signGuaranteed,
    rawAbsoluteError: worstRawError ? toNumber(worstRawError) : null,
    absoluteError: absErrorNumber,
    absoluteErrorExact: worstAbsError ? rationalJSON(worstAbsError) : null,
    maxAbs: bound.maxAbs ?? null,
    absoluteSatisfied,
    relativeError: relativeErrorBound,
    relativeEnergy: threshold,
    relativeSatisfied,
    sourceInterval: sourceBounded
      ? { min: rationalJSON(scaledMin), max: rationalJSON(scaledMax) }
      : null,
    outputReal: outputAvailable ? toNumber(outputScaled) : null,
    outputExact: outputAvailable ? rationalJSON(outputScaled) : null,
    rawOutputReal: outputRawNumber,
    rawOutputExact: outputAvailable ? rationalJSON(outputRaw) : null,
    fixedPoint,
    usable,
    rejected: !usable,
    dependencies,
  };
}
