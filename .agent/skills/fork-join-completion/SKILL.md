---
name: fork-join-completion
description: 核验 fork/join 的回执、过继、持久化与结构边界，或清理已退役的实现时载入。
---

# Fork/join 验收与排故

| 边界与责任点 | 必须守住的行为 | 验收文件（`tests/` 下） |
|---|---|---|
| 投影：`station.transformContext`、`applyReceiptFolds` | 只改可折叠旧回执的工作正文；最新回执、fork 行和 pin 不改。仅在净缩短时替换；出错结果、已折叠或不划算则保留。投影失败返回原列表并记诊断。 | `fork-join-completion.test.mjs`、`fork-fold-economy.test.mjs` |
| 交卷与过继：`handleReturnCall`、`reparentOrphans` | 父结果先于其过继子结果；标记失败则拒绝交卷，括号保持打开，归属不变。按接收方层级闭合；成功接收后在宿主工具结果边界正常结束子循环。 | `fork-join-completion.test.mjs`、`scripts/smoke-context.mjs` |
| 冻结：`setChildOutcome`、`markReady`、`writeFrozenOutcome` | 父收件前从 `childRecordStart` 定稿，不带继承前缀。后续启动工单的成功或异常不覆盖定稿；恢复保留它。缺失时显式呈现空记录。 | `fork-join-completion.test.mjs`、`child-record-scope.test.mjs` |
| 收件：`pendingReportOf`、`handleJoinCall`、`admitJoin` | 摘要绑定上一份待归档回执（24–4000 字符；没有则为 `null`）。超窗或摘要拒绝均不消费结果、不动回执链；超窗时可尝试更小的候选结果。 | `fork-report-quality.test.mjs`、`fork-join-admission.test.mjs` |
| 恢复：`serializeState`、`restoreLedger` | 每会话一棵树连同回执链保存。运行中的孩子恢复为待收失败，已就绪的结果保留记录和顺序。树无效或缺配对时两者一起重置；写入失败报诊断和回执。 | `forkjoin-recovery.test.mjs` |
| 计费与修订：`chargeBranch`、`execute.directAmend` | 根与无 fork 记录的分支不能用普通工具；孩子扣自己的预算。免费例外见 `todo-any-level`。最近一次结构调用及此前的拍子不可 amend。 | `branch-charge.test.mjs`、`todo-any-level.test.mjs`、`fork-join-completion.test.mjs` |

## 显示不是记录

根工作台只有一个流式显示槽。根和任意深度子方先到先得；争用者只保留最终快照，完成后作为块显示，不补播增量。子方使用不进入根历史或模型上下文的自定义展示块，不发送原生子方生命周期或工具事件。`child-display.test.mjs` 验证双向争用、输出平铺与会话切换。Working 行使用 `[Busy: X, Idle: Y]` 和最近发请求的作用域路径，不带 `Root`；模型提供 `scopeId`，长内部 ID 只作配对与路由。

测试从 `forkLedgerPort` / `forkIdentityPort` 构造接收者，用 `childOutcomePort` 检查冻结结果，用 `station.state.brackets` 构造持久化输入。窗口测量走 `currentContextTokens`、`tokensPerCharFor` 或 `forkWindowPort`；显示走 `childDisplayFor(rootSession)`，历史走 `manager.buildSessionContext().messages`。

## 退役围栏与已知缺口

- 不恢复 `station/fold.mjs`、区间折叠（`applyCollapses`、`applyForkJoinCollapse`、`collectPinnedMessages`）、空租金累积、`canFoldInterval` / `canFoldContent` 或无引用的 handoff 复制。保留 `applyReceiptFolds`、`extractForkLines`、`extractPinnedLines`、`foldedScopeText`、缓存位置助手和 relay 自己的交接会话。
- 孩子起点由宿主构造。本地不从继承前缀删兄弟 fork；真实宿主的首轮投影仍需验。没有 `ChildStartSpec`，不可拿完整父方窗口代替孩子预准入。
- 收件并非两阶段提交：回执先于宿主工具结果写入。`closeToolCallId` 保证重放幂等；两次写入之间崩溃仍可能只有回执。
- 子方请根持久化共享树。落盘失败可见，但结果暂只在内存；成功重写前崩溃会恢复为待收失败。分支持久化隔离依赖宿主。
