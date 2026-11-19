# 设计：代际交接清空阶段标志，子代理豁免顺序门禁

本文回答 **what**：两处行为变更落在哪几个模块、模块契约是什么、每个
CASE 由哪一处代码满足、失败如何隔离。过程编排见
`docs/orchestration/stage-gates-fix.md`；验收体验见
`docs/acceptance/stage-gates.md`。

## 1. 现状与真源（审计先行）

现有实现只有一条门禁链：

```
scope tool ──> station/controls.mjs handleScopeCall
                 ├─ herdMode 校验 stage 合法性
                 ├─ stage === "direct-execution"
                 │    └─ missingStages(state.stageFlags)
                 │         └─ 非空 → errorResult("STAGE_FLAGS_UNMET")
                 └─ beginScope(...) 成功后
                      └─ state.stageFlags = applyStageBegin(state.stageFlags, stage)
```

- `src/scope/stage-flags.mjs` 是标志的唯一纯数据真源：
  `createStageFlags()` 三项全 false；`missingStages()` 按工作流顺序列出缺口；
  `applyStageBegin()` 规定 S1 清零、S2/S3/S4 置位、S5 不变。
- `src/scope/state.mjs` 的 `createState()` 初始化 `stageFlags`；
  `src/scope/persistence.mjs` 序列化并在损坏时退化为三项全 false。
- `src/station/handoff-state.mjs` 的 `advanceRelayForHandoff()` 是代际推进的
  唯一事务点：`beginGenerationAfterHandoff()` 重置 relay，随后 `persist()`。
- `src/host/policy.mjs` 的 `agentPolicy(ctx)` 是会话身份的判定真源，
  返回 `MAIN_AGENT | READ_ONLY_SUBAGENT | READ_WRITE_SUBAGENT`；
  `station.policy(ctx)` 是它的缓存门面，未知会话保守落在 `MAIN_AGENT`。

两处缺陷的根因：标志的**生命周期**只挂在 S1 上，没有挂在代际交接上；
标志的**作用域**隐含为"全进程"，而它实际只该描述主代理这条工作线。

## 2. 设计决定

### 决定 1：代际交接即清空三个标志

`stageFlags` 描述的是**当前这一代 holder 的工作线**是否依次跑过 S2–S4。
代际一旦推进，上一代的三个阶段跑法与新一代的意图无关：继任者可能重新
框定问题、换方向、只做其中一部分。因此清零点放在代际推进事务内，与
relay 代际增加同一时刻完成并一起持久化。

契约：

```
advanceRelayForHandoff(station, options)
  前置：relay 存在且 handoffPending 且非 canStop，代际匹配
  行为：relay <- beginGenerationAfterHandoff(relay, ...)
        stageFlags <- createStageFlags()        # 三项 false
        persist()
  失败：前置不满足时返回 false，不改 relay，不改 stageFlags
```

不新增 `resetStageFlags()` 之类的第二真源：`createStageFlags()` 已经是
"三项全 false"的唯一表达，重复包装只会给未来留下两份可漂移的定义。

被否决的替代方案：

- **挂在 `truncateForHostBoundary` 上**。否决：宿主边界也用于非交接的
  压缩恢复，那里清空会让同一代 holder 莫名丢掉已跑阶段。现有测试
  `the host boundary keeps the flags` 明确要求边界保留标志。
- **挂在 `decision-framing` 上**（即让继任者的 S1 顺带清零）。否决：
  继任者未必先开 S1；herd 模式下 S1 也是唯一合法阶段，两者耦合会把
  "交接"与"herd 模式"绑死。
- **在 relay 状态里保存标志**。否决：`stageFlags` 是 scope 生命周期状态，
  relay 是账本协议状态；合并会造成 Parnas 所说的按变更原因错分模块。

### 决定 2：子代理豁免整个顺序门禁，且不写标志

子代理是宿主派生的独立会话，通常只做一件被切好的事，且没有跨代
账本。要求它先跑 S2–S4 再开 S5 只会把主代理的纪律错投到一个不同的
生命周期上。设计上把 `stageFlags` 明确定义为**主代理专属状态**：

- 读侧：`STAGE_FLAGS_UNMET` 校验只在 `station.policy(ctx) === MAIN_AGENT`
  时执行。
- 写侧：`state.stageFlags = applyStageBegin(...)` 两处（begin-only 与
  end+begin）同样只在 `MAIN_AGENT` 时执行。

判定用 `!== MAIN_AGENT` 而非 `=== READ_WRITE_SUBAGENT`：旧会话可能没有
`readOnly` 字段、被保守分类为只读子代理；两种子代理都该豁免，且
"非主代理即豁免"与 `host/policy.mjs` 的三值枚举一一对应，不引入第四种
分支。未知会话仍落在 `MAIN_AGENT`，门禁保守执法（poka-yoke 方向正确：
宁可多拦，不可误放）。

实现上复用仓库既有的子代理判定模式，不新造开关：`gates.mjs` 的
`onAssistantMessage`、`onMessageEnd`、`onToolCall`、`onContext` 早已以
`station.policy(ctx) === READ_ONLY_SUBAGENT` 早退，`station.mjs` 的
`syncTodo` 与 `relayOn` 也只在 `policy(ctx)` 的裁决上动作。这里把同一门面
用在阶段校验上：读侧与写侧都只问"是不是主代理"，与 relay 的开关判定同源，
因此不会出现两处策略分叉。

不做的两件事：

- 不为子代理新建一套 `stageFlags` 副本。子代理的 scope 顺序没有任何
  跨 scope 约束，复制状态只会制造无人读取的账本。
- 不在豁免后顺手放宽主代理。CASE-GATE-2 的"豁免不外溢"由会话身份
  保证：每个会话有独立的 station 与独立持久化文件，子代理写不到主
  代理的 state。

## 3. 模块边界与依赖 DAG

```
scope/stage-flags.mjs       纯数据：三项标志的创建、复制、缺口、迁移
        ▲                       ▲
        │                       │
scope/state.mjs ── scope/persistence.mjs      (初始化与磁盘格式)
        ▲
        │
station/controls.mjs ─── host/policy.mjs（经 station.policy(ctx)）
        │                  ↑ 判定会话身份的唯一真源
        │
station/handoff-state.mjs ── relay/ledger.mjs（beginGenerationAfterHandoff）
```

依赖是单向的：`stage-flags` 不 import 任何 station 模块；`controls` 与
`handoff-state` 都只读 `createStageFlags` / `missingStages` /
`applyStageBegin`。两个写入点互不 import，靠同一份纯函数保持一致。

新增的跨模块约定只有一条：**`stageFlags` 只描述主代理当前代际**。
它是本轮唯一需要新读者（`controls` 的豁免分支、`handoff-state` 的清零）
理解的不变量。

## 4. 每个 CASE 由什么满足

| CASE | 满足位置 | 机制 |
|---|---|---|
| CASE-GATE-1 | `station/handoff-state.mjs` 的 `advanceRelayForHandoff` | 继任者第一次开 `direct-execution` 时，`missingStages` 读到三项全 false，返回 `STAGE_FLAGS_UNMET` 并列出三项；重开三段后放行 |
| CASE-GATE-2 | `station/controls.mjs` 的校验分支与两处写入分支 | `station.policy(ctx) !== MAIN_AGENT` 时跳过 `missingStages` 检查且不写标志；乱序、回退、重复开启不受门禁约束（仍受既有的 scope 边界规则约束） |
| CASE-GATE-3 | `station/controls.mjs` 的校验时机 | 校验在任何 `closeScope`/`beginScope` 之前，组合调用失败不关闭原 scope；主代理 `stage === "direct-execution"` 时清单与顺序由 `missingStages` 决定，不因豁免分支而改变 |

## 5. 失败隔离

- **校验失败**：函数在 `beginScope` 之前返回 `errorResult`，不改
  `scopes`、不改 `stageFlags`、不改预算。组合调用（`end: true` + `begin`）
  的失败因此天然原子。
- **代际推进失败**：`advanceRelayForHandoff` 的前置检查（无 relay、
  非 pending、已 canStop、代际不匹配）任一不满足即返回 `false`，既不
  推进 relay 也不清标志——不会出现"标志清了但代际没动"的半状态。
- **持久化失败**：沿用既有 `persist()` 路径；标志与 relay 同一次写入，
  重启后要么是旧代际齐全状态，要么是新代际全 false 状态。
- **策略判定失败**：`agentPolicy` 对缺字段的会话保守返回
  `READ_ONLY_SUBAGENT`（旧式）或 `MAIN_AGENT`（完全未知）；两种结果都不会
  放宽主代理门禁。

## 6. 假设与风险

- 交接后必须重开三段，成本是三个 scope 的开销（产物已 pin，不必重做
  分析）。这是用户显式要求的纪律，不作为风险处理。
- 若宿主在子代理会话中不写 `session_init`，`station.policy(ctx)` 会读
  运行时 `ctx.agent` 兜底；两者皆无时视为主代理，子代理将被误拦。
  这是既有分类器的行为，不在本次修正范围内扩大。
- 现测试 `tests/stage-flags.test.mjs` 断言"host boundary keeps the flags"，
  与本次设计相容，不改。需新增：交接清空、子代理豁免、主代理仍拒。
