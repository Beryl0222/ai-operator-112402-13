import { readFileSync } from 'node:fs';
import { add, bin, fromPair, mul, roundToExponent, signOf, toNumber } from './rational.mjs';

/** Load a package that was written by solve.mjs. Accepts a path or parsed object. */
export function loadPackage(source) {
  if (typeof source === 'string' || source instanceof URL) {
    return JSON.parse(readFileSync(source, 'utf8'));
  }
  return source;
}

export function getTargetBlock(pkg, channel, block) {
  return pkg.targetTensor.blocks.find((b) => b.channel === channel && b.block === block)
    ?? pkg.blocks?.find((b) => b.channel === channel && b.block === block)
    ?? null;
}

export function getBlockAtSpatialPosition(pkg, channel, position) {
  const blockIndex = Math.floor(position / pkg.targetTensor.targetBlock);
  return getTargetBlock(pkg, channel, blockIndex);
}

export function expandBlock(block) {
  if (!block) throw new TypeError('block is required');
  const scale = 2 ** block.exponent;
  return block.mantissas.map((m) => m * scale);
}

export function expandChannel(pkg, channel) {
  const blocks = pkg.targetTensor.blocks
    .filter((b) => b.channel === channel)
    .sort((a, b) => a.block - b.block);
  const out = [];
  for (const block of blocks) {
    const values = expandBlock(block);
    block.positions.forEach((p, i) => {
      out[p] = values[i];
    });
  }
  return out;
}

/**
 * Recompute a weighted read solely from the serialized quantized tensor.  No
 * camera/source frame is required.
 */
export function reducePackageRead(pkg, channel, setIndex) {
  const data = pkg.wireConstants;
  const [readRow, positions] = data.protectedReadSets[setIndex];
  const weights = data.reads[readRow][1];
  const bound = data.readBounds[setIndex];
  const scale = fromPair(bound.coefficientScale ?? [1, 0]);
  const targetBlock = pkg.targetTensor.targetBlock;

  let sum = bin(0, 0);
  const terms = [];
  positions.forEach((p, i) => {
    const blockIndex = Math.floor(p / targetBlock);
    const local = p - blockIndex * targetBlock;
    const block = getTargetBlock(pkg, channel, blockIndex);
    if (!block) throw new Error(`package is missing c${channel}-b${blockIndex}`);
    const m = BigInt(block.mantissas[local] ?? 0);
    const term = bin(BigInt(weights[i]) * m, block.exponent);
    sum = add(sum, term);
    terms.push({ p, blockIndex, local, mantissa: block.mantissas[local], exponent: block.exponent, weight: weights[i] });
  });

  const scaled = mul(sum, scale);
  const fixedExponent = Math.min(...terms.map((t) => t.exponent + (bound.coefficientScale?.[1] ?? 0)), scaled.e);
  const fixedMantissa = roundToExponent(scaled, fixedExponent);
  return {
    channel,
    setIndex,
    readRow,
    readName: data.reads[readRow][0],
    boundId: bound.id,
    real: toNumber(scaled),
    exact: { numerator: scaled.n.toString(), exponent: scaled.e },
    fixedPoint: { mantissa: fixedMantissa.toString(), exponent: fixedExponent },
    sign: signOf(scaled),
    terms,
    evidence: pkg.readReports.find((r) => r.channel === channel && r.setIndex === setIndex) ?? null,
    layoutId: pkg.targetTensor.layoutId,
    constantsVersion: pkg.constantsVersion,
  };
}

export function reduceReferenceRead(pkg, setIndex) {
  return reducePackageRead(pkg, pkg.referenceChannel ?? 0, setIndex);
}

export function reduceTupleScopedRead(pkg, setIndex) {
  const channel = pkg.wireConstants.protectedReadSets[setIndex][0];
  return reducePackageRead(pkg, channel, setIndex);
}

/** Return the stored evidence report without touching the source frame. */
export function getReadEvidence(pkg, channel, setIndex) {
  return pkg.readReports.find((r) => r.channel === channel && r.setIndex === setIndex) ?? null;
}

export function describeBlockResult(pkg, blockOrId) {
  const block = typeof blockOrId === 'string'
    ? pkg.targetTensor.blocks.find((b) => b.id === blockOrId)
    : blockOrId;
  if (!block) return null;
  return {
    id: block.id,
    layoutId: block.layout ?? pkg.targetTensor.layoutId,
    packageFormat: pkg.packageFormat,
    constantsVersion: pkg.constantsVersion,
    exponent: block.exponent,
    bits: block.bits,
    precision: block.precision,
    certified: block.certified,
    status: block.status,
  };
}
