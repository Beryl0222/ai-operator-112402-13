#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeBlockResult, loadPackage, reducePackageRead } from './src/reader.mjs';

export function verifyPackage(path = 'artifacts/block-fp-package.json') {
  const file = resolve(process.cwd(), path);
  const pkg = loadPackage(file);
  const reads = [0, 1, 2].map((i) => reducePackageRead(pkg, 0, i));
  return { file, pkg, reads };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? 'artifacts/block-fp-package.json';
  const { pkg, reads } = verifyPackage(path);
  console.log(JSON.stringify({
    packageFormat: pkg.packageFormat,
    constantsVersion: pkg.constantsVersion,
    stats: pkg.stats,
    channel0ReadsAfterSourceRelease: reads.map((r) => ({
      id: r.boundId,
      real: r.real,
      sign: r.sign,
      fixedPoint: r.fixedPoint,
      evidenceSign: r.evidence?.signGuaranteed ?? null,
    })),
    exampleBlock: describeBlockResult(pkg, 'c0-b0'),
    constrainedSignReads: pkg.constraints.signConstrainedReads,
  }, null, 2));
}
