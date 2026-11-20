# 设计：todo 可选，全流程按需启用

- 验收对应：`docs/acceptance/todo-optional-stage.md`
- 目标：简单、明确、无需编排的用户任务可以不写 todo，直接开 `direct-execution`（S5）做完即止；
  一旦成功提交 todo 账本，五阶段门控与接力一起启用，并保持到「两空账终结」。
  空账也是账本：它必须走接力交接，因此不能豁免全流程（理由见第 6 节的「simple 的定义」条）。
- 非目标：不修改接力协议本身（generation、firstEvaluation、canStop、handoffPending 的语义）；
  不修改两空账判定；不修改 herd mode；不修改子代理豁免；不引入第二套状态机或事件总线。

## 1 唯一事实源

新增**唯一**开关：`relay.fullFlow: boolean`。

- `false`：simple。S5 不检查 S2/S3/S4 标志；主代理 `rw` 不要求先提交 ledger；
  scope 结束与 session stop 不催 todo；模型可直接写最终答复。
- `true`：full。恢复现有的全部纪律：S5 要求三个标志；本代际首次 ledger 前 `rw` 被拒；
  scope 结束与 stop 按现有接力规则催促。

为什么必须新增字段而不是从 `canStop`/`generation` 推导：`invalidatePromotion` 在终结后的第一次
scope 开始时会把 `canStop` 清成 `false`，`promotionInvalidated` 随后永久为 `true`。仅凭现有字段
无法区分「终结后刚开始的新一轮简单工作」与「接力仍在进行」。把开关独立出来，跃迁点只有两个：

| 事件 | fullFlow |
|---|---|
| 初始 / 继任者首次空账（两空账终结） | `false` |
| 任何成功的写操作（`op !== "view"`，`isError !== true`，含 `list: []` 空账；终结空账除外） | `true` |
| 已 promoted 的持有者再次空账（`reopened`） | `true`（保持 `canStop`，不重开 handoff） |
| 空账 handoff（未终结） | 保持 |
| `beginGenerationAfterHandoff` | 保持 |
| `invalidatePromotion` | 保持 |

`beginGenerationAfterHandoff` 必须保持 `true`：接力尚未终结，继任者仍受门控。
`invalidatePromotion` 必须保持：它只表示「已被 promotion 的持有者又开了 scope」，
不表示全流程结束。

## 2 模块边界与依赖 DAG

```
resources/prompts/*.md
        │ (loadDoc / render)
        ▼
relay/texts ←── relay/state ←── scope/persistence
   │              ▲
   │              │
station/texts     relay/ledger          scope/stage-flags
   │              ▲                         ▲
   │              │                         │
station/nudge   station/handoff-state ──────┘
   │              ▲
   ▼              │
station/gates ── station/controls ── station/station
```

- `relay/state.mjs`：纯数据。拥有 `fullFlow` 的创建、复制、校验与旧快照归一化。
- `relay/ledger.mjs`：纯函数。拥有唯一的跃迁规则。不知道 station、scope、flags。
- `station/handoff-state.mjs`：在 `recordLedgerEvaluation` 内比较翻转，负责把
  `stageFlags` 清零并 `persist()`。这是唯一允许把 relay 事实翻译成 scope 状态的地方。
- `station/controls.mjs`：只读 `relay.fullFlow` 决定两个 gate，不写。
- `station/nudge.mjs`、`station/gates.mjs`：只读 `relay.fullFlow` 决定是否催促，不写。
- `station/texts.mjs`、`relay/texts.mjs`：只读，负责把所有模型可见文案说成同一件事。
- `scope/stage-flags.mjs`：不修改。它仍然只回答「S2/S3/S4 是否跑过」。

## 3 跃迁伪代码

```
applyLedgerEvaluation(relay, phases, options):
  if options.isError or options.op == "view":
      return unchanged                        # view 不启用、不推进
  stats = ledgerStats(phases)
  if stats.empty:
      if promoted(current):                   # generation>0 且未被 invalidate
          if first:                           # 继任者首次空账：两空账终结
              return relay with canStop=true,
                               handoffPending=false,
                               fullFlow=false        # 复位
          return relay with canStop=true,
                           handoffPending=false,
                           fullFlow=true             # 终结后再次写入：重新启用
      return relay with handoffPending=true,
                       fullFlow=true                 # 空账触发了交接，因此全流程必须开着
  return relay with firstEvaluation=nonempty/keep,
                   canStop=false,
                   fullFlow=true                     # 任何写操作：启用全流程
```

`recordLedgerEvaluation`（station，同步）：

```
before = station.state.relay.fullFlow
applied = applyLedgerEvaluation(...)
station.state.relay = applied.relay
if applied.relay.fullFlow !== before:
    station.state.stageFlags = createStageFlags()    # 双向清零
station.persist()
```

双向清零的理由：
- `false → true`：simple 期间偶然开过的 stage、以及任何残留标志，都不构成新任务的证据。
- `true → false`：终结后不把上一周期的 S2/S3/S4 借给下一轮。

`advanceRelayForHandoff` 现有的「新代际清零 stageFlags」保留；`fullFlow` 保持 `true`。

### 3.1 终结协议可重复

第二次「两空账」不是新协议，而是同一段跃迁的第二次执行。三条不变量保证它成立：

1. **handoff 保留 `fullFlow`**：`beginGenerationAfterHandoff` 只重置 `firstEvaluation`、
   `canStop`、`handoffPending`、`promotionInvalidated` 与代际记录，不触碰 `fullFlow`。
   继任者在首次评估前仍受 4.1 两门门控：`todo view` 显示 `Flow: full flow`，`rw` 被
   `RW_BEFORE_LEDGER` 拒绝。
2. **`reopened` 是一次性状态**：终结后再次空账得到 `fullFlow: true`、`canStop: true`；
   此后任何新 scope 的 begin 都会调用 `invalidatePromotion`，把 `canStop` 清成 `false`
   并置 `promotionInvalidated: true`。于是下一次空账不再满足 promoted 条件，必须走
   handoff 分支。若缺这一步，`canStop === true` 会让第二次空账被继续当作 `reopened`，
   终结协议永远无法完成第二轮。
3. **无第二套分支**：第二次 promoted 与第一次是同一个判定
   （`generation > 0 && !promotionInvalidated && (first || canStop)`），代码里没有
   「第二次」的专用路径；可重复性由字段状态自然涌现，而不是特殊处理。

佐证：`tests/full-flow.test.mjs` 的「a second full cycle terminates after a reopened
ledger」逐字段走完两轮，不依赖 station。

## 4 门控契约

### 4.1 `src/station/controls.mjs`

```
if (mainAgent && stage === "direct-execution" && state.relay?.fullFlow === true):
    missing = missingStages(state.stageFlags)
    if missing: return STAGE_FLAGS_UNMET
```

```
RW_BEFORE_LEDGER when
    declared === "rw"
    && station.relayOn(ctx)
    && state.relay?.fullFlow === true
    && state.relay?.firstEvaluation === null
```

缺少 `fullFlow`（旧快照）按 `false` 处理，gate 关闭。子代理的 `mainAgent` 判定不变。

### 4.2 `src/station/nudge.mjs`

顺序必须是：先 `herdMode`/`hasToolCalls` 短路 → 再 scope 内催促 → 再 `fullFlow` 短路。
`fullFlow !== true` 时返回 `{ kind: "none" }`。scope 内仍然催促，因为 scope 必须关闭。

### 4.3 `src/station/gates.mjs` 的 `onSessionStop`

顺序：`herdMode` → `relayOn` → scope 内 `continueFeedback` → `if (relay.fullFlow !== true) return undefined`。
simple 模式允许自然停止，不再要求 ledger。

### 4.4 `src/station/texts.mjs`

- `endText` 的 `relayOn` 实参改为 `relayReady() && !herdMode && fullFlow === true`。
  于是 simple 收尾走 `end.finish`，不出现 `end.todo-outside` / `end.promoted`。
- `skillReceiptText` 增加 `fullFlow` 分支：
  - `fullFlow !== true` 且 scope 内：输出 `receipt.simple-inside`（可直接执行，无需 todo）。
  - `fullFlow !== true` 且 scope 外：输出 `receipt.simple-outside`（可以写最终答复）。
  - `fullFlow === true`：保留现有 `receipt.no-ledger` / `receipt.todo` / `receipt.can-stop`。
- `insideScopeNudge` 不变。

### 4.5 `src/relay/texts.mjs` 与资源

`relayStatusText` 增加一行 `status.flow`，取值来自 `labels.md` 的 `flow-simple` / `flow-full`。
`nextStepText` 在 `fullFlow !== true` 且没有 action 时返回新增的 `next.simple`，不再输出
「用写操作提交 ledger」这类催促。

需要同步修改的资源（段落名必须与 `loadDoc` 的 `## section` 规则一致）：

- `resources/prompts/system.md#persistent-rules`：把「rw 在首个 ledger 前一律被拒」
  「outside scope 必须 todo」改成条件句。
- `resources/prompts/system.md#outside-scope`：增加「fullFlow 关闭时，scope 全关后可直接答复」。
- `resources/prompts/stages.md#header`：五阶段协议从 todo 账本（任何成功写操作，含空账）
  开始；simple 任务直接 S5。
- `resources/prompts/tools/scope.md#tool`、`#begin.permission`：两个 gate 的条件化说明。
- `resources/prompts/tools/todo.md#tool`：view 不启用；任何写入（含 `list: []`）启用；
  两空账终结复位；再次写入重新启用。
- `resources/prompts/errors.md#rw-before-ledger`、`#stage-flags-unmet`：文案点明这是
  fullFlow 启用后的结果。
- `resources/prompts/receipts/relay.md`：新增 `status.flow`、`next.simple`；
  `next.promoted` 增加复位说明。
- `resources/prompts/labels.md`：新增 `flow-simple`、`flow-full`。
- `resources/prompts/receipts/scope.md`：新增 `receipt.simple-inside`、`receipt.simple-outside`。

`src/tools/todo-description.mjs` 从资源读取，无需改代码。

### 4.6 持久化兼容

不提升 `VERSION`，避免丢弃既有 scope 历史。`copyRelay` 对缺失 `fullFlow` 的旧快照做一次性推导：

```
fullFlow = source.canStop === true
    ? false
    : source.generation > 0 || source.handoffPending === true || source.firstEvaluation !== null
```

`isValidRelay` 接受 `undefined` 或 `boolean`。新写入后永远显式携带布尔值。

### 4.7 提示词门禁的事实源

门禁只有一个实现事实源：`controls.mjs` 里 `state.relay.fullFlow === true` 两个条件。文案不得
复制这份判断，只许复述其条件形状。

- **`resources/prompts/stages.md` 的 `header`**：阶段协议的权威描述。第一段把「任意顺序」限定为
  simple 模式，并写明 full flow 中 `direct-execution` 要等 `acceptance-cases`、
  `architecture-design`、`orchestration-plan` 各跑一次。第三段继续承担「协议只在 full flow 运行」。
- **`resources/prompts/system.md` 的 `persistent-rules`**：每轮都注入的速查行。只复述同一条件：
  full flow 下 S5 需要前三阶段，simple 模式不过此门。它不引入新规则。
- **`resources/prompts/tools/scope.md` 的 `begin.stage`**：工具参数说明，保留同一条件句；它是
  模型在调用点上看到的第三处复述，措辞可以更短。
- **`resources/prompts/errors.md` 的 `stage-flags-unmet`**：拒绝时的即时解释，必须说明该门只在
  full flow 生效，simple 模式可直接开 S5。

三处复述若不一致，以 `controls.mjs` 为准，并视作缺陷修复，而不是「文案风格」问题。

**快照投影完整性**：`src/tools/todo.mjs` 的 `relayDetails` 是 relay 在 transcript 里的投影，
必须包含唯一开关 `fullFlow`。缺字段时 `copyRelay` 只能按旧快照推导，而
「promotion 后又被 `invalidatePromotion` 清掉 `canStop`」这一合法状态会被误判为 full flow。
投影不是第二条事实源，而是同一事实的完整拷贝。

## 5 CASE 映射

| CASE | 由谁满足 | 证据 |
|---|---|---|
| SIMPLE-001 全新会话直接 S5 | 4.1 两个 gate + 4.2/4.3 stop 短路 + 4.4/4.5 文案 | `scope` 成功原文；无 `RELAY STATE` 催促 |
| TODO-002 提交 todo 账本（含空账）启用全流程 | 3 跃迁 + `recordLedgerEvaluation` 清零 flags + 4.1 | `STAGE_FLAGS_UNMET` 三缺清单 |
| TWOEMPTY-003 两空账复位 | 3 的 promoted 分支 | `Can stop now: yes` 且 `Flow: simple` |
| REOPEN-004 再开 todo 再启用 | 3 的 false→true 翻转为空 flags | 第二次 `STAGE_FLAGS_UNMET` |
| ESCAPE-005 空账不得当出口 | 3 的 handoff 分支保持 fullFlow=true | `Handoff pending: yes`、S5 仍被挡 |
| PROMPT-006 文案与行为同源 | 4.4/4.5 全部资源 | 注入文本与资源行号 |
| PROMPT-007 门禁文案与门禁一致 | 4.7 三处复述 + `controls.mjs` 唯一判断 | `STAGE_FLAGS_UNMET` 原文与 header 原文对照 |
| TWOEMPTY-003（扩展：继任者继承） | 3.1 不变量 1 + 4.1 `RW_BEFORE_LEDGER` | 继任者 `Flow: full flow`；`rw` 被 `RW_BEFORE_LEDGER` 拒绝 |
| CYCLE-009 第二轮两空账 | 3.1 不变量 2/3 + 3 的同一三支 | 第二次 `handoffPending: yes`；继任者 `Flow: simple` |

## 6 风险与假设

- **旧快照一次性偏差**：升级时处于「promoted 后、invalidatePromotion 已发生」的旧会话会被推导成
  `fullFlow=true`。新状态写入后立即纠正。记录，不迁移。
- **空账与 fullFlow=false 的非法组合**：空账的 handoff 分支必须写 `fullFlow: true`，因为空账
  本身触发了接力。若它保持 `false`，`onSessionStop` 与 `nudgeDecision` 的 `fullFlow` 短路会
  先于 `handoffPending` 处理，空账就成了绕过接力的出口；而把 `handoffPending` 检查提到短路
  之前，则等于把一条协议规则拆成两处判断。promoted 分支显式写 `handoffPending:false`，
  让 `fullFlow=false` 只出现在初始与终结两处。
- **simple 的定义以开关为准，不以历史为准**：`fullFlow` 是唯一开关，所以 simple 描述的是
  当前这一轮任务，而不是「过去是否提交过账本」。继任者首次空账（终结）之后 `fullFlow` 回到
  `false`，但本会话刚刚提交过账本；任何仍以「从未提交账本」表述 simple 的文案都会在此刻
  造假。受影响的模型可见字符串是 `labels.md#flow-simple`、`receipts/relay.md#next.simple`、
  `receipts/scope.md#receipt.simple-inside` 与 `#receipt.simple-outside`；统一措辞为
  「本轮任务不需要账本」，并保留「写账本会开启全流程」。验收见 `CASE-LEDGER-008` 步骤 7。
  同理，「什么开启全流程」只有一个事实：任何成功的写操作（`op !== "view"`、
  `isError !== true`），空账不豁免；代码、验收与本设计的跃迁表必须说同一句话。
- **终结后的再次写入**：继任者首次空账把 `fullFlow` 置回 `false`；同一持有者之后再次提交
  空账（action `reopened`）必须把 `fullFlow` 置回 `true`，同时保留 `canStop: true`，不重开
  handoff。`fullFlow=true` 且 `canStop=true` 是合法的「已终结但已再次提交账本」状态：
  `onSessionStop` 与 `nudge` 仍放行最终答复；只有新 scope 的 `invalidatePromotion` 会清
  `canStop`，随后 S5 重新受三阶段门控。非空写入本来就走 `fullFlow: true`，行为不变。
- **原子性**：todo 禁止在 scope 内调用，所以 `recordLedgerEvaluation` 的跃迁与 `stageFlags`
  清零发生在没有活动 scope 的同步段内；不存在半更新窗口。
- **失败隔离**：`fullFlow` 字段损坏时 `copyRelay` 归一为 `false`，最坏结果是流程变宽松而不是卡死；
  `isValidRelay` 仍拒绝其他损坏的 relay 字段。
- **Chesterton's Fence**：`advanceRelayForHandoff` 的清零、`missingStages`、`promotionInvalidated`
  全部保留；只增加一个正交开关，不重写既有语义。
- **投影漏字段**：`relayDetails` 一旦漏掉 `fullFlow`，持久化详情里的 relay 无法还原
  simple-after-promotion 状态；当前没有消费方，仍按契约补全，避免未来恢复路径接上时静默误判。
