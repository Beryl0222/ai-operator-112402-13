#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runApplication } from './src/package.mjs';

/**
 * Repeatable entry point:
 *   node solve.mjs --input inputs/bfp-wire.json --out artifacts/block-fp-package.json
 */
export function solve(inputPath = 'inputs/bfp-wire.json', outPath = 'artifacts/block-fp-package.json', options = {}) {
  const absoluteInput = resolve(process.cwd(), inputPath);
  const raw = readFileSync(absoluteInput);
  const data = JSON.parse(raw.toString('utf8'));
  const inputSha256 = createHash('sha256').update(raw).digest('hex');
  const { package: pkg } = runApplication(data, { inputSha256, ...options });

  const absoluteOut = resolve(process.cwd(), outPath);
  mkdirSync(dirname(absoluteOut), { recursive: true });
  writeFileSync(absoluteOut, `${JSON.stringify(pkg)}\n`, 'utf8');
  return { package: pkg, outputPath: absoluteOut };
}

function parseArgs(argv) {
  const args = { input: 'inputs/bfp-wire.json', out: 'artifacts/block-fp-package.json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--input' || argv[i] === '-i') args.input = argv[++i];
    else if (argv[i] === '--out' || argv[i] === '-o') args.out = argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
    else if (argv[i] === '--quota-mode') args.quotaMode = argv[++i];
    else if (argv[i] === '--priority-direction') args.priorityDirection = argv[++i];
    else if (argv[i] === '--full-candidate-evidence') args.fullCandidateEvidence = true;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv);
  const { input, out, quiet, ...options } = args;
  const result = solve(input, out, options);
  if (!quiet) {
    const p = result.package;
    console.log(JSON.stringify({
      output: result.outputPath,
      packageFormat: p.packageFormat,
      constantsVersion: p.constantsVersion,
      stats: p.stats,
      calibration: {
        strict: {
          blocks: p.calibration.strictInterval.blocks.map((b) => ({ block: b.block, exponent: b.exponent, bits: b.bits, feasible: b.feasible })),
          weightedReal: p.calibration.strictInterval.weightedReal,
          sign: p.calibration.strictInterval.sign,
        },
        missingAsZero: {
          weightedReal: p.calibration.missingAsZero.weightedReal,
          sign: p.calibration.missingAsZero.sign,
        },
      },
    }, null, 2));
  }
}
