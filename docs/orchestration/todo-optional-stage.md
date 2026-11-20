# 编排计划：todo 可选，全流程按需启用

- 依据：`docs/design/todo-optional-stage.md`
- 验收：`docs/acceptance/todo-optional-stage.md`
- 单板工作。所有改动在同一个仓库、同一个进程模型内，不需要多持有者协作。

## 1 状态与不变式

状态字段：

```
relay.fullFlow : boolean     // 唯一开关；false = simple，true = full
stageFlags     : { acceptance-cases, architecture-design, orchestration-plan }
```

安全不变式（Safety）：

- **S1** `fullFlow === false` 时，主代理开 `direct-execution` 不检查 `stageFlags`。
- **S2** `fullFlow === true` 时，主代理开 `direct-execution` 必须三标志全 `true`，否则
  `STAGE_FLAGS_UNMET`，且不改动任何状态。
- **S3** 唯一 `false → true` 跃迁：任何成功的写操作（`op !== "view"`、`isError !== true`，
  含 `list: []` 空账）。
- **S4** 唯一 `true → false` 跃迁：继任者首次空账（两空账终结；`generation > 0`、未被
  invalidate、`firstEvaluation === null`）。
- **S5** 任何 `fullFlow` 翻转，在同一同步段内把 `stageFlags` 重置为全 `false` 并 `persist()`。
- **S6** `view` 与失败的 todo 调用不改变 `fullFlow`、`firstEvaluation`、`lastLedger`。
- **S7** 旧快照缺 `fullFlow`：`canStop === true` 推为 `false`；否则按
  `generation > 0 || handoffPending || firstEvaluation !== null` 推为 `true`。
- **S8** `fullFlow === false` 且 `handoffPending === true` 是非法组合，promoted 分支必须显式
  写 `handoffPending: false`。空账 handoff 分支写 `fullFlow: true`，所以该组合不会在
  handoff 路径上出现；把 `handoffPending` 检查提到 `fullFlow` 短路之前是禁止的，那会把
  一条协议规则拆成两处判断。

活性不变式（Liveness）：

- **L1** simple：scope 全关后，`onSessionStop` 与 `maybeNudge` 都放行，模型能写最终答复。
- **L2** full：空账仍然只能触发 handoff；两空账之前不能自然停止。
- **L3** 接力未终结时 `fullFlow` 保持 `true`，`advanceRelayForHandoff` 不清它。

## 2 工作切片

| 切片 | 内容 | 输入 | 输出 | 停止条件 |
|---|---|---|---|---|
| W0 数据层 | `relay/state.mjs`、`relay/ledger.mjs` | 设计第 1、3 节 | `fullFlow` 字段与三个跃迁 | 纯函数测试通过 |
| W1 桥接层 | `station/handoff-state.mjs` 的 `recordLedgerEvaluation` | W0 | 翻转时清零 flags | 单元测试断言 flags 归零 |
| W2 门控层 | `station/controls.mjs`、`nudge.mjs`、`gates.mjs` | W0 | 两个 gate 与 stop 条件化 | 集成测试通过 |
| W3 文案代码 | `station/texts.mjs`、`relay/texts.mjs` | W0 | flow 行、simple 收尾、`next.simple` | 资源段落存在、渲染不抛错 |
| W4 资源提示词 | `resources/prompts/` 九个文件 | W0、W3 | 新段落与条件句 | `prompts.test.mjs` 通过 |
| W5 文档 | `README.md`、`CHANGELOG.md`、`docs/design/stages.md` | W2、W4 | 行为说明 | 与实现一致 |
| W6 测试 | `tests/relay.test.mjs`、`stage-flags.test.mjs`、`relay-integration.test.mjs`、`integration.test.mjs` | W0–W2 | 新增/修订的契约测试 | `bun test tests` 全绿 |
| W7 验证 | 全量测试 + lint + 手工路径 | 全部 | 证据 | 见第 5 节 |

临界路径：W0 → W1 → W2 → W6 → W7。W3 与 W4 可在 W0 之后并行；W5 独立。
不设人工审批波次；W0 完成即释放 W1、W3、W4。

## 3 逐文件改动

### 3.1 `src/relay/state.mjs`

- `createRelay()` 增加 `fullFlow: false`。
- `copyRelay()` 用 `legacyFullFlow(source)` 归一化，处理旧快照。
- `isValidRelay()` 接受 `fullFlow === undefined || typeof === "boolean"`。
- 不改其他字段的校验。

### 3.2 `src/relay/ledger.mjs`

- `applyLedgerEvaluation` 空账 promoted 分支：`fullFlow: false`。
- 空账 handoff 分支：`fullFlow: true`（空账触发了交接，全流程必须开着）。
- 非空分支：`fullFlow: true`。
- `beginGenerationAfterHandoff`：保留 `current.fullFlow`。
- `invalidatePromotion`：保留 `fullFlow`。

### 3.3 `src/station/handoff-state.mjs`

- `recordLedgerEvaluation`：取 `before`，应用后比较；不同则
  `station.state.stageFlags = createStageFlags()`，再 `persist()`。
- 保持函数同步，不引入 await。

### 3.4 `src/station/controls.mjs`

- S5 校验条件加 `state.relay?.fullFlow === true`。
- `RW_BEFORE_LEDGER` 条件加 `state.relay?.fullFlow === true`。
- 不改子代理 `mainAgent` 判定与参数校验顺序。

### 3.5 `src/station/nudge.mjs`

- `currentScope` 分支之后、`relay` 分支之前：`if (state.relay?.fullFlow !== true) return { kind: "none" }`。

### 3.6 `src/station/gates.mjs`

- `onSessionStop` 在 `scope` 分支之后：`if (state.relay?.fullFlow !== true) return undefined`。
- 其余接力分支原样保留。

### 3.7 `src/station/texts.mjs`

- `endText` 调用点传入的 `relayOn` 改为 `station.relayReady() && !state.herdMode && state.relay?.fullFlow === true`。
- `skillReceiptText` 增加 `const fullFlow = state.relay?.fullFlow === true;`
  - `!fullFlow` 且 scope 内 → `T["receipt.simple-inside"]`
  - `!fullFlow` 且 scope 外 → `T["receipt.simple-outside"]`
  - `fullFlow` → 现有逻辑。
- 不删除既有 receipt 段落。

### 3.8 `src/relay/texts.mjs`

- `relayStatusText` 在 `status.evaluation` 之后插入 `status.flow`，变量由 `flowLabel(current)` 提供。
- `nextStepText` 增加：`options.action` 为空且 `current.fullFlow !== true` 时返回 `R["next.simple"]`。

### 3.9 `resources/prompts/`

| 文件 | 段落 | 改动 |
|---|---|---|
| `system.md` | `persistent-rules` | rw 拒绝改为「full 流程中且本代际未提交 ledger」；outside-scope 的 todo 要求改为条件句 |
| `system.md` | `outside-scope` | 增加 simple 模式下 scope 全关即可答复 |
| `stages.md` | `header` | 五阶段协议从 todo 账本（含空账）开始；simple 直接 S5 |
| `tools/scope.md` | `tool`、`begin.permission`、`begin.stage` | 说明 fullFlow 条件 |
| `tools/todo.md` | `tool`、`op` | view 不启用；任何写入（含 `list: []`）启用；两空账复位；再写再启用 |
| `errors.md` | `rw-before-ledger`、`stage-flags-unmet` | 点明 full 流程 |
| `receipts/relay.md` | 新增 `status.flow`、`next.simple`；改 `next.promoted` | 文案随状态 |
| `receipts/scope.md` | 新增 `receipt.simple-inside`、`receipt.simple-outside` | simple 收尾 |
| `labels.md` | 新增 `flow-simple`、`flow-full` | `status.flow` 取值 |

### 3.10 文档

- `README.md`：S5 门控段落加 fullFlow 条件。
- `CHANGELOG.md`：新增条目。
- `docs/design/stages.md`：与实现同步。
- `docs/adr/0001-stage-names.md`：若其表格写「S5 only herdMode false」，补 fullFlow 说明。

### 3.11 提示词门禁一致性（本轮新增）

验收 CASE-PROMPT-007 暴露的残留缺陷，三处改动互不依赖，可一次做完：

- `resources/prompts/stages.md` 的 `## header`：把第一段的「四个工作阶段可任意顺序、无阶段门禁」
  限定为 simple 模式；补一句 full flow 中 `direct-execution` 要等
  `acceptance-cases`、`architecture-design`、`orchestration-plan` 各跑一次。保留
  「自由用于重做与修复，不是跳过许可」与第三段的 full-flow 开关说明。
- `resources/prompts/system.md` 的 `persistent-rules`：在 `Scope stages` 行后补同一条件句
  （full flow 下 S5 需前三阶段；simple 模式不过此门）。不改其他行。
- `src/tools/todo.mjs` 的 `relayDetails`：加 `fullFlow: relay.fullFlow`，让 transcript 里的
  relay 投影能完整还原唯一开关。

安全不变式：

- **S9** 文案只复述 `controls.mjs` 的条件，不新增可执行规则；`rerun` 文案不得与
  `STAGE_FLAGS_UNMET` 的方向相反。
- **S10** `relayDetails` 的字段集合必须覆盖 `copyRelay` 读取的每个可写字段；漏字段即缺陷。

活性：

- **L4** 任一处文案改完后，`loadDoc("stages")` 与 `loadDoc("system")` 仍能装载，且段落非空。

### 3.12 simple 文案与空账契约（本轮新增）

两处真实缺陷，互不依赖：

- **simple 的定义**：`resources/prompts/labels.md#flow-simple`、
  `resources/prompts/receipts/relay.md#next.simple`、
  `resources/prompts/receipts/scope.md#receipt.simple-inside`、`#receipt.simple-outside`
  四处都写成「从未提交账本」。两空账 promoted 之后 `fullFlow` 已回到 `false`，而账本刚提交过，
  这四句会同时造假。统一改为「本轮任务不需要账本」，并保留「写账本会开启全流程」。
- **什么开启全流程**：本文件 S3 与 3.2、设计文档的跃迁表与伪代码、验收约定 2/4 与
  CASE-TODO-002，曾把启用条件写成非空账本；实现是任何成功写操作（含空账）。文档向实现对齐，
  实现不动——空账若不开全流程，就必须把 `handoffPending` 检查提到 `fullFlow` 短路之前，
  那会把一条协议规则拆成两处判断。

安全不变式：

- **S11** 四处 simple 文案必须对「初始未提交账本」与「两空账 promoted 之后」同时为真；
  任意一处出现「从未提交账本 / no ledger submitted」这类历史断言即缺陷。
- **S12** 文档中「什么开启全流程」只有一句话：任何成功写操作（`op !== "view"`、
  `isError !== true`，含 `list: []`）。任何「非空」措辞都是漂移。

活性：

- **L5** 改完文案后 `loadDoc("labels")`、`loadDoc("receipts/relay")`、`loadDoc("receipts/scope")`
  仍能装载，且四个段落非空。

### 3.13 终结后的再次写入（本轮新增）

用户需求 4 要求「两空账终结后，若又写了 todo，则再次启用五阶段 + 接力」。
`src/relay/ledger.mjs` 的 promoted 分支必须区分两种空账：

- **继任者首次空账**（`first === true`）：`action: "promoted"`，`fullFlow: false`，两空账终结。
- **已 promoted 的持有者再次空账**（`first === false`、`canStop === true`）：`action: "reopened"`，
  `fullFlow: true`，保持 `canStop: true`、`handoffPending: false`；不重开 handoff。
- `src/relay/texts.mjs` 的 `nextStepText` 接线 `next.reopened`；`receipts/relay.md` 新增该段。
- `system.md#persistent-rules`、`stages.md#header`、`tools/todo.md#tool` 三处模型可见文案
  明说「终结后再次写入（含空账）重新开启全流程」。

安全不变式：

- **S13** `fullFlow === true` 且 `canStop === true` 是合法的「已终结但已再次提交账本」状态：
  `onSessionStop` 与 `nudge` 仍放行最终答复；新 scope 的 `invalidatePromotion` 清 `canStop` 后，
  S5 重新受三阶段门控。该状态不得触发新的 handoff。

验证：

- `tests/full-flow.test.mjs` 覆盖 promoted 首次（false）→ 再次空账（reopened、true、canStop true）。
- `tests/relay-integration.test.mjs` 的 `repeated` 用例断言 `details.relay.fullFlow === true`。
- `tests/prompts.test.mjs` 钉住三处文案。

验证顺序：`bun test tests/full-flow.test.mjs tests/integration.test.mjs` →
`bun test tests` → `bunx eslint .` → `rg "no todo ledger is submitted" resources/prompts`
必须无命中。

### 3.14 终结协议的第二轮（本轮新增）

用户需求 2 的「保持到两空账终结」有两条容易漏掉的边界：终结跨 handoff 保持，以及终结协议
本身可重复。实现已在既有三支中成立，本轮只补验收与回归锚点，不改生产代码。

- **继任者继承**：`beginGenerationAfterHandoff` 不清 `fullFlow`。继任者在本代际首次 todo
  之前：`todo view` 显示 `Flow: full flow`；`rw` 被 `RW_BEFORE_LEDGER` 拒绝；S5 仍要求
  三标志。
- **第二轮**：`reopened` 保留 `canStop: true`；随后任何新 scope 的 `invalidatePromotion`
  清 `canStop` 并置 `promotionInvalidated: true`，下一次空账因此走 handoff 分支，而不是被
  promoted 条件再次吞掉。第二轮与第一轮共用同一 `applyLedgerEvaluation` 三支。
- 禁止：为第二轮另写分支、在 `advanceRelayForHandoff` 里重置 `fullFlow`、或在 `reopened`
  之后让空账不经 handoff 就再次 `canStop: yes`。

安全不变式：

- **S14** `beginGenerationAfterHandoff` 不得改变 `fullFlow`；继任者首次评估前 `rw` 必须被
  `RW_BEFORE_LEDGER` 拒绝。
- **S15** `reopened` 之后若已开过任何 scope（`promotionInvalidated === true`），下一次空账
  必须是 `action: "handoff"`，不得再次返回 `reopened`。

验证：

- `tests/full-flow.test.mjs` 新增「a second full cycle terminates after a reopened ledger」：
  promoted → reopened → `invalidatePromotion` → 空账 `handoff` → `beginGenerationAfterHandoff`
  → 继任者空账 `promoted`、`fullFlow === false`、`canStop === true`。
- 验收扩展 CASE-TWOEMPTY-003（继任者继承步骤）并新增 CASE-CYCLE-009。

### 3.15 安装副本新鲜度（本轮新增）

根因：omp 加载的是安装副本 `~/.omp/plugins/node_modules/herdchestra-lite2`，
不是仓库工作树。第 5 代及之前的「真实会话」探针全部在旧副本上执行：该副本的
`src/relay/texts.mjs` 没有 `status.flow`、`reopened` 与 simple 分支，
`src/station/controls.mjs` 的 S5 门禁与 `RW_BEFORE_LEDGER` 都缺 `fullFlow` 条件。
于是 simple 任务被旧门禁挡成 `STAGE_FLAGS_UNMET`，而验收被误记为通过。

| 切片 | 内容 | 输入 | 输出 | 停止条件 |
|---|---|---|---|---|
| W8 安装同步 | `scripts/sync-plugin.mjs`、`package.json` 的 `sync:plugin` | 仓库 `src/`、`resources/` | 差异清单与同步后的副本 | 逐文件内容一致 |

- 目标目录：默认 `~/.omp/plugins/node_modules/herdchestra-lite2`；
  `HERDCHESTRA_PLUGIN_DIR` 可覆盖，便于测试与多插件根。
- 脚本只写 `src/` 与 `resources/`，不删除目标目录中的其他文件，
  也不触碰依赖与会话状态。
- 脚本退出码：有未同步差异时非零；同步后复核一致才为零。
- 同步后必须重启会话：模块在进程启动时装载，热改文件不会生效。

安全不变式：

- **S16** 同步只覆盖 `src/` 与 `resources/` 下的同名文件；`package.json` 等安装器元数据
  不在同步范围内，避免把仓库的私有字段写进安装根。
- **S17** 验收证据必须以 `todo view` 的 `Flow:` 行为构建指纹；缺该行时，
  所有工具返回原文都不构成证据。

活性：

- **L6** 重启后新会话首次 `todo view` 即出现 `Flow:` 行；`bun run sync:plugin`
  在无差异时立即返回零。

实现顺序：W8 可与 W6/W7 并行，但手工 CASE 必须排在 W8 之后（第 5 节步骤 11）。

## 4 测试改动

- `tests/relay.test.mjs`：新增跃迁断言：
  - 非空写入 `fullFlow === true`；
  - handoff 保持 `true`；
  - promoted 变 `false`；
  - view/error 不变；
  - 旧快照推导。
- `tests/stage-flags.test.mjs`：补 `copyRelay`/`isValidRelay` 的兼容断言。
- `tests/relay-integration.test.mjs`：所有依赖「flags 全 false 时 S5 被挡」的用例，先在
  `stateFor(ctx).state.relay.fullFlow = true`；新增 simple 路径用例。
- `tests/integration.test.mjs`、`folding-economics.test.mjs` 使用 `allStagesRan()` 的地方不变，
  因为 fullFlow 默认 false 时 S5 本就放行。
- `tests/prompts.test.mjs`：若校验资源段落集合，更新期望。
- `tests/prompts.test.mjs`（本轮新增）：钉住 `stages.header` 不再含 `no stage gates another`，
  且必须同时出现 `full flow`、`direct-execution` 与前三阶段名；`persistentOperatingSkill`
  必须含同一条件句，防止两处再次漂移。
- `tests/relay-integration.test.mjs`（本轮新增）：todo 的 `details.relay.fullFlow` 在写入后为
  `true`，证明快照投影完整。
- `tests/full-flow.test.mjs`（本轮新增）：promoted 之后 `relayStatusText` 的 Flow 行仍为真，
  不再出现「no ledger submitted」一类历史断言；simple 的 `next` 文案保留「写账本会开启
  全流程」。
- `tests/integration.test.mjs`（本轮修订）：把钉住旧 simple 文案的断言改为新措辞。
- `tests/full-flow.test.mjs`（本轮新增）：promoted 首次空账仍 `fullFlow === false`；同一持有者
  再次空账为 `reopened`、`fullFlow === true`、`canStop === true`，且不触发 handoff。
- `tests/full-flow.test.mjs`（本轮新增）：第二轮完整循环；`invalidatePromotion` 之后的空账
  必须返回 `handoff` 而非 `reopened`，第二轮 promoted 后 `fullFlow === false`。

## 5 验证

按顺序执行，最后一条之前不重复跑：

1. `bun test tests/relay.test.mjs tests/stage-flags.test.mjs`（纯函数跃迁）。
2. `bun test tests/relay-integration.test.mjs tests/integration.test.mjs`（门控与停止）。
3. `bun test tests/prompts.test.mjs`（资源段落）。
4. `bun test tests`（全量）。
5. `bunx eslint .`。
6. 手工：按 `docs/acceptance/todo-optional-stage.md` 逐 CASE 执行；工具行为以真实会话返回原文为准。
7. 本轮追加：`rg "no stage gates" resources/` 必须无命中；`bun test tests/prompts.test.mjs
   tests/relay-integration.test.mjs` 通过后再跑全量。
8. 本轮追加：`rg "no todo ledger is submitted" resources/prompts` 必须无命中；先跑
   `bun test tests/full-flow.test.mjs tests/integration.test.mjs`，再跑全量。
9. 本轮追加：`rg "非空写入启用|非空 todo" docs/design` 必须无命中；
   `rg -i "empty list counts as a submission" resources/prompts/tools/todo.md` 必须命中，
   证明空账算提交有直述句，而不是只能从 `## op` 推断。
10. 本轮追加：先跑 `bun test tests/full-flow.test.mjs`，再跑全量；
    `rg -n "CASE-CYCLE-009" docs/acceptance/todo-optional-stage.md` 必须命中，
    且 `rg -n "a second full cycle" tests/full-flow.test.mjs` 必须命中。
11. 本轮追加（手工 CASE 的前置）：`bun run sync:plugin` 必须退出零并在无差异时
    报告一致；重启会话后 `todo({ op: "view" })` 必须出现 `Flow:` 行。缺该行时
    停止验收：当前进程仍是旧安装副本，任何 CASE 结论作废。

## 6 风险与回退

- 旧快照推导可能把「promoted 后又开过 scope」的会话误判为 full。新写入后立即纠正；不改 VERSION。
- 若某测试隐含依赖「默认必须写 todo」，它不是契约测试而是行为假设，按新契约修订，不回退实现。
- 所有新文案段落必须非空，否则 `loadDoc` 会抛错；这是有意的失败关闭。
