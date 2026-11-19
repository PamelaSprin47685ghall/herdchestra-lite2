# 施工计划：代际交接清空阶段标志 + 子代理豁免顺序门禁

本文回答 **how**：如何把 `docs/design/stage-gates-reset-and-subagent-exemption.md`
的两项决定做进代码。它是执行过程本身的设计，不是产物结构设计。

## 1. 状态与数据

计划只依赖三个既有数据：

```
state.stageFlags : { "acceptance-cases": bool, "architecture-design": bool,
                     "orchestration-plan": bool }   // 主代理当前代际的既有证据
state.relay      : { generation, handoffPending, canStop, ... }
policy(ctx)      : MAIN_AGENT | READ_ONLY_SUBAGENT | READ_WRITE_SUBAGENT
```

不引入新字段，不引入新持久化键，不引入新模块。所有状态仍是
`controls.mjs` 与 `handoff-state.mjs` 直接读写的那几个对象。

## 2. 任务切片（两个 worker 可并行，本仓库实际只用一名）

切片边界按**文件所有权**划分，互不共享可变状态：

| 切片 | 文件（唯一所有者） | 输入 | 输出 | 停止条件 |
|---|---|---|---|---|
| W1 代际清零 | `src/station/handoff-state.mjs` | 设计文档决定 1 | `advanceRelayForHandoff` 在推进成功后把 `stageFlags` 置为 `createStageFlags()`，再 `persist()` | 该文件再次导出同样的四个函数，且无 `stageFlags` 之外的写入 |
| W2 子代理豁免 | `src/station/controls.mjs` | 设计文档决定 2 | 读侧 `STAGE_FLAGS_UNMET` 校验与写侧两处 `applyStageBegin` 都以 `station.policy(ctx) === MAIN_AGENT` 为前提 | `handleScopeCall` 签名与导出不变，校验仍位于任何状态变更之前 |
| W3 测试 | `tests/stage-flags.test.mjs`（新增用例）、`tests/integration.test.mjs` 或新文件 `tests/stage-gates-policy.test.mjs` | W1、W2 的最终接口 | 三条行为断言：交接后三标志 false；读写子代理直开 S5 成功；主代理直开 S5 被拒 | 用例在未修改实现时失败、修改后通过 |
| W4 文档同步 | `docs/design/stages.md`、`CHANGELOG.md` | W1、W2 | §3/§4 补两条规则；CHANGELOG 记两项行为变更 | 文档不再与代码矛盾 |

W3 依赖 W1/W2 的接口，但**不需要**它们先完成才能写：用例按目标行为先写，
预期先红后绿。W4 只改文字，可与 W1/W2 同时进行。因此并行度为 3，串行
部分只有"跑测试 → 若红则修实现"。

## 3. 文学化伪代码

```
PROCEDURE advanceRelayForHandoff(station, options):
    relay <- station.state.relay
    IF relay = null OR NOT relay.handoffPending OR relay.canStop: RETURN false
    IF options.expectedGeneration 是整数 AND ≠ relay.generation: RETURN false
    station.state.relay <- beginGenerationAfterHandoff(relay, {...})
    station.state.stageFlags <- createStageFlags()      # 新代际，三段重新计
    station.persist()                                    # 一次写入，原子可见
    RETURN true

PROCEDURE handleScopeCall(station, call, ctx, ...):
    ...
    isMain <- station.policy(ctx) = MAIN_AGENT
    IF hasBegin AND stage = "direct-execution" AND isMain:
        missing <- missingStages(state.stageFlags)
        IF missing 非空: RETURN errorResult("STAGE_FLAGS_UNMET", ...)
    ...（beginScope 之后）
    IF isMain: state.stageFlags <- applyStageBegin(state.stageFlags, stage)
```

关键顺序约束：`isMain` 必须在**校验之前**求值一次，并在两处写入判断中复用
同一个值，避免一次调用内策略抖动导致"读了主代理、写了子代理"。

## 4. Safety 不变量

- **S1 校验前置**：`STAGE_FLAGS_UNMET` 的返回发生在 `closeScope` /
  `beginScope` 之前，任何 `scope` 状态改动只能是零。
- **S2 单事务**：`stageFlags` 的清零与 relay 代际推进在同一次
  `persist()` 之前完成，磁盘上不会出现"新代际 + 旧标志"。
- **S3 不越权**：子代理会话的 `stageFlags` 永远保持 `createStageFlags()`
  初始值；主代理的 `stageFlags` 不会被任何子代理会话改写（各自独立
  station 与独立持久化文件）。
- **S4 幂等**：`advanceRelayForHandoff` 的前置检查使重复调用返回 `false`
  且不改变状态；`applyStageBegin` 对已置位阶段是幂等的。
- **S5 保守默认**：`station.policy(ctx)` 为 `MAIN_AGENT` 时门禁执法；
  只有明确判定为子代理才豁免。

## 5. Liveness 不变量

- **L1 交接后可达**：继任者开三段任意顺序都能成功，第四次
  `direct-execution` 必然放行（`missingStages` 为空）。
- **L2 子代理无死锁**：子代理在任何 stage 间的切换都不会被
  `STAGE_FLAGS_UNMET` 阻塞；只受既有 scope 边界规则（同消息 begin+end、
  elder report）约束，那些规则与阶段无关。
- **L3 无唤醒缺失**：拒绝路径不写状态、不发 steer，调用方立即拿到错误
  文本，不需要任何后续事件解除阻塞。

## 6. 验证命令与判据

```
bun test tests/stage-flags.test.mjs
bun test tests/integration.test.mjs tests/stage-contract.test.mjs
bun test                      # 全量，确认无回归
```

新增断言（W3）：

1. `advanceRelayForHandoff` 成功后 `state.stageFlags` 等于
   `createStageFlags()`，即使交接前已置位三段。
2. 以 `session_init` 携带 `readOnly: false` 的会话调 `handleScopeCall`
   开 `direct-execution`：返回成功，`stageFlags` 保持全 false。
3. 同一 harness 下主代理开 `direct-execution`：返回
   `STAGE_FLAGS_UNMET`，且缺失清单为三段、顺序正确。
4. 拒绝后立刻开 `acceptance-cases` 仍成功（状态未被污染）。

## 7. 关键路径

串行分数 = W1 与 W2（各约一次编辑）+ 一次全量测试。W3 的用例写作与 W4
的文字同步与 W1/W2 并行。没有人为批次、没有中间审查交接：W1/W2 完成后
立刻跑测试，红则回到对应文件，绿则合并 W4 并结束。

缩短串行段的唯一措施是**先写实现再写用例**（用例只需一次编辑即命中
目标行为），而不是先写脚手架再返工。
