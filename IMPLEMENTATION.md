# 实现说明

## 入口

```bash
npm start
# 或
npm run solve
# 等价于
node solve.mjs inputs/bfp-wire.json artifacts/block-fp-package.json

npm run verify
npm test
```

程序化入口为 `index.js` / `solution.mjs`：

```js
import { runApplication, loadPackage, reducePackageRead } from './index.js';

const data = JSON.parse(readFileSync('inputs/bfp-wire.json', 'utf8'));
const { package: pkg } = runApplication(data);
const afterRelease = reducePackageRead(loadPackage(pkg), 0, 0);
```

## 管线

1. `SingleShotCamera` / `captureWireFrame` 对每个 `(channel, row)` 只读取一次
   `blockFpPlane`，并读取每通道二进制有理偏置。
2. `markBounds` 用该点实际源指数把 `[loMantissa, hiMantissa]` 转成实数区间；
   无 `markBounds` 的有效码按精确点区间处理；无边界的无效项标记为不可证明。
3. 目标块按同一 channel 的 `y*width+x` 展平后每 24 个位置切分。块可以跨源行，
   每个点仍使用自己的源指数，因此不会把一个源指数块误当成目标指数块。
4. 所有源 mantissa/exponent、通道偏置和区间中点都用 `BigInt * 2^e`
   精确合并，再做一次最近偶舍入。没有先按源块分别舍入后相加。
5. 对每个全局目标块 `g`，使用 `candidates[g % candidates.length]`，
   字面配额为 `blockAbs[g % blockAbs.length]`。每个指数评估 6/10 位两种码格式、
   L∞ 端点包络、饱和数和扩展字节。
6. `protectedReadSets` 会按 channel 展开核对（数据未另给 channel 字段）。
   重叠读口通过同一个目标块表示计算，并合并成依存区做联合枚举，而不是每个读口
   各自重新选码。
7. 扩展成本为 `4 * validCount` 个额外 bit；包内同时给出 bit、slot 和按字节
   向上取整后的成本。`extBytes` 优先分配给符号/依存区，再按 `priority`
   和全局块编号分配。
8. 无法同时满足块配额、读口误差/符号或预算时，包中保留实际 best-effort
   量化张量，但把对应 read、block、region 标记为 constrained/rejected。

## 源帧回收后的可读性

输出包是自描述 JSON：

- `packageFormat` / `schemaVersion` / `codecVersion`
- `constantsVersion` / `constantsSha256` / `inputSha256`
- `layouts.source` 与 `layouts.target`
- `sourceTensor.planes`：旧 8 位 BFP 码和 valid 平面
- `targetTensor.blocks`：实际 6/10 位 mantissa、指数、valid、布局和版本
- `reductions`：参考 channel 0 上与三个 `readBounds` 对应的归约；`readReports`
  是全部 16 个 channel 的展开结果，`tupleScopedReductions` 兼容首项作 channel 的读法
- `errorEvidence`：块 L∞、配额、最坏点和候选证据
- `dependencyRegions` / `constraints`：整区结论及受约束 read/block

可用 `reducePackageRead(pkg, channel, setIndex)` 在没有源帧时重算定点归约，
或用 `expandBlock(block)` / `expandChannel(pkg, channel)` 做 expand。

## 当前联调样本的结论

按 README 的字面行配额 `blockAbs[g % 4]`，样本中的候选指数与部分峰值/小块误差
被刻意构造为不能同时满足全部块配额；因此包不会虚假地给出“全部整区可用”。
当前确定性选择仍：

- 保持全部 32 个 `rule: "sign"` 读口的符号；
- 对 48 个 channel × protected-set 组合给出完整误差证据；
- 报告唯一无法在声明候选内保住符号的线性读口（channel 15 / `motor-residual`）；
- 用满 `extBytes`，所有写出的 mantissa 均在对应 6/10 位码范围内。

如果调用方采用“候选序号对应同序 `blockAbs`”的另一种解释，可调用
`recodeFrame(data, frame, { quotaMode: 'ordinal' })`；每个候选仍同时带有
`withinRowQuota` 和 `withinOrdinalQuota` 证据。
