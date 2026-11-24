import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const d = JSON.parse(readFileSync(new URL('../inputs/session.json', import.meta.url), 'utf8'));

test("块三角跨层维度吻合", () => {
  assert.ok(d.blocks.every(b=>b.from<b.to&&b.m.length===d.levels[b.to].length&&b.m.every(a=>a.length===d.levels[b.from].length)));
});

test("同源双显示槽跨版变化", () => {
  assert.ok(d.layouts[0].map[1]===d.layouts[0].map[2] && d.layouts[0].map.length!==d.layouts[1].map.length);
});

test("精化范围和非零锁定输入同时存在", () => {
  assert.ok(Object.entries(d.refine).every(([i,n])=>n>=d.slope[i][0]&&n<=d.slope[i][1])&&d.locked.some(i=>d.forcing[i]!==0));
});

test("包含低精度块的真实位模式", () => {
  assert.ok(d.blocks.find(x=>x.encoding==='bf16').m.flat().every(x=>Number.isInteger(x)&&x>=0&&x<65536));
});
