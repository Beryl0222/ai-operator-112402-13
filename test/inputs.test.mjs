import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import { blockFpPlane, blockFpOffset } from '../inputs/bfp-wire.mjs';

const data=JSON.parse(readFileSync(new URL('../inputs/bfp-wire.json',import.meta.url),'utf8'));
test('块指数和低位宽特征的格式与关联', () => {
  assert.notEqual(data.sourceBlock,data.targetBlock);
  assert.equal(blockFpPlane(0,0).mantissa.length,data.shape[2]);
  assert.equal(blockFpPlane(0,0).exponent.length,data.shape[2]/data.sourceBlock);
  assert.ok(data.extBytes<16*96*128);
  assert.ok(data.reads.some(([,w])=>w.some(x=>x<0)&&w.some(x=>x>0)));
  assert.ok(data.scale.every(v=>Number.isInteger(v[1])));
  assert.equal(data.readBounds.length,data.protectedReadSets.length);
  assert.ok(data.protectedReadSets[0][1].some(i=>data.protectedReadSets[1][1].includes(i)));
  assert.ok(data.readBounds.find(r=>r.rule==='linear-error').maxAbs>0);
});
