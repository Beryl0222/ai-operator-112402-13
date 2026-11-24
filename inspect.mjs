import {readFileSync} from 'node:fs';
import * as input from './inputs/bfp-wire.mjs';

const source=JSON.parse(readFileSync(new URL('./inputs/bfp-wire.json',import.meta.url),'utf8'));
console.log(JSON.stringify({名称:'块指数和低位宽特征',首项:source['shape'],字段:Object.keys(source),取数函数:Object.keys(input)},null,2));
