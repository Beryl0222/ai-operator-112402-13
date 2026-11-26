import { blockFpOffset, blockFpPlane } from '../inputs/bfp-wire.mjs';
import { add, bin, fromPair, toNumber } from './rational.mjs';

const key = (channel, p) => `${channel}:${p}`;

/**
 * Read the synthetic camera frame exactly once.  The returned plain object is
 * safe to recode repeatedly after the camera/frame has been released.
 *
 * @param {any} data parsed bfp-wire.json
 * @param {{plane?: Function, offset?: Function, frameId?: string}} [options]
 */
export function captureWireFrame(data, options = {}) {
  const readPlane = options.plane ?? blockFpPlane;
  const readOffset = options.offset ?? blockFpOffset;
  const frameId = options.frameId ?? options.frameName ?? 'frame7';
  const applyOffset = options.applyOffset ?? true;
  const [channels, rows, width] = data.shape;
  const bounds = new Map((data.markBounds ?? []).map((b) => [key(b[0], b[1]), b]));
  const marks = new Map();
  for (const mark of data.mark ?? []) {
    const k = key(mark[1], mark[2]);
    if (!marks.has(k)) marks.set(k, []);
    marks.get(k).push({ type: mark[0], fields: mark.slice(1) });
  }

  /** @type {any[]} */
  const planes = [];
  /** @type {any[][]} */
  const pointsByChannel = Array.from({ length: channels }, () => []);

  for (let c = 0; c < channels; c++) {
    const offset = fromPair(readOffset(c));
    /** @type {any[]} */
    const rowRecords = [];
    for (let y = 0; y < rows; y++) {
      // Contract: this is the one camera/plane read for this channel row.
      const plane = readPlane(c, y);
      const mantissa = Array.from(plane.mantissa, (x) => x);
      const exponent = Array.from(plane.exponent, (x) => x);
      const valid = Array.from(plane.valid, (x) => x !== 0);
      rowRecords.push({ row: y, mantissa, exponent, valid });

      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const sourceBlockIndex = Math.floor(x / data.sourceBlock);
        const e = exponent[sourceBlockIndex];
        const m = mantissa[x];
        const isMounted = valid[x];
        const bound = bounds.get(key(c, p));
        const pointMarks = marks.get(key(c, p)) ?? [];

        /** @type {{lo: import('./rational.mjs').BinaryRational, hi: import('./rational.mjs').BinaryRational, bounded: boolean, source: string}} */
        let baseInterval;
        if (bound) {
          const [, , loM, hiM] = bound;
          let lo = bin(loM, e);
          let hi = bin(hiM, e);
          if (lo.n > hi.n) [lo, hi] = [hi, lo];
          baseInterval = { lo, hi, bounded: true, source: 'markBounds' };
        } else if (isMounted) {
          const exact = bin(m, e);
          baseInterval = { lo: exact, hi: exact, bounded: true, source: 'exactCode' };
        } else {
          baseInterval = { lo: null, hi: null, bounded: false, source: 'missingWithoutBounds' };
        }

        const interval = !baseInterval.bounded
          ? { lo: null, hi: null, bounded: false }
          : applyOffset
            ? {
                lo: add(baseInterval.lo, offset),
                hi: add(baseInterval.hi, offset),
                bounded: true,
              }
            : { ...baseInterval };

        const record = {
          channel: c,
          row: y,
          x,
          p,
          sourceBlockIndex,
          sourceMantissa: m,
          sourceExponent: e,
          valid: isMounted,
          offsetPair: readOffset(c),
          offset,
          offsetApplied: applyOffset,
          marks: pointMarks,
          bound: bound ?? null,
          baseInterval,
          interval,
          orig: toNumber(bin(m, e)),
          real: (isMounted || bound)
            ? toNumber(bin(m, e)) + (applyOffset ? toNumber(offset) : 0)
            : null,
        };
        pointsByChannel[c][p] = record;
      }
    }
    planes.push({ channel: c, rows: rowRecords, offsetPair: readOffset(c) });
  }

  return {
    frameId,
    capturedAt: null, // intentionally deterministic; callers may stamp envelopes.
    shape: data.shape,
    sourceBlock: data.sourceBlock,
    targetBlock: data.targetBlock,
    pointsByChannel,
    planes,
    released: false,
  };
}

/**
 * A tiny single-read camera session.  A second capture of the same frame id is
 * refused, modelling the product constraint that a new frame is read once.
 */
export class SingleShotCamera {
  /**
   * @param {any} data
   * @param {{plane?: Function, offset?: Function}} [reader]
   */
  constructor(data, reader = {}) {
    this.data = data;
    this.reader = reader;
    /** @type {Set<string>} */
    this.captured = new Set();
    /** @type {Set<string>} */
    this.released = new Set();
  }

  /** @param {string} frameId */
  capture(frameId = 'frame7') {
    if (this.captured.has(frameId)) {
      throw new Error(`camera frame ${frameId} has already been read; use its serializable package`);
    }
    this.captured.add(frameId);
    return captureWireFrame(this.data, { ...this.reader, frameId });
  }

  /** @param {string} frameId */
  release(frameId = 'frame7') {
    this.released.add(frameId);
    return { frameId, released: true };
  }
}
