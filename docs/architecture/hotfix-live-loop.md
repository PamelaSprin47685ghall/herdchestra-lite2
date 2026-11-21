# 架构：live loop 历史对齐热修

本文只写结构、契约与失败边界。验收面在 `docs/acceptance/hotfix-live-loop.md`，
现象证据是 `~/.omp/logs/omp.2026-11-21.3900027.log` 第 70 行。

## 1. 问题边界

`beforeModelCall` 钩子拿到两样东西：

- `context.messages`：宿主为本次模型调用准备的请求上下文，是活循环
  `currentContext.messages` 经 `transformContext` 与 `convertToLlm` 之后的投影；
- `messagesOf(session)`：`session.agent.state.messages`，已提交历史。

主机源码（`/home/kunweiz/Desktop/vibe/oh-my-pi/packages/agent/src/agent-loop.ts`）说明两者
必然不同步：

- 循环开始时 `currentContext.messages` 是 `context.messages` 的副本（约 667 行）；
- assistant 与 toolResult 先进入活循环，再由 `message_end` 事件异步写入 Agent 历史；
- `agent-session.ts` 的 `settleInFlightMessagePersistence()` 只等待已经登记的
  `#pendingMessageEndPersistence`，不等待尚未开始处理的事件处理器。

因此钩子可能看到两种合法的未对齐形状：

1. **半提交帧**：assistant 帧已提交，它的 toolResult 还在 pending 区。此时
   `pending` 以 `toolResult` 开头。
2. **插话帧**：用户 steer 先进入活循环，assistant 输出随后进入，而 steer 的事件尚未
   提交。此时 `pending` 是「输入 + assistant 帧」。

旧实现只隔离 pending **开头**的 assistant 帧，其余非输入角色一律抛
`CONTEXT_PREPARATION_HISTORY_MISMATCH`。于是这两种合法形状都会中止整轮，这就是
用户遇到的 bug。

## 2. 模块与依赖

```
agent-loop (host)
   │  beforeModelCall(context)
   ▼
host/context-preparation.mjs
   ├── splitRequestHistory()      纯函数，唯一的对齐判断
   ├── prepareState()             钩子策略：写回执、延迟、或拒绝
   ├── host/adapter.mjs           messagesOf(session)
   └── host/diagnostics.mjs       record(domain, message, detail)
   ▼
station.prepareRequest()          回执；返回 null 表示本次不写回执
   ▼
host/hack-context.mjs             commitSkillReceipt()，只有对齐成功才调用
```

依赖方向不变：`context-preparation → adapter/diagnostics/hack-context`；
它不知道 station 的内部状态，只调用 `prepareRequest`。

## 3. 契约

### 3.1 `splitRequestHistory(messages, committed)`

```js
{ prefix, pending, recovered, frameInFlight }
```

- `prefix`：已提交前缀，定位算法不动（尾引用、`sameAssistantFrame`、结构化深比较）。
- `pending`：只含输入角色（`user`、`developer`、`custom`、`fileMention`、`hookMessage`）。
- `recovered`：从 pending 中隔离掉的 assistant 帧及其配对的 toolResult，按原顺序；
  可以出现在输入之前或之后。
- `frameInFlight`：为 true 时表示 pending 里的 toolResult 属于 `prefix` 末尾的
  assistant 帧；本次调用不得插入回执。

判定规则：

1. 提交尾巴找不到、位置不唯一、结构化歧义 → 抛 `CONTEXT_PREPARATION_HISTORY_MISMATCH`。
2. pending 中的 assistant 帧整体隔离；其后的 toolResult 必须属于该帧声明的
   `toolCall.id`，否则抛错。
3. 在任何待定 assistant 帧之前出现的 toolResult：若其 `toolCallId` 属于 `prefix`
   中最近的 assistant 帧，则置 `frameInFlight` 并从 `pending` 移除；否则视为孤立结果，
   抛错。
4. 任何未知角色 → 抛错。
5. 不修改 `messages` / `committed` 及其元素；返回新数组。

### 3.2 `prepareState()` 的策略

1. 调 `splitRequestHistory`。
2. `frameInFlight` 为 true：**不改写 `context.messages`、不调用 `station.prepareRequest`**；
   调 `record("context", "Deferred request preparation for an in-flight tool frame.", detail)`
   后正常返回，模型调用继续。下一次调用若帧已提交，回执照常写入。
3. 否则照常：`prepareRequest` → `commitSkillReceipt` → `context.messages = [...committed, ...pending]`；
   `recovered` 只进诊断，不进模型输入。

### 3.3 回执的边界

延迟只影响**当前一次**模型调用。延迟期间不写 journal、不改 live 历史、不动 station 状态，
没有需要回滚的东西。回执缺席一次意味着这一轮少了预算/阶段提醒；这个代价远小于中止整轮。

## 4. 失败隔离

- 对齐失败按调用隔离：一次延迟不影响下一次，也不影响其他会话。
- 孤立 toolResult、未知角色、提交尾丢失/歧义仍在中止路径上：它们无法被安全重建。
- 诊断环记录隔离与延迟的角色、计数与 toolCallId，下一次复现可定位。

## 5. 与验收的映射

| 设计点 | 验收 |
| :--- | :--- |
| 半提交帧不再中止 | CASE-LIVE-LOOP-01：交接压缩后的续跑轮次跑完 |
| 插话帧被隔离且输入保留 | CASE-LIVE-LOOP-01 的 steer 非快乐路径；新增单元用例 |
| 原样放行不写回执、不改上下文 | CASE-01 的日志里不再出现 provider error；JSONL 不出现重复/丢失消息 |
| 真实损坏仍拒绝 | CASE-LIVE-LOOP-02 的三组坏输入全部抛 `CONTEXT_PREPARATION_HISTORY_MISMATCH` |
| 默认严格的定位算法不变 | 现有 `tests/context-preparation.node.test.mjs` 的拒绝用例继续通过 |

## 6. 假设与风险

1. **假设**：宿主在钩子返回后直接使用 `context.messages` 发请求。证据是
   `agent-loop.ts:1460-1463` 先 `prepareProviderCall` 再 `beforeModelCall(context)`，
   中间没有第二次投影。
2. **假设**：延迟一次不丢消息。延迟不触碰任何数组，只有宿主自己的推进。
3. **风险**：若宿主连续多轮停在 `frameInFlight`，回执会连续缺席。诊断环留痕；取舍是
   「少一条提醒」优于「中止整轮」。
4. **风险**：隔离插话帧会把一条尚未持久化的 assistant 回答从**本次请求**中移除；
   它仍留在 live loop 与 journal 里，下一次请求会以已提交身份出现。代价是这一次模型
   看不到自己刚说的话，而不是永久丢失。
5. **边界**：`frameInFlight` 的判定用 `prefix` 中最近一条 assistant 的 toolCall id；
   若该帧没有 toolCall，pending 的 toolResult 一律是孤立结果，仍然抛错。
