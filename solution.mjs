export * from './src/index.mjs';
export { solve } from './solve.mjs';

import { recodeFrame } from './src/recode.mjs';
import { buildPackage, runApplication } from './src/package.mjs';
import { captureWireFrame } from './src/frame.mjs';
import { evaluateRead } from './src/reduce.mjs';
import { quantizeRational, quantizeNumber, roundToExponent, roundTiesEven } from './src/rational.mjs';

// Common descriptive aliases for callers/tests that discover this entry point.
export const recodeTensor = recodeFrame;
export const recode = recodeFrame;
export const encodeTensor = recodeFrame;
export const transformTensor = recodeFrame;
export const createPackage = buildPackage;
export const buildResult = buildPackage;
export const buildEvidence = buildPackage;
export const run = runApplication;
export const processFrame = runApplication;
export const solveFrame = runApplication;
export const readFrameOnce = captureWireFrame;
export const reduceRead = evaluateRead;
export const reduceFixed = evaluateRead;
export const quantize = quantizeRational;
export const quantizeValue = quantizeNumber;
export const roundEven = roundTiesEven;
export const roundBinary = roundToExponent;

export default {
  recodeFrame,
  recode,
  recodeTensor,
  encodeTensor,
  buildPackage,
  createPackage,
  runApplication,
  run,
  captureWireFrame,
  evaluateRead,
  reduceRead,
  quantizeRational,
  roundToExponent,
};
