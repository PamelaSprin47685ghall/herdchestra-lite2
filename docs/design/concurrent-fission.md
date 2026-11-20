# 并发 fission scope 设计文档

> 状态：设计定稿。仅设计，未实现。落地约束见 1.2，验收判据见 12。

## 1. 目标与非目标

`scope({ begin })` 现在只能开一条工作流。本设计让它一次开出 N 条**真同时**执行的工作流（fission），共享同一个会话文件，并在每条流结束时把整段 `begin…end` 机械抄写给下一条流，最终恢复单线。

### 1.1 目标

1. 一次 `scope({ begin })` 传入 `fission` 数组，N 条流同时执行。
2. 每条流有独立的 `intent`、`budget`、`permission`，可选独立 `model`。
3. 内存状态完全独立：scope 栈、预算、`charges`、stage 判定、模型上下文、`modelCaches`、`amend`、`defer`、`pins` 视图。
4. 磁盘只有一份会话文件；流之间只通过文件与抄写相接。
5. 流 K 正常结束后，其整段记录被机械复制到下一条尚未结束的流的当前叶之后，成为它的子 scope。
6. 结束顺序不作假定；每条流把整段抄给下一条仍在运行的流，最后结束的那条接收全部前驱。不重新编号，最终收尾的可能是任何编号。

### 1.2 非目标

- 不改 omp 源码。所有落地都在扩展层，使用公开 API。
- 不引入多父树、图结构或专属合并节点。
- 不做 per-fission 的 `stage`：`stage` 是整批唯一的。
- `pin` 的既有语义不变，只增加跨流传播；`defer` 不跨流；`amend` 在 fission 内禁用（见第 8 节）。
- 不在抄写时做压缩；折叠交给既有经济规则。

### 1.3 设计不变量：`N = 1` 是机制的自然退化，不是特判

这条不变量高于本文其余所有细节。只要它被破坏，设计即视为错误。

它约束的是**行为**，不是入参形状：schema 不再接受旧的无数组形态（见 2.2）。

机制只有一条路径：N 条流、一个租约、一个 FIFO。`N = 1` 时没有专门的代码路径——不是靠分支，而是靠状态：

- 租约无人争用，第一次 `message_start` 就拿到；FIFO 恒空，没有接任、没有缓冲。
- 唯一流的 `begin` 以 `begin` 的回执为父；工作因此是一个子 scope，而不是所有者自己的链。
- N 条流一律由新起的 Agent 执行，所有者不承担任何一条；索引只用于编号，不授予特权。
- 结构上唯一的差别是工作发生在子 scope 里。UI 复用器把它藏起来（8.1），所以屏幕上没有差别。
- 所有者退场后由最后结束的那条流继续；N=1 时就是同一条线换了一个驱动者。
- 无后继可抄：`handoff` 队列为空，不抄写、不重命名、不注入。
- `intent` / `budget` / `permission` / `model` 来自唯一项；记账、门禁、`stage`、`todo`、`relay` 的语义相同。收据多一层子 scope，这是结构差别的直接后果。

**判定标准。** 实现里若出现 `if (flows.length === 1)`、`if (N === 1)` 或任何等价的单流分支，即为设计错误：那是状态没有表达成「空队列自己说完了」。

---

## 2. 参数形状与校验

```js
scope({ begin: {
  stage: "architecture-design",        // 必填，整批唯一
  elder_report: null,                  // 必填可 null，沿用现有语义
  fission: [                           // 必填，至少一项
    { intent: "……", budget: { read: 8, bash: 3, task: 1 },  permission: "rw", model: null },
    { intent: "……", budget: { read: 8, bash: 3, task: 12 }, permission: "ro", model: null },
  ],
}})
```

### 2.1 校验

| 条件 | 结果 |
|---|---|
| `fission` 缺失、为空或不是数组 | `INVALID_FISSION` |
| 任一项缺 `intent` / `budget` / `permission` | `INVALID_FISSION_ITEM` |
| 任一项 `budget` 非「非负整数」映射 | `INVALID_BUDGET` |
| `permission` 不在 `ro` / `rw` | `INVALID_ARGUMENT` |
| `herdMode === true` 且 `stage !== "decision-framing"` | `INVALID_STAGE` |
| 任一项 `permission === "rw"` 且命中现有 rw 门禁 | 沿用 `RW_IN_DECISION_FRAMING` / `RW_BEFORE_LEDGER` |

校验在**任何状态变更之前**完成。任一项不合法，整批拒绝，不留下半开的流。

### 2.2 `fission` 是唯一形态（schema 不兼容旧版本）

`begin.intent`、`begin.budget`、`begin.permission` 不再存在。`begin.fission` 是必填数组，`minItems: 1`：

```js
required: ["stage", "fission", "elder_report", "permission"],
properties: {
  fission: {
    type: "array",
    minItems: 1,
    items: { required: ["intent", "budget", "permission"], … },
  },
  …
}
```

这是有意的破坏性变更：一个 `begin` 只能是「一批流」，不存在「单条流」的另一种写法。旧调用方必须把三个字段搬进 `fission[0]`，没有兼容层。

**`fission` 的长度就是流数，没有批次阈值。** 长度为 1 时机制照常装配一条流，然后自然退化（见 1.3）：租约无人争用、FIFO 恒空、无后继可抄。代码里不该出现按长度分叉的路径。

---

## 3. 状态归属

状态拆成两层：**session**（整批共享）与 **flow**（每条流独有）。

| 状态 | 归属 |
|---|---|
| `scopes` / `currentScope` / `collapses` 的内存视图 | flow |
| `budget` / `remaining` / `spent` / `charges` | flow |
| 当前 stage 判定所用的快照 | flow |
| 模型上下文、消息历史、`modelCaches` | flow（各自的 Agent） |
| `amend` 记录、`defer` 列表 | flow |
| `pin` 视图（`pinSeen` 指纹集合） | flow |
| `herdMode` | session |
| `relay`（generation / handoff） | session |
| `stageFlags` | session |
| `pins`（唯一有序数组） | session |
| 状态条单值（usage / context / token rate / 当前模型） | session；最近写入者覆盖 |
| 状态条累计（总 token / 总花费） | session；跨流累加 |
| 会话文件、`collapses` 的落盘 | 磁盘 |

`createState()` 仍然是唯一的构造入口；fission 时它派生 N 份 flow 视图，全部由新起的 Agent 持有，所有者的视图随退场一起作废（见 5.9）。session 字段一律按引用共享。**没有第二套 state 容器。**

### 3.1 深度由结构导出

`depth` 不进 station 状态，也不写进 entry。渲染层从会话根沿 `parentId` 下行，遇 scope 的 `begin` 加一、遇 `end` 减一，得到每条 entry 的显示深度。

抄写因此是**整段平移**：哥哥那段原样搬过去，它内部的增增减减完全保留，只是整体落在 `targetDepth + 1` 上。不需要逐条计算，也不需要任何 depth 字段。station 永远只操作 flow 自己的栈。

---

## 4. 执行：N 个 Agent + 一个 SessionManager

### 4.1 为什么

`Agent` 是严格单飞的：`prompt()` 与 `#continue()` 在 `isStreaming` 时直接抛 `AgentBusyError`。`AgentSession` 对外只暴露一个 `agent`。所以真并发只能是 **N 个 Agent 实例**，全部新起；所有者只负责调用与退场。

`SessionManager` 没有单飞守卫：认领是进程级且按 `sessionId` 计数（`holders++`），同进程多个使用者共享同一 lease，不会互相搬家。所以磁盘门可以只有一个。

### 4.2 装配

批次是**内存对象**，不写额外的 ledger entry（没有 `fission.batch.begin` 这种标记）：它的 `begin`/`end` 就是普通的 scope entry，由调度器代写。所有流的 `begin` 以 `batch.ackId` 为父，互为兄弟。

```js
// 接线层
const batch = { id: batchId, parentId: P, ackId: beginToolResultId, flows: [] };
batch.flows = begin.fission.map((item, index) => ({
  index,
  label: `${batchId}.${index}`,
  state: createFlowState(base, item),            // 独立 scopes/budget/charges/stage 快照
  agent: spawnAgent(item),                       // N 条流一律新起，索引不授予特权
  tail: batch.ackId,                             // 本流当前叶：begin 的回执之后
  status: "running",
}));
```

每个 Agent 的钩子、事件、`AbortController`、`appendModelUsage(owner)` 全部由接线层逐个装配。共享的只有 `sm`（唯一的 `SessionManager`）与 session 级状态。

`index` 从 0 到 `fission.length - 1` 平等循环：同一个构造函数、同一份装配、同一个 `tail`。索引只出现在 label 与日志里，不改变行为。

**每条流必须带前缀上下文。** `initialState.messages: []` 只是空壳，流不知道自己从哪来、之前谈过什么。装配时要把 `sm.getBranch(batch.ackId)` 转成 `AgentMessage[]` 作为 `initialState.messages`，再追加一条携带本流 `intent` 的 `CustomMessage`。转换规则与 5.5 相同：`message` 与 scope 的 `begin`/`end` 进，`fission.*` 与其余账本不进。

内层批次同理：前缀取到内层回执，天然包含父流的全部上下文。继承者不需要重建——它本来就是按这个前缀装配的，运行中又接收了前驱的注入。

**所有流都不调用 `scope` 工具。** 它们的 scope 状态在装配时就已打开；`scope.begin` / `scope.end` 两条 custom entry 由调度器代写——`begin` 以 `batch.ackId` 为父，`end` 写在自己的 tail 上。`batch.ackId` 是所有者那次 `begin` 调用的工具回执：`afterToolCall` 时回执消息尚未落盘，因此只能登记 `pending-spawn` 并触发退场；等回执的 `toolResult` 落盘且所有者 `agent_end` 落地后，再装配并启动 N 条流。N 条流都挂在回执下面，所以所有者的分支天然经过所有流。

### 4.3 写入纪律

写入分两种场景，不能混用。

**场景一：流在并行执行，写自己的尾巴。** 用原生分支写入，不移动全局叶：

```js
sm.appendMessageToBranch(message, flow.tail, { preserveActiveLeaf: true });
```

非消息类型用临时叶作用域：

```js
function appendAt(sm, tail, write) {
  const saved = sm.getConversationTip()?.id ?? null;
  let result;
  let failure;
  try {
    if (tail) sm.branch(tail); else sm.resetLeaf();
    result = write();
  } catch (error) {
    failure = error;
  }
  try {
    if (saved) sm.branch(saved); else sm.resetLeaf();
  } catch (restoreError) {
    throw new AggregateError([failure, restoreError].filter(Boolean), "leaf restore failed");
  }
  if ((sm.getConversationTip()?.id ?? null) !== saved) {
    throw new AggregateError([failure].filter(Boolean), "leaf not restored");
  }
  if (failure) throw failure;
  return result;
}
```

**场景二：抄写。** 抄写是串行的、目标流独占的调度段，抄写段**就是接收方的新主线**，不是旁支。所以：

```js
sm.branch(target.tail);          // 一次，把叶放到接收方当前位置
sm.appendMessage(message);       // 走全局叶，叶自然推进
sm.appendCustomEntry(type, data);
```

**不能**对抄写段用 `appendMessageToBranch`：它会写下 `activeLeafId` 并把段标记为 off-branch，重载后接收方的主线不经过抄写段，等于抄了一座孤岛。

两种场景的共同前提：**同步段之间不得出现 `await`**。

### 4.4 生命周期

`seal()` 置 `#released = true` 后，所有追加变成 `logger.warn("Dropped session entry…")`。所以共享 `sm` 的 `seal` / `close` 必须包成引用计数：N 条流各持一份，最后一个结束才真正关闭。任何单个 AgentSession 都不得独立 dispose 它。

---

## 5. 合拢：机械抄写

### 5.1 触发

流 K 正常结束时，把整段登记为待抄写。所有流走同一条路径：它们都不调用 `scope` 工具，由调度器在 Agent 跑完最后一个 turn（`agent_end`）且未被取消时，代写 `scope.end` 并登记。没有按编号区分的触发点。

```js
{ handoffId, sourceBeginId, sourceLabel, from: firstEntryId, to: lastEntryId, targetIndex: nextRunning(K) }
```

`targetIndex` 不假定结束顺序，也不重新编号。从 `K` 按编号往后找第一个**子树仍未关闭**的流（`K+1, …, N-1, 0, …, K-1`），跳过已关闭、已取消与不存在的；若一个都没有，`K` 就是最后结束的那条，没有后继，它接收全部前驱。「仍在运行」与「子树未关闭」的差别见 5.10。

**队列按完成顺序出队。** `handoffId` 单调递增，抄写严格按它排。它不单独存表：重载后取所有 `handoff.begin` 里最大的序号加一，即可继续单调；批次内没有历史标记时从 1 开始。多段指向同一接收方时，它们不是兄弟，而是一条链：第一段的 parent 是接收方当时的 tail，第二段的 parent 是第一段的 tail。理由是「哥哥变成儿子」——后到的那段要把先到的整段包进去，而不是并排挂在旁边。

**接收方在抄写前结束，就重定向。** 出队时重新计算 `targetIndex`；若只剩一个 running 流，它接收剩余全部；若所有流都已结束或崩溃，段不抄写，原段留在旁支，`handoff.end` 不写，审计可查。

抄写发生在**接收方下一次被调度之前**，由扩展自己的调度器同步完成。它不依赖 provider 钩子的同步性，也不与任何 `await` 交错。

### 5.2 写入白名单

只抄对模型上下文有意义的类型，其余是会话级元数据，抄过去会重复：

| entry type | 抄写时的写法（叶已在 `target.tail`） |
|---|---|
| `message` | `sm.appendMessage(msg)` |
| `custom`（排除 `fission.*`） | `sm.appendCustomEntry(type, data)` |
| `model_usage` | `sm.appendModelUsage(usage, { sessionId, parentId: target.tail })` |
| `label` | `sm.appendLabelChange(targetId′, label)` |
| `thinking_level_change` | `sm.appendThinkingLevelChange(…)` |
| `mode_change` | `sm.appendModeChange(mode, data)` |
| `branch_summary` | `sm.branchWithSummary(mapId(parentId, ctx), summary, details)`；它自己把叶设到该 id 再写，写完停在 summary 上，正好继续 |

**不抄**：`session_init`、`credential_pin`、`ttsr_injection`、`reset_boundary`。它们是会话级或安全级元数据，复制会改变语义。

**`compaction` 不抄，改为按它裁剪复制窗口。** `appendCompaction` 的 `firstKeptEntryId` 指向源段 id，照抄会让接收方裁掉自己的上下文；而 compaction 摘要是顶层 entry，不是一个能注入的消息。所以：若源段含 `compaction`，复制窗口从最后一个 `firstKeptEntryId` 起，摘要本身写成一条 `CustomMessage`（message entry，`details.fissionCarry = "compaction-summary"`）放在段首，于是它随 message 一起被注入。这样接收方看到的上下文与源模型压缩后看到的等价，文件里也不会出现一条指向别的分支的压缩记录。

**并行场景另写。** 4.3 的 `appendAt` 与 `appendMessageToBranch` 只用于流还在跑的时候；本表描述的是抄写，此时叶已经在 `target.tail`，所有写入直接走全局叶，叶自然推进，不需要恢复。

**`custom` 要排除账本。** `customType` 以 `fission.` 开头的（`handoff.begin` / `handoff.end` / `aborted`）不抄：它们属于各自批次的审计，复制过去会让接收方看到别人的交接记录。

**`model_usage` 的 owner 也重命名。** `owner.parentId` 必须过 `mapId`，否则用量会记到源段上。

抄完后断言：除两个 `handoff` 标记外，新增 entry 的数量与类型序列必须与复制窗口一致。不一致即中止并回滚该段。

**广播的用户消息也不抄。** 判定用 `details.fissionBroadcast.broadcastId`：每条仍在运行的流都已直接收到，抄写再带一遍就是重复的用户指令。

**每条写完后必须推进目标尾。** 所有写入方法都返回新 id；`target.tail = id` 紧跟其后。漏掉这一步，下一条会挂成兄弟而不是子节点，整段抄完就变成一层扁平的兄弟，而不是一条链。

```js
for (const src of segment) {
  const id = writeOne(src, target.tail);   // 返回新 id
  if (id === undefined) throw new Error("handoff aborted");  // appendModelUsage 在会话不符时返回 undefined
  target.tail = id;
}
```

`appendModelUsage` 返回 `undefined` 表示会话 id 或父节点不匹配，此时整段抄写必须中止并回滚，不能跳过继续。

### 5.3 id 重命名

映射是纯函数，不需要表，而且输出必须落在 id 字符集内：

```js
function mapId(oldId, ctx) {
  if (!ctx.segmentIds.has(oldId)) return oldId;
  const base = `${oldId}f${ctx.handoffId.toString(16)}`;
  let id = base;
  for (let salt = 1; ctx.index.has(id); salt += 1) id = `${base}s${salt.toString(16)}`;
  return id;
}
```

**分隔符只能取 id 字符集里的字符。** 自然 id 全在 `[0-9a-f]`：`generateId()` 的正常路径是 `crypto.randomUUID().slice(-8)`（8 位十六进制），回退路径是 `Snowflake.next()`（16 位小写十六进制，`Snowflake.PATTERN` 就是 `/^[0-9a-f]{16}$/`）。所以映射只用 `[0-9a-f]`：前缀原样保留，后接标记 `f` 与 `handoffId` 的十六进制。`\u0000`、`@`、`.` 一律不用——它们会污染 jsonl 之外的消费方（`agent://`、`local://`、文件名）。

**碰撞要检测，不能靠长度赌。** 8 位自然 id 撞不上（长度不同），但 16 位 Snowflake 可能恰好等于「8 位旧 id + `f` + 7 位 handoff 十六进制」。所以映射带盐：从 0 开始，命中已有 id 就在末尾追加 `s` 加盐的十六进制，直到空闲；构造是纯确定性的，不采样。抄写前逐条断言 `^[0-9a-f]+$` 且 `!index.has(newId)`。

**幂等。** 同一 `(oldId, handoffId, index)` 得到同一结果；残段被丢弃后重抄，盐从 0 重扫，通常落在同一个 id 上。即使因索引变化取了不同盐，段内每条 id 都含「`f` + handoff 十六进制」标记，5.4 的残段识别按标记匹配，不按精确 id 比较。

`segmentIds` 是源段全体 id 的集合。跟着重命名的字段：

- `id`、`parentId`
- `label.targetId`
- `branch_summary.fromId`
- toolCall 的 `beginToolCallId`

**`activeLeafId` 一律清除。** 保留它会在重载时把叶拉回源段的位置，等于把接收方的主线改掉。

段外引用保持原值：旧段仍在文件里，指向它不会悬空。

### 5.4 原子性

抄写是「先写 begin 标记，再写数据，最后写 end 标记」：

```js
sm.branch(target.tail);                       // 段首放叶一次
target.tail = sm.appendCustomEntry("fission.handoff.begin", {
  handoffId,
  sourceBeginId,
  source: { from, to },   // 源段在日志里的首尾 id
  target: { tail },       // 接收方锚点；flowId / label 仅作审计
  context: { shift },     // 历史文本的深度平移量
});
// …逐条抄写，每条 target.tail = 新 id…
target.tail = sm.appendCustomEntry("fission.handoff.end", { handoffId, count });
```

两个标记也参与链式推进：它们本身是抄写段的头与尾。`end` 标记写入后，`target.tail` 就停在它上面，接收方后续的工作自然接在子 scope 之后。

重载时：有 `begin` 无 `end` 的 `handoffId`，其全部 entry（id 带同一标记）视为未提交，丢弃后重抄。丢弃走一次 `rewriteEntries()`，只在恢复路径上发生。

这样重试是幂等的：同一 `handoffId` 的残留先被清掉，再完整写一遍。

**记录是重抄的唯一依据。** `begin` 标记必须写全源段范围、接收方锚点与平移量：重载时先用一条 `fission.handoff.abort` 关闭残段，再用同一份记录把源段重抄到记录的 `tail`，退役与重抄在同一个原子批里提交，所以崩溃只会留下「残段未关闭」，下一次重载重试。**只恢复日志结构**：重启后不存在存活的接收方 Agent，`agent.state.messages` 的注入无从发生，下一次会话按分支重建上下文。

**旧记录不虚构。** 老版本写下的 `begin` 只有 `handoffId` 与 `sourceBeginId`，没有源段范围、锚点与平移量。这类记录只退役、不重抄：缺失的字段无法从残段反推，残段本身只是被截断的副本，猜出来的范围会抄一段源流从未产生的历史。恢复结果按条记录 `copied` / `skipped` / `failed` 及原因，审计不把退役当成投递。

### 5.5 进入模型上下文

只写文件等于没抄。抄写完成后，把段内的 `message` 与 **scope 的 `begin` / `end`** 转成 `AgentMessage`，按原顺序 push 进接收方：

```js
target.agent.state.messages.push(...adoptedMessages);
```

`agent.state` 是活引用，`#runLoop` 用 `this.#state.messages.slice()` 构建上下文，所以下一次请求就能看到。

**这条通道只影响模型，不影响屏幕。** 抄写段在源流产生时已经显示过；注入不重放 UI 事件，否则同一段话会在屏幕上出现两次。

**边界要进上下文。** scope 的 `begin` / `end` 是模型必须看见的结构——否则它只会发现自己面前突然多了一段别人的话，却不知道边界在哪、深度怎么变。所以这两条以 `CustomMessage` 的形式参与上下文，与它们在文件里的位置同序。

**账本不进上下文。** `fission.handoff.begin` / `fission.handoff.end` / `fission.aborted` 只进文件：它们记录的是 station 的账，不是对话内容。这与「深度由结构导出」同一条边界——模型看到结构，不看到记账。

**注入前接收方必须空闲。** `#runLoop` 进入循环时对 `this.#state.messages` 做 `slice()`，形成本次请求的快照；循环进行中 push 不会影响当前请求。所以调度器必须等 `target.agent.state.isStreaming === false` 才执行抄写与注入。这不是优化，是注入能否生效的前提。

抄写 → 平移（见 5.7）→ 注入 → 请求，四步在同一个同步调度段里完成，中间不 `await`。

### 5.6 深度

不写 depth 字段。抄写段携带哥哥自己的 `begin` / `end`，渲染层按同一规则推导：内部形状自动保持不变，整体落点自然比接收方深一层。

若显式写 `fissionDepth`，反而会与结构推导冲突——哥哥内部再开子 scope 时，那个字段是平的，等于抹掉了哥哥自己的起伏。

### 5.7 注入文本里的深度数值

三处注入文本硬编码了当前栈深：`insideScopeNudge`（`T["inside-nudge"]`）、`skillReceiptText`（`T["receipt.inside"]`）、`insideScopeText`（`T["inside-text"]`）。模板在 `resources/prompts/receipts/scope.md`，形如 `You are inside scope level {{level}}: …`。这些文本会进入 history，所以抄写段里可能带着旧数值。

平移只做一件事：把 `scope level <n>` 里的 `n` 加上平移量。

```js
const LEVEL_RE = /(scope level )(\d+)/g;
const shift = targetDepth + 1 - sourceBaseDepth;   // 段级常量
text.replace(LEVEL_RE, (_, prefix, n) => `${prefix}${Number(n) + shift}`);
```

`sourceBaseDepth` 是哥哥 `begin` 之前的深度，`targetDepth` 是弟弟当前的深度。两者通常相等（同一父节点分叉），此时 `shift === 1`；但不能硬编码 1——弟弟可能已经自己开了子 scope。

**只动这一种数值。** `{{intent}}`、`{{budget}}`、时间戳、行号一律保持原值：它们描述的是哥哥当时的账，不是当前状态。

**预算不换算，因为子 scope 的额度本来就独立。** 抄写段里的 `Remaining budget` 是哥哥那条流结束前的最后一个快照，既不属于弟弟的池子，也不因抄写而获得新的可花费额度。哥哥结束后余额作废，不回流。弟弟从这段历史里继承的是结论，不是额度。

**读完这段历史不要据此发起调用。** 抄写段以 `end` 收尾，它是一段已经闭合的过去；文本里的预算快照只说明「当时还剩多少」，不说明「现在还能用多少」。

**锚点跟着模板走。** 正则的静态前缀从模板文本提取，不另写一份字符串。模板改措辞时正则跟着改，避免两处分叉。

**平移只作用于历史。** station 的实时回执仍用 `state.scopes.length` 计算。所以弟弟会看到历史里写着 `level 4`，而自己的当前回执写着 `level 3`——这是对的：历史是当时的事实，不是现在的状态。

### 5.8 失败路径

| 情形 | 处理 |
|---|---|
| `target.tail` 已被 discard / rewrite 掉 | `branch()` 抛 `Entry not found`；中止该段抄写，流标记 `handoff-failed`，原段保留 |
| 抄写到一半进程崩溃 | `handoff.end` 未写；重载时按 `handoff.begin` 扫描，丢弃同一 `handoffId` 的残留并重抄 |
| 抄写中 `appendModelUsage` 返回 `undefined` | 会话或父节点不符；中止并回滚该段 |
| 叶恢复失败 | `AggregateError` 同时携带原错误与恢复错误，不吞掉任何一个 |
| 接收方在抄写前结束 | 出队时重定向到下一个 running 流 |
| 全部流结束 | 最后结束的那条接收剩余全部；已崩溃流的前驱不抄写，留作审计 |

任何一行失败都必须让该段回到「未提交」状态。宁可重抄，不可留半段——半段会让深度结构断开，而渲染层只会看到一个不闭合的 `begin`。

### 5.9 批次所有者与流的生命周期

**开启者不承担任何一条流。** 调用 `begin` 的 Agent 只做三件事：校验、登记批次、写回执。然后它永久退场，不再产生 provider 请求；N 条流由同一个循环新起，彼此对称。

回执先落盘，`batch.ackId` 就是它。N 条流的 `begin` 都挂在这个 id 下，所以所有者的分支是 `… → toolCall(begin) → toolResult(begin) → 各流的链`。工具协议因此始终合法：回执紧跟在调用之后，工作发生在回执之后。

**所有者永久退场。** 回执写完后，所有者这一轮就结束，而且**不再恢复**：不产生后续 provider 请求，也不再接收用户输入。它不是被暂停，是退场。

**怎么做到（已核实）。** 在 `afterToolCall` 里把批次标为 `pending-spawn` 并对 scope-begin 这次调用执行 `agent.abort()`。`afterToolCall` 在 `emitToolResult` **之前**被 `await`（`agent-loop.ts:3785`），而工具结果在其后无条件提交，所以回执照常落盘；随后下一轮模型调用随信号一起取消。Agent 的 catch 里 `stoppedForAbort = loopSignal.aborted`、`shouldEmitVisibleError = !stoppedForAbort`，因此不会弹出可见错误。等所有者 `agent_end` 触发时，回执 `toolResult` 已落盘（其 entry id 即 `batch.ackId`），调度器此时启动 N 条流，把它们挂在 `batch.ackId` 下——即使随后落下一条 `aborted` 的 assistant 消息，它也只是回执下的旁支，不在任何一条流的父链上。

**代价：会留一条 `aborted` 的 assistant 消息。** 它不是错误提示，但会进 transcript。接线层要么把它标成不可见，要么接受它作为「这一轮到此为止」的显式标记——后者更诚实，也更省事。

**结束顺序不作假定。** 任何一条都可能先结束。K 结束后，整段抄给按编号往后第一个仍在运行的流；不重新编号，也不假定第 0 条或第 N-1 条收尾。最后结束的那条没有后继，它就是最终的那条线——它的编号可能是 `1..N-1` 中的任何一个，也可能是 0。

**继承者是最后结束的那条流。** 全部流结束后，最后结束的流接管会话：它的 messages 成为主动上下文，它的叶成为活动叶（本来就在所有者分支的延长线上），它的 flow state（`scopes` / `budget` / `charges` / `pins` / `todo`）提升为 session 状态。此后用户输入、状态条、审批都归它。N=1 时继承者就是唯一那条流——批次前后是同一条连续的线，只是驱动它的 Agent 换了一个。

**怎么做到（已核实）：状态收养，不换对象。** `AgentSession.agent` 只在类型上是 `readonly`，运行时是构造器赋的普通属性；但整体替换会让 `tokenRate` 等按旧 agent 绑定的字段失配。更稳的做法是把继承者的状态搬进现有 agent：`agent.reset()` 清空消息与队列，把 `heir.agent.state.messages` 原样 splice 进 `agent.state.messages`，再 `session.setModel(heir.model)`。会话对象、hooks、UI、审批、todo 全都不动，换掉的只是它承载的上下文。`get state()` 返回活引用（`agent.ts:910`），`initialState.messages` 也在构造时被 `slice()` 接受（576），这两点让收养成立。

**模型身份随继承者。** 继承者的模型是装配时的 `resolveModel(fission[last].model)`；`null` 表示沿用批次开启时所有者的模型。所以批次结束后，会话的活动模型可能不是开启者的模型。这是继承的必然结果，不是意外。

**批次 scope 必须在继承者处关闭。** 开启时那次 `scope({ begin })` 写下的 begin 就是批次的 begin；全部流结束后，调度器在继承者的 tail 上代写批次的 `scope.end`，然后才把控制权交出去。不写这一条，继承者的上下文会永远停在「inside scope level 1」——模型以为自己还在一个没关的 scope 里，之后每一次深度判断都会错。

**收尾的严格顺序。** 最后一条流（继承者）`agent_end` 时，必须按以下六步顺序执行，缺一不可：
1. 先把挂在等待队列里所有指向继承者的前驱段抄写到 `heir.tail`，并注入 `heir.agent.state.messages`；
2. 在 `heir.tail` 上代写继承者自身的 `scope.end`；
3. 在 `heir.tail` 上代写批次的 `scope.end`；
4. 状态收养：`owner.agent.reset()` → splice `heir.agent.state.messages` → `session.setModel(heir.model)` → **`sm.branch(heir.tail)`**（把全局叶正式移到 `heir.tail`，否则下一轮用户输入会写到旧叶上）；
5. 把继承者的 flow state 提升为 session 状态；
6. 释放其余非继承者 Agent（不关闭 `sm`）。

**没有流的 `end` 调用。** 所有流的开始与结束都由调度器代写，流本身只跑自己的 turn。批次完成的条件是「没有 `running` 的流」，不是某个编号调用了 `end`。

**流结束后不立即释放 Agent。** 它可能仍是某个待抄写段的接收方，`agent.state.messages` 必须活着才能注入。状态从 `running` 变为 `closed`，Agent 挂起。

**批次结束不等于会话结束。** 继承者还要继续写，所以批次完成时**不关闭**共享 `SessionManager`，也不释放继承者的 Agent；只把其余已 `closed` 的 Agent 释放。`SessionManager` 的生命周期跟会话，不跟批次——引用计数归零（会话真正结束）时才关闭。

### 5.10 递归：一条流可以再开一批

流本身也是一个 Agent，所以它可以再调用 `scope({ begin, fission })`。这不需要新规则——它只是同一套机制在更深的节点上再跑一遍：

- 这条流成为内层批次的开启者：它退场，内层 N 条流挂在它的 `begin` 回执下；全部结束后，最后由结束者继承，并在它的 tail 上代写内层批次的 `scope.end`。
- 内层批次不写额外标记；内层的 `scope.begin` 就是那条流调用 `begin` 时写下的普通 entry。
- 深度自动正确：内层 `begin` 落在父流的分支上，结构推导自然多一层。

**完成的条件是子树，不是自己。** 一条流对内层批次是开启者；对外的「结束」必须等它的整棵子树都没有 running 的流。否则外层批次会在它刚退场时就把半截子树抄给下一条流。判定：

```
closed(f)     = f.agent 已退场 且 f 开启的每个内层批次都已 closed
closed(batch) = 该批次的全部流都已 closed
```

两条定义在树上递归，基底是「没有内层批次的流」：它退场即关闭。

**环只在自己这一层。** `targetIndex` 在兄弟之间计算，不跨层。外层一条流的结束触发父层的抄写；它的内层与自己的兄弟无关。

**抄写按子树整段。** 一条流结束时，它下面的所有入口——内层各流的段、内层的 `handoff` 标记——都在它的子树里，因此整段被外层抄走。`fission.*` 标记仍被排除（5.2）：内层的交接账不进外层，但内层抄过的段本身会跟着走，成为普通子 scope。

**预算按层切。** 内层各流的 `budget` 在内层 `begin` 时立即从父流的 `remaining` 里扣除；内层扣费只扣自己的池，不再重复扣父流。父流退场后剩余未切出的额度作废，不回流。切不出来就拒绝这次 `begin`，返回 `INVALID_BUDGET`。

**stage 是层的属性。** 内层批次可以声明自己的 `stage`，按同一套门禁检查；外层的 `stageFlags` 不回退，也不因内层而改写。

---

## 6. 最小补丁与纪律

### 6.1 补丁清单（全部公开 API）

1. `appendAt`：`branch` → 写入 → `branch`／`resetLeaf` 的同步三段，并带叶恢复断言与错误聚合。
2. 并行写入用 `appendMessageToBranch`；抄写段走全局叶。两者不可互换。
3. `seal` / `close` 引用计数。
4. 压缩由每条流在自己的尾上触发：触发前 `branch` 到自己的 `tail`，压完把叶放回当时的位置。
5. 每个 Agent 自装 `beforeToolCall` / `afterToolCall` / 事件 / `AbortController` / usage。

### 6.2 纪律

1. 同步段内不得 `await`。
2. 并行写入不得直呼 `appendMessage` / `appendCustomEntry`（它们读全局叶）；抄写段是唯一例外，因为那时叶已被放到 `target.tail`。
3. 不得让任何 AgentSession 独立 dispose 共享 `SessionManager`。

三条都可被一条运行期断言覆盖：**并行写入**前后 `getConversationTip()` 必须回到入口值；**抄写段**的叶则必须停在段尾，不回到入口值。两种场景断言相反，正因为它们不是同一种写入。

---

## 7. 逐项定案

| 编号 | 问题 | 定案 |
|---|---|---|
| B1 | state 单例还是每流一份 | session / flow 两层。`createState()` 派生 flow 视图，session 字段按引用共享 |
| B2 | 抄写写入原语 | 白名单 + 抄写走全局叶；抄完断言类型与数量 |
| B3 | 如何进入模型上下文 | 抄写后同步 push 到 `agent.state.messages`；调度器在请求前完成 |
| B4 | 深度 +1 与状态机 | 深度由 begin/end 结构导出，整段平移；不写字段，station 不感知 |
| B5 | id 重命名 | 纯函数 `mapId` + 段内集合；`activeLeafId` 一律清除 |
| B6 | 半段写入 | `handoff.begin` / `handoff.end` 提交标记；无 `end` 即丢弃重抄 |
| B7 | 上下文膨胀 | 抄写不压缩；折叠后置，由既有经济规则处理；抄写段带 `provenance` 可整体压 |

---

## 8. 其余语义

- **permission**：`beforeToolCall` 按 flow 检查。`ro` 只拦写工具（`edit` / `write` / 破坏性 `bash`），读放行。宿主本身不强制，这一层是扩展自己的门。
- **stage 与 stageFlags**：`stage` 在批次开启时校验一次，整批共享。`stageFlags` 仍是 session 级，`direct-execution` 的门禁按现有规则在批次开启时判定一次，不逐流重复；fission 不改变 flags 的语义，也不为某条流单独放行。
- **停止**：`onSessionStop` 在主 agent 结束时会触发，但只要有 `status === "running"` 的流，它必须返回「未完成」，不推进 relay。否则一条流收尾就会宣告整批结束。
- **工具归属**：N 条流都是独立 Agent。station 必须按流身份（`ctx.agent` 或等价的 flow id）路由，不能用全局叶或全局 `currentScope` 推断。
- **用户输入是广播，不是路由。** 批次进行中，输入投给**所有**活跃的叶子流（递归时只投最内层正在跑的流，不投已因开启内层而退场的父流），没有例外。路由到某一条在语义上无法成立：用户不是在对某条流说话。每条流在自己下一次模型调用前收到它（`agent.steer(msg)`，`agent.ts:1477`）。
- **必须标注为广播。** 每条流收到的消息带 `details.fissionBroadcast = { broadcastId, recipients }`，正文以一行 `(broadcast to N flows)` 开头。没有这行标注，流会以为自己被单独点名，后面围绕一个不存在的专属指令推理。
- **界面只显示一次。** 复用器按 `broadcastId` 去重：第一次出现渲染，后续流里的同一份丢弃。否则一次广播会在屏幕上出现 N 次。
- **广播不参与抄写。** 每条流都已直接收到它；抄写再带一遍会让接收方看到同一条用户指令两次，且无法判断哪次更晚。
- **批次结束后归继承者。** 没有 running 流时，输入照常进会话——那时继承者已经接管，它就是普通的主 agent。
- **取消 / 崩溃**：写 `fission.aborted { label, reason }`，不参与合拢，entry 留在旁支；同批其余流继续。
- **model**：每条流由自己的 Agent 持有，不走宿主 `/switch`，因此不触发 `pendingModelSwitch` 与关闭时恢复。所有者被停止后，它的模型字段不再影响会话；继承者的模型成为活动模型（见 5.9）。
- **pin**：`session.pins` 是唯一真相；flow 持 `pinSeen` 指纹。抄写时把源段 `pin` 合并进 `session.pins`，按规范化字符串去重（字段顺序固定、空字段省略）；不复制、不删除。
- **defer**：只作用于流内。flow 终止（不是 scope 结束）时未投递的 defer 随流丢弃并留一条审计；不抄给接收方。
- **amend**：fission 内**禁用**。`amend` 会改写已有 entry，而改写在多流共享文件下会覆盖别流的追加；接口返回 `AMEND_UNAVAILABLE_IN_FISSION`，并说明原因。
- **costGate 共用。** N 条流共用会话的那一个 `CostGate`，不各自新建。它的口径是「整棵 session 树的支出」——root、子代理与侧请求共用一个闸门，子代理本来就是通过 `costGate: session.costGate` 按引用共享的。接线层把 `owner.costGate` 交给每条流的 `streamFn` 包装：`guardStreamFn(streamFn, () => owner.costGate)`。不这样做，`session.maxCost` 会被放大成 N 倍。
- **两种账不是一回事。** `begin.fission[].budget` 数的是 assistant turn，`CostGate` 数的是美元。两条轴独立：turn 还有余额不代表美元没到顶，反之亦然。
- **触顶后的失败语义。** `gate.check()` 命中的那条流拿到 `CostCapError`，该流按取消处理（写 `fission.aborted`），其余在跑的流继续；当没有任何 running 流时，批次以 `cost-capped` 结束，`onSessionStop` 不宣告成功。
- **状态条按「最近写入者 + 总和」统计。** 单值字段（最近一次请求的 usage、上下文占用、token 速率、当前模型、当前工具）取最近写入的那次请求——哪条流、哪次侧请求都一样，后到覆盖先到，不做平均或仲裁；累计字段（总 token、总花费）记录总和。本项目的 `status.mjs` 已经是这个口径：`session.last` 被每条 assistant `message_end` 覆盖，`session.totals` 累加，而 `keyFor(ctx)` 用 `ctx.sessionManager` 做键——所有流共用同一个 manager，自然落进同一条记录。
- **流不能被标成子代理。** `showUsage` 对 `kind === "sub"` 或 `depth > 0` 直接返回，状态条不会更新。fission 的流是并列执行体，接线层不要给它们带 `kind: "sub"`。
- **`tokenRate` 同理。** 它是 `AgentSession` 上的 meter，只接主 agent 的增量；各流自己的速率需要接线层把「最近写入者」的采样转给主 session，否则状态条上的速率会停在主 agent 空闲时的值。

### 8.1 UI：三条不变量

UI 层完全不知道 fission 存在。它只看见一个事件源、一个正在流式的消息、一条线性 transcript。

1. **UI 以为你是单流。** 复用器的输出永远是合法的单流序列：至多一条 message 处于 open（`message_start` 之后、`message_end` 之前）；工具事件只出现在两条消息之间；不存在第二条并发打开的 assistant 消息。
2. **单流 UI 行为不变。** 只有一条流时，复用器是恒等函数：每个事件原样、同序、同拍转发，不合并、不延迟、不改写。
3. **不得特判第 2 条。** 恒等性不是 `if (flows.length === 1)` 写出来的，而是状态的结果：租约恒授予、FIFO 恒空，于是「转发」分支必然被走到，「缓冲」分支必然走不到。

**复用器不是渲染器，是事件闸门。**

```js
mux.accept(flowId, event)   // 持有租约 → 原样 emit；否则入该流私有 FIFO
mux.acquire(flowId)         // message_start：空闲则持有，否则排队
mux.release(flowId)         // message_end：清租约 → drain
mux.drain()                 // FIFO 出队：整段回放，然后交给仍在流式的下一条
```

**被缓冲的流，回放成一段合法的短流。** `message_update` 是累积快照，所以一条被缓冲的 assistant 消息只需要三个事件：

```js
emit({ type: "message_start", message: firstSnapshot })
emit({ type: "message_update", message: lastSnapshot })   // 一次到顶
emit({ type: "message_end",   message: lastSnapshot })
```

UI 看到的仍是一次正常的「开始 → 更新 → 结束」，只是更新只有一帧。工具事件按原顺序插在消息之间，从不落在某个 open 窗口内部；`tool_execution_update` 的 `partialResult` 同样是累积快照（`event-controller.ts:2175`），因此每个 `toolCallId` 也只保留最新一帧（已结束则压缩为 `start → end`），不堆积长输出的全量中间帧。

**消息内的工具卡不算「工具事件」。** `toolCall` 是 assistant 消息自己的 content block，由 `message_update` 渲染，本来就属于那个 open 窗口——现有实现在这里 `markTranscriptBlockFinalized()` 把前置 prose 定稿，然后继续流式渲染参数。复用器不干预这一点。真正被限制在消息之间的是 `tool_execution_start/update/end` 这三类事件。

**为什么这样不破坏既有渲染。** 持有者的事件逐字转发，所以 reveal 节奏、read group、`markTranscriptBlockFinalized` 在 toolCall 边界的定稿（`event-controller.ts:1715`）、pending tool 恢复全部照旧。缓冲流回放时走同一条 `syncAssistantMessage` 路径，只是收到一个终态快照。

**原子粒度。** 一个块只在它自己的 open 窗口内被改写，窗口之外不可变。复用器保证同一时刻只有一个 open 窗口，所以「两条流的内容交织进同一个块」在输出上不可能出现。

**顺序。** 输出顺序等于块完成的先后。A 在直播时，B 完成的段进 FIFO；A `message_end` 后 FIFO 出队，然后若 B 仍在流式，B 拿到租约继续。先开始但后结束的流排在后面——这是单流序列的必然结果，不是额外规则。

**等待者的可见性。** 未持有租约的流只在状态条留一行 `▸ label · buffering 1.4k`。那是状态条，不是 transcript，所以不破坏「UI 只看见一条流」。

**取消。** 被取消的流把已缓冲内容按上面的短流回放，末尾带 `aborted`；若它持有租约，先 `message_end` 再释放。Esc 扇出到全部流。

**审批。** 弹窗写出请求方 label；它不进入 transcript 事件流。

**与聚焦的关系。** 聚焦是「只看这一条」的过滤器，作用在复用器之后；N=1 时它同样是恒等。

**嵌套：租约是全会话的，不是每批一个。** 内层流的 `message_start` 与任何其他流一样进同一个等待队列。这保证「至多一条 message 处于 open」在整个会话内成立，而不是在每一层各自成立——否则一次内层分叉就能在屏幕上出现两条同时吐流的线。

**广播按 `broadcastId` 去重。** 每条流都会收到同一条用户消息并各自产生一次 `message_start`；复用器记住已渲染的 id，后续同 id 的事件直接丢弃。屏幕上它只出现一次，位置是第一次出现的位置。

**标签带路径。** `batch.0/batch2.1` 这样的 label 进入状态条与审批弹窗。不带路径时，内层与外层同号的两条流在界面上无法区分。

**等待队列只有一条，不是每层一条。** 否则父流的块可能排到子流的块之后，屏幕上的因果会倒过来。一条全局 FIFO 就够：子流只有在父流的 `message_end` 与工具执行**之后**才产生事件，所以按块完成时间排队时，父流的内容天然在前面。不需要额外的树序规则。

**缓冲、取消与审批都跨层。** 等待队列、`▸ label · buffering` 行、Esc 扇出、审批归属，全部按全局流集合处理，不按层分组。层的边界只在完成后才成立；运行中它们都是并列的流。

**实现落点。** UI 一行不改：

- 事件来自 `agent.subscribe(fn)`（`packages/agent/src/agent.ts:1005`），每条流各自订阅。
- 回放落到 `syncAssistantMessage(cumulative)`（`event-controller.ts:1671`、`1690`）。
- 块提交落到 `addMessageToChat` / `PresentedBlock`（`ui-helpers.ts:288`）。

「UI 一行不改」的准确含义：**渲染器不变，事件源可换。** 今天 `event-controller` 订阅的是主会话的 agent；复用器把它订阅的对象换成自己的输出。`viewSession` 只用于工具查找与模型元数据，两者来自同一注册表，所以继续指向所有者是安全的；消息内容、工具参数、工具结果全部由事件自带。

**恒等性的检验。** 不靠读代码，靠录屏：N=1 时把复用器的输入与输出各录一份，逐事件比对类型、顺序、时间戳（允许毫秒级抖动），必须完全相同。若出现任何差异，说明复用器在单流路径上做了额外动作——那就是特判的另一种形态。

---

## 9. 风险登记

| 级别 | 风险 | 依据 | 处置 |
|---|---|---|---|
| 数据 | 任一流 dispose 封死共享 manager | `seal()` 置 `#released`，后续 append 丢弃 | 引用计数 |
| 结构 | 全局叶被踩 | 多数 `append*` 走 `#freshEntryFields()` | `appendAt` + 三条纪律 + 断言 |
| 结构 | `atomicEntryBatch` 互相污染 | 只有 `appendEntriesAtomically` 会置位 | fission 禁止调用它；vibe runtime 活动时拒绝 fission |
| 上下文 | 压缩取错链 | 压缩用 `getBranch()`，只看主线 | 压缩绑定到流 |
| 性能 | `#branchCache` 反复失效 | 多流交替写不满足 O(1) 延长条件 | 接受；必要时每流自缓存 |
| 功能 | 审批 / 中断 / cost 默认只认主 agent | 绑定 `this.agent`；事件流已由 8.1 的复用器接管 | 接线层按流聚合 |
| 成本 | 多模型互相挤占缓存 | prompt cache 按会话 | 限制同批模型数 |
| 成本 | 每条流各建一个 `CostGate` | 闸门口径是整棵会话树，子代理按引用共享 | 接线层把 `owner.costGate` 传给每个 `guardStreamFn` |

---

## 10. 三个开放问题的结论

### 10.1 `transformProviderContext` 与 `onPayload` 都不用于注入

- `transformProviderContext` 的签名是 `(context, model) => Context | Promise<Context>`。主循环把它交给请求构建，侧请求里是 `await this.#transformProviderContext(context, model)`。它每次请求前运行，可以改写 messages 与 systemPrompt，但**是异步点**。
- `onPayload` 在 provider 适配器里被 `await`，拿到的是已经序列化的请求体，属于 provider 私有形状。

两条路都不能承载「同步叶作用域 + 逐条写入」的抄写序列：进入钩子就跨了 `await`，与 4.3 的共同前提冲突；`onPayload` 还要逐 provider 适配。所以定案不变——**在接收方空闲时注入 `agent.state.messages`**，钩子只用于观测，不用于写入。

### 10.2 `compaction` 不入白名单

`appendCompaction(summary, shortSummary, firstKeptEntryId, tokensBefore, options?)` 走 `#freshEntryFields()`，没有 parentId 参数；`firstKeptEntryId` 是源段 id。照抄有双重问题：接收方的上下文会被别人的裁剪点切掉，而 compaction 摘要是顶层 entry 而不是可注入消息。

定案见 5.2：不抄 `compaction`，按最后一个 `firstKeptEntryId` 裁剪复制窗口，摘要写成一条 `CustomMessage` 放在段首。

### 10.3 永久退场与继承者接管：已核实

这两条曾经只是机制描述，现在都有具体调用点与代价。

- **退场**：`agent.abort()` 是公开方法（`agent.ts:1690`）；`afterToolCall` 在 `emitToolResult` 之前执行（`agent-loop.ts:3785`），工具结果随后无条件提交，所以回执先落盘。abort 之后下一轮模型调用被取消，`shouldEmitVisibleError` 为 false，不弹错误。**代价**：会落一条 `aborted` 的 assistant 消息。
- **接管**：`InteractiveMode.session` 是可写字段（`interactive-mode.ts:1409`、构造器 `2303`）；`AgentSession.agent` 只是 TS `readonly`，运行时是普通属性。**但整对象替换会让 `tokenRate` 等构造期绑定失配**。所以选状态收养：`agent.reset()` → splice 继承者的 `state.messages` → `session.setModel(heir.model)`（`agent-session.ts:13085`）。会话对象与 UI 完全不动。
- **前缀上下文**：`Agent` 接受 `initialState`（`agent.ts:117`），构造器对 `messages` 做 `slice()`（576）。
- **广播**：`agent.steer(message)` 是公开投递口（`agent.ts:1477`），下一次模型调用前出队。

剩下的风险只有一条：`aborted` 消息是否会被既有 UI 渲染成「用户中断」。若会，接线层需要按 `details.fissionRetired` 把它过滤掉；这属于接线层的显示策略，不影响协议。

### 10.4 `#atomicEntryBatch` 只有一个入口，且不在正常路径上

`#atomicEntryBatch` 只由 `appendEntriesAtomically(append)` 设置。它的回调必须同步，成功时整文件原子替换，失败时回滚并只移除本批 entry。

正常会话路径不调用它；全仓唯一的非测试调用者是 `vibe/runtime.ts`。所以：

- fission 自身禁止调用 `appendEntriesAtomically`。
- 若检测到 vibe runtime 活动，fission 直接拒绝，返回 `FISSION_UNAVAILABLE_WITH_VIBE`。
- 不需要「运行时关闭 batch」这类补丁：双方都不调用，`#atomicEntryBatch` 恒为 `undefined`。

---

## 11. 改动文件总览

| 文件 | 改动摘要 |
|---|---|
| `src/tools/descriptions.mjs` | `begin` 改为必填 `fission` 数组；无单流形态 |
| `src/scope/state.mjs` | `createState()` 派生 flow 视图；`depth` 不进状态 |
| `src/scope/accounting.mjs` | 预算按 flow 记账；fission 校验 |
| `src/station/controls.mjs` | `handleScopeCall` 接受 fission；逐项校验后再变更 |
| `src/station/gates.mjs` | `beforeToolCall` 按 flow 检查 `permission` |
| `src/host/scope-dispatch.mjs` | 抄写调度器；叶恢复断言 |
| `src/session/transcript-*.mjs` | `appendAt`、`mapId`、白名单、`handoff` 标记 |
| `src/host/wiring.mjs` | N 个 Agent 对称装配；`seal`/`close` 引用计数 |
| `docs/design/concurrent-fission.md` | 本文档 |

---

## 12. 验收要点

这份设计能不能成立，看下面几条能不能被真实现象确认，而不是看代码是否编译通过：

1. **分叉是真的。** 两条流同时跑，`getTree()` 里 `begin` 的回执有两个 child，各自 tail 不同；重载后两条 tail 都还在。
2. **抄写是主线。** 哥哥结束后，接收方从 `target.tail` 沿父链回溯，必须依次经过 `handoff.end`、哥哥的 `begin…end`、`handoff.begin`；不能出现「抄写段挂在旁支」。
3. **深度是平移的。** 哥哥内部开过子 scope 时，抄写段的深度序列与源段逐项相等加 `shift`；不是一条平线。
4. **文本数值平移了。** 抄写段里 `scope level <n>` 的 `n` 都加了 `shift`；`Remaining budget` 的数字一个没变。
5. **半段可恢复。** 抄写中途杀进程，重载后没有悬空的 `handoff.begin`；重抄后除两个标记外，段内 entry 数与类型序列与复制窗口一致。
6. **一条流不会拖垮全体。** 任一条流主动 dispose，其余流的下一次写入仍然落盘。
7. **额度不串。** 哥哥用超预算时，弟弟的 `remaining` 不受影响；抄写段里的预算文本不产生新的可花费额度。
8. **停止不被提前宣告。** 一条流结束而其余仍在跑时，`onSessionStop` 不推进 relay。
9. **互斥成立。** 并行写入前后 `getConversationTip()` 回到入口值；抄写段的叶停在段尾。两类断言各自从未触发。
10. **amend 被明确拒绝。** fission 内调用 `amend` 返回 `AMEND_UNAVAILABLE_IN_FISSION`，而不是静默重写文件。
11. **`fission` 只有一个元素时没有专门的代码路径。** 实现里搜不到 `flows.length === 1` 一类的分支；同一操作在当前版本与本设计下各跑一遍，预算余额与 `todo` / `relay` 的行为相同，屏幕输出相同，但树形多一层子 scope（所有者退场、唯一流继承）。
12. **成本闸门共用。** 两条流同时花钱时，`session.maxCost` 按总额拒绝，不是每条流各得一份 cap；触顶后批次以 `cost-capped` 结束，而不是宣称成功。
13. **UI 只看见一条流。** 任意时刻的输出事件序列里至多一条 message 处于 open；工具事件不出现在任何 open 窗口内部。
14. **单流恒等。** N=1 时复用器的输入与输出逐事件相同（类型、顺序、时序抖动内）；把复用器拔掉重跑，屏幕一致。
15. **租约按就绪顺序转移。** 持有者结束后，等待者缓冲的内容回放成一段完整的短流，随后继续流式追加；出现顺序等于就绪顺序，不是开始顺序。
16. **继承者真的接管。** 全部流结束后，活动叶是最后结束那条的 tail；它的 `todo` / `pins` / `budget` 成为 session 状态；下一条用户输入由它接收；所有者没有再产生 provider 请求。
17. **递归不吃亏。** 一条流内再开一批，最终叶落在继承者链上；`getTree()` 里内层 `begin` 挂在父流的回执下，深度比父流多一层。
18. **完成条件是子树。** 内层仍有 running 流时，外层不触发该流的抄写；内层全部结束后，外层只触发一次，且段内包含内层全部入口。
19. **嵌套下 UI 仍只看见一条流。** 内外层同时流式时，任意时刻至多一条 message 处于 open；状态条与审批里的 label 带路径。
20. **广播被标注且只显示一次。** 两条流同时跑时输入一句话：两边的上下文都出现它，且带 `(broadcast to N flows)` 与同一 `broadcastId`；屏幕上只出现一次。
21. **广播不被抄写复制。** 哥哥段里含一条广播时，抄到弟弟后弟弟的上下文里该 `broadcastId` 仍只有一份。
