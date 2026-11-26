import { createHash } from 'node:crypto';
import { captureWireFrame, SingleShotCamera } from './frame.mjs';
import { recodeFrame } from './recode.mjs';
import { solveSmallTile } from './calibration.mjs';

export const PACKAGE_FORMAT = 'block-fp-interchange-package/v1';
export const CODEC_VERSION = '1.0.0';

function hashConstants(data) {
  const constants = {
    shape: data.shape,
    sourceBlock: data.sourceBlock,
    targetBlock: data.targetBlock,
    candidates: data.candidates,
    blockAbs: data.blockAbs,
    priority: data.priority,
    widths: { source: 8, normal: 6, extended: 10 },
    rounding: 'binary-nearest-even',
    reads: data.reads,
    readBounds: data.readBounds,
    protectedReadSets: data.protectedReadSets,
    coefficientScales: data.readBounds.map((r) => r.coefficientScale),
  };
  return createHash('sha256').update(stableStringify(constants)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',')}}`;
}

function sourceTensor(frame, data) {
  return {
    format: 'NCHW-channel-row-x-BFP8/v1',
    layoutId: 'channel-row-x-bfp8',
    shape: data.shape,
    sourceBlock: data.sourceBlock,
    mantissaBits: 8,
    exponentEncoding: 'signed-i8',
    minus128IsNumeric: true,
    validPlane: true,
    channelOffsetPairs: data.scale,
    planes: frame.planes,
  };
}

function producerFlags(data) {
  const flags = { missing: [], positiveSaturation: [], negativeSaturation: [], signedSaturation: [], tiny: [] };
  for (const mark of data.mark ?? []) {
    const [type, channel, spatialOffset] = mark;
    const item = { channel, spatialOffset };
    if (type === 'missing') flags.missing.push(item);
    else if (type === 'tiny') flags.tiny.push(item);
    else if (String(type).includes('saturation')) {
      flags.signedSaturation.push(item);
      const bound = data.markBounds?.find((b) => b[0] === channel && b[1] === spatialOffset);
      if (bound) {
        const [, , loMantissa, hiMantissa] = bound;
        if (hiMantissa <= 0) flags.negativeSaturation.push({ ...item, loMantissa, hiMantissa });
        else if (loMantissa >= 0) flags.positiveSaturation.push({ ...item, loMantissa, hiMantissa });
      }
    }
  }
  return flags;
}

/**
 * Build the serializable application package.  The package contains the actual
 * quantized tensor, reductions, exact/number error evidence, and layout/version
 * metadata needed after the source camera frame has been released.
 */
export function buildPackage(data, options = {}) {
  const frame = options.frame ?? captureWireFrame(data, {
    frameId: options.frameId ?? 'frame7',
    applyOffset: options.applyOffset,
  });
  const recoded = recodeFrame(data, frame, options);
  const constantsHash = hashConstants(data);
  const inputHash = options.inputSha256 ?? createHash('sha256').update(stableStringify(data)).digest('hex');
  for (const block of recoded.blockRecords) {
    block.packageFormat = PACKAGE_FORMAT;
    block.constantsVersion = `bfp-constants-${constantsHash.slice(0, 16)}`;
    block.constantsSha256 = constantsHash;
  }

  const constrainedReads = recoded.readReports
    .filter((r) => !r.packageUsable)
    .map((r) => ({
      type: 'protected-read',
      channel: r.channel,
      setIndex: r.setIndex,
      id: r.boundId,
      rule: r.rule,
      regionId: r.regionId,
      sourceSign: r.sourceSign,
      outputSign: r.outputSign,
      signGuaranteed: r.signGuaranteed,
      absoluteError: r.absoluteError,
      maxAbs: r.maxAbs,
      absoluteSatisfied: r.absoluteSatisfied,
      relativeError: r.relativeError,
      relativeSatisfied: r.relativeSatisfied,
    }));

  const signConstrainedReads = recoded.readReports
    .filter((r) => !r.signGuaranteed)
    .map((r) => ({
      type: 'protected-sign',
      channel: r.channel,
      setIndex: r.setIndex,
      id: r.boundId,
      rule: r.rule,
      sourceSign: r.sourceSign,
      outputSign: r.outputSign,
      regionId: r.regionId,
    }));
  const levelConstrainedReads = recoded.readReports
    .filter((r) => r.absoluteSatisfied === false || r.relativeSatisfied === false)
    .map((r) => ({
      type: 'linear-error',
      channel: r.channel,
      setIndex: r.setIndex,
      id: r.boundId,
      absoluteError: r.absoluteError,
      maxAbs: r.maxAbs,
      absoluteSatisfied: r.absoluteSatisfied,
      relativeError: r.relativeError,
      relativeEnergy: r.relativeEnergy,
      relativeSatisfied: r.relativeSatisfied,
      regionId: r.regionId,
    }));

  const constrainedBlocks = recoded.blockRecords
    .filter((b) => !b.certified)
    .map((b) => ({ id: b.id, globalBlock: b.globalBlock, status: b.status, reason: b.reason, regionId: b.regionId }));

  const referenceChannel = options.referenceChannel ?? 0;
  const referenceReductions = data.protectedReadSets.map((_, setIndex) =>
    recoded.readReports.find((r) => r.channel === referenceChannel && r.setIndex === setIndex)
  );
  // The first tuple field is documented as the `reads` row index.  These extra
  // reports also cover callers that interpret the coincident 0/1/0 as a channel.
  const tupleScopedReductions = data.protectedReadSets.map((set, setIndex) =>
    recoded.readReports.find((r) => r.channel === set[0] && r.setIndex === setIndex)
  );

  const pkg = {
    packageFormat: PACKAGE_FORMAT,
    schemaVersion: 1,
    codecVersion: CODEC_VERSION,
    constantsVersion: `bfp-constants-${constantsHash.slice(0, 16)}`,
    constantsSha256: constantsHash,
    inputSha256: inputHash,
    provenance: {
      sourceFrameId: frame.frameId,
      cameraReadCount: 1,
      sourceReleased: options.released ?? false,
      reproducible: true,
      nodeRequirement: '22.x',
      ops: data.ops,
      operationTrace: [
        { op: 'camera', frame: frame.frameId, reads: 1 },
        { op: 'device', profile: 'compact', layoutId: 'channel-spatial-flat-bfp6-10-v1' },
        { op: 'sum', group: 'sign', reportPath: 'referenceReductions' },
        { op: 'change-layout', profile: 'expand', reader: 'expandBlock/expandChannel/reducePackageRead' },
        { op: 'sum', group: 'energy', reportPath: 'referenceReductions[1]' },
        { op: 'release', frame: frame.frameId, released: options.released ?? false },
      ],
    },
    layouts: {
      source: {
        layoutId: 'channel-row-x-bfp8',
        format: 'NCHW-channel-row-x-BFP8/v1',
        mantissaBits: 8,
        sourceBlock: data.sourceBlock,
        order: ['channel', 'row', 'xBlock32', 'xWithinBlock'],
        exponentSharing: 'one signed i8 exponent per 32-x source block',
        rowBoundary: 'source x blocks reset at every row',
      },
      target: {
        layoutId: 'channel-spatial-flat-bfp6-10-v1',
        format: 'NCHW-channel-spatial24-BFP6-10/v1',
        mantissaBitsNormal: 6,
        mantissaBitsExtended: 10,
        targetBlock: data.targetBlock,
        order: ['channel', 'adjacentRowsFlattenedYThenX', 'spatialPositionMod24'],
        traversal: 'y-major then x, flattened adjacent rows',
        rowBoundary: '128 mod 24 = 8; cross-row chunks are real concatenations, not padding',
        exponentCandidates: data.candidates,
        quotaSelection: `blockAbs[globalTargetBlock % ${data.candidates.length}]`,
        rounding: 'round-to-nearest-binary-rational, ties-to-even, after merging all source scales/offset',
      },
    },
    wireConstants: data,
    producerFlags: producerFlags(data),
    sourceTensor: sourceTensor(frame, data),
    targetTensor: {
      format: 'NCHW-channel-spatial24-BFP6-10/v1',
      layoutId: 'channel-spatial-flat-bfp6-10-v1',
      shape: data.shape,
      targetBlock: data.targetBlock,
      blockCount: recoded.blockRecords.length,
      blocks: recoded.blockRecords,
    },
    // Convenience alias for consumers expecting `package.blocks`.
    blocks: recoded.blockRecords,
    // `reductions` follows the three protected/readBound rows on the reference
    // channel.  The full NCHW sweep is in readReports/allChannelReductions.
    reduction: referenceReductions,
    reductions: referenceReductions,
    results: referenceReductions,
    readReports: recoded.readReports,
    referenceChannel,
    referenceReductions,
    tupleScopedReductions,
    allChannelReductions: recoded.readReports,
    calibration: {
      strictInterval: solveSmallTile(data, { missingPolicy: 'strict-interval' }),
      missingAsZero: solveSmallTile(data, { missingPolicy: 'zero' }),
      trustInvalidWireCode: solveSmallTile(data, { missingPolicy: 'wire-code' }),
    },
    allocation: recoded.allocation,
    stats: recoded.stats,
    dependencyRegions: recoded.regions,
    constraints: {
      constrainedReads,
      signConstrainedReads,
      levelConstrainedReads,
      constrainedBlocks,
      regions: recoded.regions,
      note: 'A rejected region must not be confirmed through two separate block-level answers.',
    },
    errorEvidence: {
      blockLinf: 'Number view of exact binary-rational endpoint-envelope L-infinity; exact selected worst evidence is available in candidate calculations.',
      blocks: recoded.blockRecords.map((b) => ({
        id: b.id,
        block: b.block,
        channel: b.channel,
        linf: b.linf,
        quota: b.quota,
        quotaSatisfied: b.quotaSatisfied,
        worstPoint: b.worstPoint,
        status: b.status,
        candidateEvidencePath: `targetTensor.blocks[globalBlock=${b.globalBlock}].candidateEvidence`,
      })),
      reads: recoded.readReports,
    },
  };

  return pkg;
}

/** Convenience application lifecycle matching the camera/ops record. */
export function runApplication(data, options = {}) {
  const camera = new SingleShotCamera(data, options.reader);
  const frameId = options.frameId ?? data.ops?.find((op) => op[0] === 'camera')?.[1] ?? 'frame7';
  const frame = camera.capture(frameId);
  camera.release(frameId);
  const pkg = buildPackage(data, { ...options, frame, frameId, released: true });
  return { package: pkg, camera };
}
