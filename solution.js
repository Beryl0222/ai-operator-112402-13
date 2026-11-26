import { pathToFileURL } from 'node:url';
import root, * as api from './solution.mjs';

export * from './solution.mjs';
export default root;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const input = process.argv[2] ?? 'inputs/bfp-wire.json';
  const out = process.argv[3] ?? 'artifacts/block-fp-package.json';
  const result = api.solve(input, out);
  console.log(`Wrote ${result.outputPath}`);
  console.log(JSON.stringify(result.package.stats, null, 2));
}
