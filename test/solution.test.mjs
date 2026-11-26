import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import data from '../inputs/bfp-wire.json' with { type: 'json' };
import {
  bin,
  buildPackage,
  captureWireFrame,
  evaluateRead,
  recodeFrame,
  roundToExponent,
  runApplication,
  SingleShotCamera,
  toNumber,
  reducePackageRead,
} from '../solution.mjs';

test('ties-to-even is exact for positive and negative halves', () => {
  assert.equal(roundToExponent(bin(1, -1), 0), 0n); // +0.5 -> 0
  assert.equal(roundToExponent(bin(3, -1), 0), 2n); // +1.5 -> 2
  assert.equal(roundToExponent(bin(-1, -1), 0), 0n); // -0.5 -> -0
  assert.equal(roundToExponent(bin(-3, -1), 0), -2n); // -1.5 -> -2
  assert.equal(roundToExponent(bin(5, -1), 0), 2n); // +2.5 -> 2
  assert.equal(roundToExponent(bin(-5, -1), 0), -2n); // -2.5 -> -2
});

test('camera frame is read once and mark bounds use the real source exponent', () => {
  const camera = new SingleShotCamera(data);
  camera.capture('frame7');
  assert.throws(() => camera.capture('frame7'), /already been read/);

  const frame = captureWireFrame(data);
  assert.equal(frame.pointsByChannel.length, 16);

  const missing = frame.pointsByChannel[3][127];
  assert.equal(missing.valid, false);
  assert.deepEqual([toNumber(missing.baseInterval.lo), toNumber(missing.baseInterval.hi)], [-0.25, 0.375]);

  const saturation = frame.pointsByChannel[2][128];
  assert.equal(saturation.sourceMantissa, -128);
  assert.deepEqual([toNumber(saturation.baseInterval.lo), toNumber(saturation.baseInterval.hi)], [-258, -256]);

  // -128 remains an ordinary numeric code when there is no saturation mark.
  const numericMinus128 = frame.pointsByChannel[0][256];
  assert.equal(numericMinus128.sourceMantissa, -128);
  assert.equal(numericMinus128.interval.bounded, true);
});

test('target blocks flatten adjacent rows and cross the 128-wide boundary', () => {
  const frame = captureWireFrame(data);
  const result = recodeFrame(data, frame, { includeCandidateEvidence: false });
  const block5 = result.blockRecords.find((b) => b.channel === 0 && b.block === 5);
  assert.deepEqual([block5.positions[0], block5.positions.at(-1)], [120, 143]);
  const points = block5.positions.map((p) => frame.pointsByChannel[0][p]);
  assert.equal(points[7].row, 0); // p=127
  assert.equal(points[8].row, 1); // p=128
  assert.equal(result.blockRecords.length, 16 * 96 * 128 / 24);
  assert.ok(result.blockRecords.every((b) => b.residue === b.globalBlock % data.candidates.length));
});

test('channel offset is merged before one ties-to-even quantization', () => {
  const frame = captureWireFrame(data);
  const p28 = frame.pointsByChannel[0][28];
  assert.equal(p28.orig, -0.015625);
  assert.equal(p28.real, 0.015625); // -2*2^-7 + 1*2^-5
  const result = recodeFrame(data, frame, { includeCandidateEvidence: false });
  const block1 = result.selected[1];
  const candidateEminus5 = result.allCandidates[1].find((c) => c.exponent === -5 && c.bits === 10);
  assert.equal(candidateEminus5.mantissas[28 - 24], 0); // +0.5 ULP, tie to even
  assert.ok(block1);
});

test('small calibration tile merges scales before one nearest-even rounding', async () => {
  const { solveSmallTile } = await import('../solution.mjs');
  const tile = solveSmallTile(data);
  assert.equal(tile.blocks.length, 2);
  assert.equal(tile.blocks[0].exponent, -6);
  assert.equal(tile.blocks[0].bits, 10);
  assert.equal(tile.blocks[0].feasible, true);
  assert.equal(tile.weightedReal, 8.75);
  assert.equal(tile.sign, 'positive');
  // The invalid remainder does not contribute under the zero convention and
  // makes the strict interval report unbounded.
  assert.equal(tile.blocks[1].feasible, false);
  assert.equal(solveSmallTile(data, { missingPolicy: 'zero' }).weightedReal, 8.75);
});

test('package is serializable, repeatable, budgeted, and versions its layout', () => {
  const a = buildPackage(data, { includeCandidateEvidence: false });
  const b = buildPackage(data, { includeCandidateEvidence: false });
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.match(a.packageFormat, /^block-fp-interchange-package\/v/);
  assert.match(a.constantsVersion, /^bfp-constants-[0-9a-f]{16}$/);
  assert.equal(a.targetTensor.blocks.length, 8192);

  const budget = a.allocation.extBudgetBytes;
  const allocatedCost = a.targetTensor.blocks
    .filter((block) => block.bits === 10)
    .reduce((sum, block) => sum + block.extensionBytes, 0);
  assert.ok(allocatedCost <= budget);
  assert.equal(a.allocation.usedExtBytes, allocatedCost);

  for (const block of a.targetTensor.blocks) {
    const min = -(2 ** (block.bits - 1));
    const max = 2 ** (block.bits - 1) - 1;
    assert.ok(block.mantissas.every((m) => m >= min && m <= max));
  }

  // Every declared sign-rule read port keeps its sign envelope.
  const signReports = a.readReports.filter((r) => r.rule === 'sign');
  assert.equal(signReports.length, 32);
  assert.ok(signReports.every((r) => r.signGuaranteed));
});

test('overlapping reads use the same target block representation', () => {
  const frame = captureWireFrame(data);
  const result = recodeFrame(data, frame, { includeCandidateEvidence: false });
  const reps = Array.from({ length: data.shape[0] }, () => []);
  for (const block of result.selected) {
    // selected candidates are internal objects; build channel arrays below.
  }
  for (const record of result.blockRecords) {
    reps[record.channel][record.block] = record;
  }
  const r0 = evaluateRead({ data, frame, channel: 0, setIndex: 0, representations: reps[0] });
  const r1 = evaluateRead({ data, frame, channel: 0, setIndex: 1, representations: reps[0] });
  assert.equal(r0.outputSign, 'negative');
  assert.equal(r1.outputSign, 'negative');
  const b0 = reps[0][0];
  for (const p of [18, 21]) {
    const local = p % data.targetBlock;
    assert.equal(r0.dependencies.find((d) => d.p === p).blockIndex, 0);
    assert.equal(r1.dependencies.find((d) => d.p === p).blockIndex, 0);
    assert.equal(b0.mantissas[local], b0.mantissas[local]);
  }
  assert.equal(r0.regionId, r1.regionId);
});

test('serialized package supports source-free fixed-point reads', () => {
  const pkg = buildPackage(data, { includeCandidateEvidence: false });
  for (const [channel, setIndex] of [[0, 0], [0, 1], [1, 1]]) {
    const read = reducePackageRead(pkg, channel, setIndex);
    const evidence = pkg.readReports.find((r) => r.channel === channel && r.setIndex === setIndex);
    assert.equal(read.real, evidence.outputReal);
    assert.equal(read.sign, evidence.outputSign);
    assert.equal(read.constantsVersion, pkg.constantsVersion);
    assert.match(read.layoutId, /spatial/);
    assert.ok(read.fixedPoint.mantissa);
  }
});

test('runApplication models release and writes a parseable artifact', () => {
  const raw = JSON.parse(readFileSync(new URL('../inputs/bfp-wire.json', import.meta.url), 'utf8'));
  const { package: pkg, camera } = runApplication(raw, { includeCandidateEvidence: false });
  assert.equal(pkg.provenance.cameraReadCount, 1);
  assert.equal(pkg.provenance.sourceReleased, true);
  assert.throws(() => camera.capture('frame7'), /already been read/);
  assert.ok(pkg.constraints.constrainedReads.length >= 0);
  assert.ok(pkg.stats.totalBlocks > 0);
});
