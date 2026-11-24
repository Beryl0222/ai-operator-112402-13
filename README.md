# 移动 OCR 校对器的块三角 Jacobian 与编辑补偿

项目资料使用可独立读写的 JSON。Node.js 22.23.4 下运行 `npm ci --offline` 准备环境，然后运行 `npm run inspect` 检查合成数据字段，运行 `npm test` 校验样本引用及格式。

## 输入契约

分层响应 δy_i = forcing_i + slope_i * Σ_j Jij δy_j，j 只能来自早层。矩阵块为 [toWidth][fromWidth]，码为 bfloat16 位模式或直接值。锁定项为零，区间中所有独立斜率均为可能值。栏目约束分别给每条显示槽允许的偏移和相邻槽调整后最小间距。两个显示槽可以引用同一源项，按同一次计算解释。较高精度资料可逐项取得，覆盖后仍用同一布局阈值。设备工作区计 Jacobian 解码缓存、响应内部状态及待领取的补偿。 encoding 缺省为直接实数，bf16 表示无符号 16 位数，作为 IEEE 单精度浮点比特模式的高 16 位，补零为低 16 位。

## 资料读取

样本位于 `inputs/session.json`，其中 `events` 是按到达顺序记下的操作，编号从零开始。layout、preview 引用布局修订；change 给出源条目与 forcing 值；refine 选择可取得精细值的源条目。
