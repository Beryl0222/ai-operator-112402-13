#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { solve } from './solve.mjs';

function parseArgs(argv) {
  const args = { input: 'inputs/bfp-wire.json', out: 'artifacts/block-fp-package.json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--input' || argv[i] === '-i') args.input = argv[++i];
    else if (argv[i] === '--out' || argv[i] === '-o') args.out = argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv);
  const result = solve(args.input, args.out);
  if (!args.quiet) {
    console.log(`Wrote ${result.outputPath}`);
    console.log(JSON.stringify(result.package.stats, null, 2));
  }
}
