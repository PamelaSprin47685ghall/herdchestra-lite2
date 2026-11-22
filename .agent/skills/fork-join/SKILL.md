---
name: fork-join
description: 修改 scope_fork、scope_join、scope_return、分支过继或回放时载入。按行为定位源码、验收用例和旧 fission 的退役边界。
---

# Fork / Join / Return

工具参数以实际 schema 为准（`src/tools/descriptions.mjs`）；当轮动作以回执为准。2.3.0 快照时代的迁移提案不是当前合同：尤其不要沿用早期的消息独占、阶段字段、子方上下文投影或两阶段持久确认假设。

## 从故障定位职责

| 修改或排查 | 入口 | 首要证据 |
|---|---|---|
| 派生、预算、计时 | `src/station/fork-controls.mjs` 准入；`src/scope/model-selector.mjs` 在注册任何括号前解析模型选择器；`src/scope/forkjoin.mjs` 持有括号和预算；`src/host/fork-wiring.mjs` 装配身份与开单 | `forkjoin-contract`、`fork-blocked`、`fork-budget-birth`、`fork-tool-deadline`、`fork-model-selector`、`fork-wiring` |
| 等待、接收、过继 | `src/tools/tickets.mjs` 操作宿主与等待；`src/station/fork-controls.mjs` 裁定并提交；`src/scope/forkjoin.mjs` 保存所有权与顺序 | `fork-blocking`、`fork-join-admission`、`fork-join-completion`、`join-obligation` |
| 回放、摘要、折叠 | `src/transcript/replay.mjs` 渲染；`src/scope/receipts.mjs` 保存接收链；`src/transcript/collapse.mjs` 投影；`src/host/context-preparation.mjs` 送入请求 | `child-record-scope`、`fork-report-quality`、`fork-fold-economy`、`context-preparation.node` |
| 恢复、隔离、界面 | `src/scope/persistence.mjs` 与 `src/station/restore.mjs` 恢复；`src/host/branch-session.mjs`、`branch-manager.mjs` 隔离；`src/host/child-display.mjs` 展示 | `forkjoin-recovery`、`branch-session`、`child-display` |
| 工具文案、停止义务 | `resources/prompts/tools/fork-join.md` 持有说明；`src/station/gates.mjs` 守准入；`src/station/handoff-state.mjs` 守接力 | `prompts`、`full-flow`、`todo-any-level` |

表中测试名对应 `tests/<名称>.test.mjs`。看实际编排先从 `src/activation/tools.mjs` 跟到开单点：Station 同步裁定和变更，Ticket 只等待与调用外部能力，接线层不另行解释规则。

## 守住跨模块边界

- **计划项不是括号。** 整组参数先验证，再派生。被阻塞的项没有分支、预算或待收义务；后续启动失败也不撤消同组已启动项。派生器预绑定子身份，再让宿主建立分支；否则子代误当根，计费和接力都会错。局部工具预算、分支墙钟、共享 provider 费用是三本账。
- **模型先解析，再开括号。** `scope_fork` 用宿主 `ctx.models`（`list`/`resolve`）在注册第一张括号前解析每个 `model` 选择器；一个名字对不上就整批 `MODEL_UNKNOWN`，不启动任何项。被阻塞的检查点不解析，重新提交为就绪时才解析。字面 id 含冒号尾部时按整串取胜；`model` 原串留档，子会话只拿宿主 `Model` 对象和思考级别，父方模型与级别绝不写入。真实宿主接缝由 `scripts/smoke-omp.mjs` 验证（`tests/fork-model-selector.test.mjs` 用假门面）。
- **就绪不是接收。** `scope_return` 先按本分支起始标记截取有效记录并封存，再标记 ready；接收方不能等 return 工单退出才取结果。过继按当前所有者走，不按出生父级或深度；先排交卷方的结果，再转移它的未收后代。过继不改后代的出生记录、预算或自己已收的结果。
- **接收按成功顺序。** 父方保留模型和消息主线，收到的是一条工具回执，不是子方的顶层消息。接收失败不推进链；收到失败的子任务仍可构成成功接收。摘要指向前一条待归档回执，与本次成功接收绑定；不合规摘要和超窗口拒绝不能消费候选或改摘要。接力换代不凭空消除待摘要义务。`scope_join` 与 `scope_return` 的末位是调用约定，不是运行时独占或 peer barrier。
- **折叠不是改历史。** 只替换合格的旧回执正文，保留最新回执，并从旧正文提取嵌套 fork 行与 pins。摘要应交代对接收方仍有用的过继来源。只有完整替换文比旧正文短时才折叠。回放在渲染前过滤 amend，结构调用仍是 amend 边界；不能用文字匹配代替协议身份。`childReceiptMarker` 与 `childRecordStart` 必须与启动回执一起维护，避免继承前缀被复制回父分支。
- **待收义务独立于接力。** 根无普通工具预算；子代 todo 不推进接力；根还有待收结果时空账冻结而非拒绝工具。层级识别、免费路径和继承账本见 `skill://todo-any-level`。

## 恢复与退役

启动失败、运行失败、接收拒绝和落盘失败是不同状态。不要把 ready 说成 durable：根持有共享树，return 落盘失败时结果可能只在内存；join 回执与宿主工具结果也不是两阶段提交。恢复用 `closeToolCallId` 去重，并一起校验树与接收链。具体缺口和故障隔离见 `skill://fork-join-completion`。

删除旧路径时同时检视工具注册、schema、直接分派、提示资源和安装副本。不要恢复旧 `scope({ begin })` / `scope({ end })`、single 适配、winner/owner retirement、trailing barrier、顶层历史复制或区间删除式折叠。旧记录可只读，不授予旧调用执行权。已有新格式状态的会话不可由读不懂该状态的旧版续跑。

## 验收

先用确定性事件证明一父一子闭环，再按改动覆盖乱序接收、过继、拒绝后仍可接收、持久写失败和下一次请求的实际投影。检查工具结果、归属、真实消息与父模型，不只检查某函数被调用。

- `bun run smoke:relay` 使用 fake host，经真实激活入口验证工具装配和接力；不是宿主或 provider 测试。
- 宿主联调用 `OMP_HOST=<已验证的宿主目录> OMP_SMOKE_STRICT=1 bun scripts/smoke-omp.mjs`，并按需跑 `smoke-context.mjs`。区分 PASS 和 SKIP；内存 journal 不证明崩溃恢复，mock model 不证明真实缓存收费。
- 若新会话仍出现旧工具或旧说明，先核对 README 的安装位置、`bun scripts/sync-plugin.mjs --check` 和进程是否重启，再追业务逻辑。
