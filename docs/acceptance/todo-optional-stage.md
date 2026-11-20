# 验收用例：简单任务免 todo 直接 S5

- 対象：`scope` / `todo` 两个真实工具入口，以及每轮注入的系统提示词与 stage 提示词。
- 执行方式：手工。执行者扮演用户，在真实会话里发消息、开 scope、读工具返回原文；不得用单元测试代替本文件的 CASE。
- 判定基线：`resources/prompts/` 下的提示词文本 + 工具返回的 `RELAY STATE` 原文 + `scope` 返回的成功/失败原文。
- **构建新鲜度前置（每次执行 CASE 的第一步）**：仓库源码不等于已安装插件。先运行
  `bun run sync:plugin`，再重启会话；然后 `todo({ op: "view" })`，其 `RELAY STATE` 必须出现
  `Flow:` 行。缺少 `Flow:` 说明当前进程加载的是陈旧安装副本，本次会话的任何观察都不得写进
  本文件。2026-11-20 的调查确认：安装副本曾缺少 `status.flow`、`reopened` 与 simple 分支，
  且 S5 与 `RW_BEFORE_LEDGER` 缺 `fullFlow` 条件；此前所有「真实会话」证据都来自那个旧构建。
  2026-11-20 第 7 代复核：安装副本已与仓库逐字一致（`bun scripts/sync-plugin.mjs --check`
  退出 0），但运行中的会话仍无 `Flow:` 行，因为模块在进程启动时装载。同一份仓库源码用
  `bun run smoke:relay` 在全新进程中驱动真实注册的 `todo` / `scope` 工具，8/8 通过并打印
  `Flow: simple` 与 `Flow: full flow` 两种文案。重启之前 `smoke:relay` 是可复跑的工具层证据；
  它不能替代本文件要求的手工会话 CASE。
- 每个 CASE 的 `final = min(user_score, developer_score)`。

## 需求的可观察约定

1. **未启用全流程**（`relay.fullFlow === false`）时：主代理可以不写 todo，直接开
   `stage: "direct-execution"` 的 `rw` scope，做完即止；不出现 `STAGE_FLAGS_UNMET`，也不出现
   `RW_BEFORE_LEDGER`。
2. **一旦提交了 todo 账本**（任何成功的写操作：`op !== "view"` 且 `isError !== true`，
   包括 `list: []` 的空账）：全流程启用。S5 重新要求 S2/S3/S4 三个标志；接力照旧；
   该状态一直保持到两空账终结。空账不因「空」而豁免，因为空账本身必须触发接力交接；
   若它不开启全流程，就会留下 `fullFlow === false` 且 `handoffPending === true` 的非法组合，
   并让空账成为绕过接力的出口。
3. **两空账终结**（前任空账 handoff，继任者首次评估为空账 → `Can stop now: yes`）后：
   全流程复位。下一件用户需求可以再次不写 todo 直接开 S5。
4. **再次提交 todo 账本（含空账）**：全流程重新启用，回到第 2 条，直到下一次两空账终结。
5. **全流程启用期间 ledger 变空不能当免 todo 的出口**：空账只触发 handoff，不解除 S5 门控。

## CASE-SIMPLE-001 全新会话直接 S5

- case_id: `CASE-SIMPLE-001`
- path: 真实会话 → 用户消息 → `scope` 工具
- threshold: 90
- steps:
  1. 新建会话，确认 `todo({op:"view"})` 的 `RELAY STATE` 为 `Generation: 0`、`First todo evaluation of this generation: not evaluated yet`、`Can stop now: no`。**不要**提交任何 ledger。
  2. 以用户身份发一条明确且无需编排的任务，例如：把 `README.md` 第 25 行表格里的 "Default mode" 改成 "Default"。
  3. 模型直接调用 `scope({ begin: { intent: "...", stage: "direct-execution", budget: { read: 1, edit: 1 }, permission: "rw" } })`，不调用 `todo`。
  4. 读回 `scope` 返回原文；执行改动；再 `scope({ end: true })`。
  5. 由扮演用户的执行者记录：是否被迫写 todo、是否被两个 gate 拒绝、是否被接力文案催促。
- expected:
  - 步骤 3 返回成功，包含 `Stage: direct-execution`，不含 `STAGE_FLAGS_UNMET`，不含 `RW_BEFORE_LEDGER`。
  - 步骤 4 的 `scope end` 成功；没有任何 `RELAY STATE` 出现，也没有 "submit the ledger" 一类催促。
  - 注入的 persistent-rules 明确写出：简单、明确、无需编排的任务可以免 todo 直接开 S5。
- rubric:
  - 95–100：全部 expected 命中；提示词与工具行为一致；用户全程零额外动作。
  - 90–94（just-PASS）：工具行为全部正确，但提示词里仍有一处旧文案与行为矛盾（例如仍写"rw 在首个 ledger 前被拒"），需要读者自行分辨。
  - 80–89（just-below-PASS）：S5 放行且无 todo 催促，但 `rw` 被 `RW_BEFORE_LEDGER` 拒绝，执行者只能改用 `ro` 或被迫写 todo。
  - 60–79：S5 被 `STAGE_FLAGS_UNMET` 拒绝，模型于是先开三个空 stage 或写 todo，流程被拖长。
  - <60：S5 被拒且提示词仍宣称"所有任务都要 todo"。
  - hard-fail（直接 0）：出现 `STAGE_FLAGS_UNMET` 的同时仍继续写代码；或提示词宣称免 todo 而工具实际拒绝，形成言行不一。
  - 每个未执行的非 happy 分支扣 5：`permission` 省略（应视为 rw）、`rw` 显式声明、`ro` 声明、`budget` 为空。
  - 取整：整数；同一证据两审计相差不得超过 5。
  - minimum evidence：步骤 1、3、4 三次工具返回原文 + 改动后的文件片段。
  - user_score：用户是否需要理解 relay 才能完成任务；developer_score：提示词与 gate 是否同一事实源。

## CASE-TODO-002 提交 todo 账本启用全流程

- case_id: `CASE-TODO-002`
- path: 真实会话 → `todo` 写操作 → `scope`
- threshold: 90
- steps:
  1. 接续 CASE-SIMPLE-001 的会话（`fullFlow === false`）。
  2. 以用户身份发一条明显需要多步的任务，例如新增一个小功能并补三个测试。
  3. 模型调用 `todo({ op: "init", list: [{ phase: "实现", items: ["A", "B", "C"] }] })`。
  4. 读回 `RELAY STATE`；然后尝试 `scope({ begin: { stage: "direct-execution", permission: "rw" } })`，不先开 S2/S3/S4。
  5. 依次开 `acceptance-cases`、`architecture-design`、`orchestration-plan`，再开 S5。
- expected:
  - 步骤 4 返回 `STAGE_FLAGS_UNMET`，缺失清单恰为 `acceptance-cases, architecture-design, orchestration-plan`，且状态未被破坏。
  - 步骤 3 的 `RELAY STATE` 明确显示全流程已启用（例如新增 `Flow: full`），并说明 S5 需要三个阶段。
  - 步骤 5 四次开启全部成功。
  - 空账同样开启全流程（由 `CASE-LEDGER-008` 覆盖）；本 CASE 只证明非空账本这一条路径。
- rubric:
  - 95–100：上述全部命中，且文案只在一处定义规则。
  - 90–94：gate 行为正确，文案有一处需要推断。
  - 80–89：S5 被挡，但缺失清单顺序或文案有误。
  - 60–79：`todo` 写操作没有启用全流程，S5 仍被放行。
  - <60：全流程启用后仍能随意进出 S5。
  - hard-fail：启用全流程的同时把已有 S2/S3/S4 标志清成"已满足"。
  - 未覆盖扣分：`todo` 的 view、失败的 todo 调用、`op:"append"` 各 5 分。
  - minimum evidence：步骤 3、4、5 返回原文。
  - user_score：用户能否看出"我现在处于严格模式"；developer_score：启用点是否唯一且可测。

## CASE-TWOEMPTY-003 两空账终结后复位

- case_id: `CASE-TWOEMPTY-003`
- path: 真实会话 → 清空 ledger → handoff → 继任者空账 → `scope`
- threshold: 90
- steps:
  1. 在全流程已启用、且 S2/S3/S4 已跑过、S5 可开的会话里，调用 `todo({ op: "init", list: [] })`。
  2. 按返回文案写 handoff 报告，不调用任何工具；等待继任者接手。
  3. 继任者接手后先不写账本：调用 `todo({ op: "view" })`，逐字记录 `Flow`、`Can stop now`、`Next` 三行。
     若输出中没有 `Flow` 行，停止本 CASE：当前进程是陈旧构建，按文件头前置同步并重启后重跑。
  4. 仍不写账本：尝试 `scope({ begin: { stage: "direct-execution", permission: "rw" } })`，记录返回原文。
     预期 `RW_BEFORE_LEDGER`。若返回 `STAGE_FLAGS_UNMET`，回看步骤 3：无 `Flow` 行即陈旧构建，
     有 `Flow: full flow` 才是门禁顺序缺陷。若意外成功，立即 `scope({ end: true })` 关闭并继续。
     若用脚本代替手工，每次工具调用必须使用唯一的 toolCallId：同一 id 重放会命中
     `station.handled` 缓存，返回上一次的拒绝原文，看起来像门禁失灵而实际是幂等重试。
  5. 继任者首次调用 `todo({ op: "init", list: [] })`。
  6. 读回 `RELAY STATE`，确认 `Can stop now: yes`、`Flow: simple`。
  7. 不写最终答复，改为发一条新的简单用户任务，直接开 `scope({ stage: "direct-execution", permission: "rw" })`。
- expected:
  - 步骤 3 显示 `Flow: full flow`，`Next` 要求先提交本代际的账本；全流程跨 handoff 保持，没有在交接时被重置。
  - 步骤 4 被 `RW_BEFORE_LEDGER` 拒绝。判定必须结合步骤 3：步骤 3 有 `Flow: full flow` 而步骤 4
    返回 `STAGE_FLAGS_UNMET`，说明 `RW_BEFORE_LEDGER` 排在阶段门禁之后，属门禁顺序缺陷；
    步骤 3 无 `Flow` 行时，步骤 4 的任何返回都不构成本 CASE 的证据，必须先同步安装副本并重跑。
    直接放行说明 `fullFlow` 或 `firstEvaluation` 在 handoff 时出错。
  - 步骤 5 返回 promoted 文案；步骤 6 `Can stop now: yes`，且明确显示全流程已复位（例如 `Flow: simple`）。
  - 步骤 7 的 S5 放行，不返回 `STAGE_FLAGS_UNMET`。
  - 提示词说明：终结后的新需求可以免 todo 直接 S5。
- rubric:
  - 95–100：全部命中；终结与复位是同一次状态跃迁，没有中间可停留的半状态。
  - 90–94：行为正确，文案未显式展示 `Flow` 但仍可判定。
  - 80–89：S5 放行，但 `Can stop now` 或复位文案之一缺失。
  - 60–79：终结后 S5 仍被 flags 挡住，模型被迫再开三个阶段。
  - <60：两空账无法终结，或终结后仍强制接力。
  - hard-fail：终结后下一轮用户消息被当成"旧任务的续作"而拒绝简单任务。
  - 未覆盖扣分：终结后不写 todo 直接结束、终结后再次开 todo，各 5 分。
  - hard-fail：步骤 3 显示 `Flow: simple`，或步骤 4 的 `rw` 被放行；两者都说明全流程在 handoff 时被重置。
    不得把陈旧构建的 `STAGE_FLAGS_UNMET` 记作 hard-fail，也不得记作通过。
  - minimum evidence：步骤 1、3、4、5、6、7 返回原文，以及步骤 3、4 的 `Flow` 与错误码；
    外加执行前置时 `bun run sync:plugin` 的输出与 `todo view` 的 `Flow` 行原文。缺 `Flow` 行的证据无效。
  - user_score：用户是否感到"这一轮真的结束了"；developer_score：复位是否由单一事实源驱动。

## CASE-REOPEN-004 终结后再开 todo 重新启用

- case_id: `CASE-REOPEN-004`
- path: 真实会话 → 复位后 `todo` → `scope`
- threshold: 90
- steps:
  1. 从 CASE-TWOEMPTY-003 的复位状态出发。
  2. `todo({ op: "init", list: [{ phase: "x", items: ["y"] }] })`。
  3. 立刻尝试 `scope({ stage: "direct-execution", permission: "rw" })`。
  4. 回到 CASE-TWOEMPTY-003 的 promoted 复位状态（`Flow: simple`、`Can stop now: yes`），
     再次调用 `todo({ op: "init", list: [] })`（空账）。
  5. 读回 `RELAY STATE`，逐字记录 `Flow`、`Can stop now`、`Next` 三行。
  6. 立刻尝试 `scope({ stage: "direct-execution", permission: "rw" })`。
- expected:
  - 步骤 2 后 `RELAY STATE` 显示全流程重新启用。
  - 步骤 3 返回 `STAGE_FLAGS_UNMET`，三阶段重新要求，**不继承**上一周期的标志。
  - 提示词说明"再次开 todo 就重新进入全流程，直到下一次两空账"。
  - 步骤 4 的空账返回 `Flow: full flow`、`Can stop now: yes`，`Next` 为 `next.reopened`
    文案；它重新启用全流程，但不重开 handoff。
  - 步骤 6 返回 `STAGE_FLAGS_UNMET`，因为 `fullFlow` 翻转已清零上一周期的三标志。
- rubric:
  - 95–100：全部命中，且上一周期标志被明确作废。
  - 90–94：gate 正确，文案需推断。
  - 80–89：S5 被挡，但旧 flags 仍残留 true 导致只需补开部分阶段。
  - 60–79：S5 直接放行。
  - <60：复位状态无法区分"从没开过 todo"和"上次已终结"，行为随机。
  - hard-fail：复用上一周期的 S2/S3/S4 证据。
  - 80–89（空账路径）：非空路径正确，但终结后的再次空账仍让 `Flow: simple`（违反需求 4）。
  - hard-fail（空账路径）：终结后的再次空账被当成新 handoff，强制写交接报告；或再次空账后
    S5 直接放行（三标志未清零）。
  - minimum evidence：步骤 2、3、4、5、6 返回原文，以及 `todo` 返回中的 flags/flow 字段。
  - user_score：严格模式的出现是否可预期；developer_score：复位与再启用是否对称。

## CASE-ESCAPE-005 全流程中空账不能当出口

- case_id: `CASE-ESCAPE-005`
- path: 真实会话 → 全流程启用 → 清空 ledger
- threshold: 90
- steps:
  1. 全流程启用，S2/S3/S4 尚未全部跑过。
  2. `todo({ op: "init", list: [] })`。
  3. 读回返回；尝试开 S5。
- expected:
  - 步骤 2 返回 handoff 文案（`Can stop now: no`，`Handoff pending: yes`），不返回 promoted。
  - 步骤 3 被 `RELAY_HANDOFF_PENDING` 拒绝，或先要求写 handoff 报告。
  - 全流程没有被空账解除；`STAGE_FLAGS_UNMET` 在继任者补跑三阶段前仍然有效。
- rubric:
  - 95–100：全部命中。
  - 90–94：handoff 正确，S5 的拒绝理由文案略含糊。
  - 80–89：空账触发了 handoff，但 S5 门控短暂放行。
  - <60：空账被当成 simple 结束，接力被绕过。
  - hard-fail：空账直接 `Can stop now: yes`（generation 0 或未终结状态）。
  - minimum evidence：步骤 2、3 返回原文。
  - user_score：用户不会看到"任务没做完却结束了"；developer_score：空账路径是否仍只有一个语义。

## CASE-PROMPT-006 文案与行为同源

- case_id: `CASE-PROMPT-006`
- path: 每轮注入的 persistent-rules、`resources/prompts/stages.md`、`tools/scope.md`、`tools/todo.md`、`receipts/relay.md`
- threshold: 90
- steps:
  1. 开一轮真实会话，抓取注入的 `<skill version="1.0">` 文本。
  2. 对照 `docs/acceptance/todo-optional-stage.md` 的五条约定逐条勾选。
  3. 搜索全部提示词资源，确认没有残留"rw 在首个 ledger 前一律被拒""所有任务都必须写 todo"这类绝对句。
  4. 在复位状态和全流程状态各读一次 `todo` 的 `RELAY STATE`，确认文案随状态切换。
- expected:
  - 五条约定在提示词里都有对应句子，且互相不矛盾。
  - 条件句写清前置状态：免 todo 只在未启用全流程时成立。
  - `RW_BEFORE_LEDGER` 的错误文案只在全流程启用且本代际尚未提交 ledger 时出现。
- rubric:
  - 95–100：五条全覆盖，条件明确，无残留绝对句。
  - 90–94：五条覆盖，但有一处措辞需要读者结合工具行为推断。
  - 80–89：缺一条非关键约定。
  - 60–79：出现与实现相反的绝对句。
  - <60：提示词要求 todo 而又宣称可以直接 S5，模型行为不可预测。
  - hard-fail：提示词与 gate 在同一状态下给出相反指令。
  - 未覆盖扣分：未检查复位态、未检查全流程态各 5 分。
  - minimum evidence：抓取的注入文本片段 + 资源文件行号。
  - user_score：用户是否能不读源码就预测流程；developer_score：规则是否只有一个事实源。

## CASE-PROMPT-007 阶段门禁文案与门禁本身一致

- case_id: `CASE-PROMPT-007`
- path: 每轮注入的 persistent-rules 与 `resources/prompts/stages.md` 的 header
- threshold: 90
- steps:
  0. 前置：全流程已启用（本代际提交过非空 ledger），`stageFlags` 三项全为 `false`。
  1. 抓取本轮注入的 `<skill version="1.0">` 文本里 `Scope stages` 那一行，逐字记录。
  2. 打开 `resources/prompts/stages.md`，抄下 header 第一段与第三段。
  3. 以 `permission: "rw"` 尝试开 `direct-execution` scope，记录返回原文。
  4. 把步骤 1、2 的文案交给一个扮演用户的执行者，只给这两段文本，问：下一步开 `direct-execution` 会发生什么？
  5. 对照步骤 3 的真实返回与步骤 4 的预测，记录差异。
- expected:
  - 步骤 1 与步骤 2 都写明：full flow 下 `direct-execution` 需 `acceptance-cases`、`architecture-design`、`orchestration-plan` 各跑一次；simple 模式不设该门。
  - 两处都不再出现"四个工作阶段可任意顺序、no stage gates another"这类无条件断言。
  - 步骤 3 返回 `STAGE_FLAGS_UNMET` 并列出三个缺口，与步骤 4 的预测一致。
  - simple 模式（新会话未提交 ledger）读同一段文案时，能正确预测 `direct-execution` 直接打开。
- rubric:
  - 95–100：两处文案都带条件，步骤 4 的预测与步骤 3 完全一致，simple 预测也正确。
  - 90–94：两处文案带条件，但其中一处把"simple 免门禁"留给读者推断。
  - 80–89：只有一处带条件，另一处仍是无条件绝对句。
  - 60–79：文案与门禁方向相反（例如说 S5 总是免门禁），模型会先撞墙再改。
  - <60：两处都是绝对句，且 simple 与 full flow 无法从文本区分。
  - hard-fail：文案声称 S5 不需要前三阶段，而实际返回 `STAGE_FLAGS_UNMET`；或 simple 模式文案声称要门禁而实际直接放行。
  - 未覆盖扣分：未在 simple 模式复读文案扣 5 分；未把两处文案交给扮演用户的执行者扣 10 分。
  - 分档粒度：每 5 分一档，只在 evidence 中同时给出文案原文与工具返回原文时才给到 90 以上。
  - minimum evidence：步骤 1、2 的原文片段与行号；步骤 3 的完整错误返回；步骤 4 的预测记录。
  - user_score：用户能否只读提示词就判断"这个任务该先跑什么"；developer_score：门禁是否只有一个事实源且文案不撒谎。
  - final = min(user_score, developer_score)。

## CASE-LEDGER-008 simple 模式提交空账也开启全流程

- case_id: `CASE-LEDGER-008`
- path: 真实会话 → simple 模式 → `todo({ op: "init", list: [] })` → 工具阻塞 → 继任者复位
- threshold: 90
- steps:
  1. 新会话，不提交任何账本。确认 `todo({ op: "view" })` 的 `RELAY STATE` 显示
     `Flow: simple`，且 `Next` 行说明本轮任务不需要账本。
  2. 开一个 `direct-execution` 的 `rw` scope，做完一件小事并 `scope({ end: true })`；
     确认 scope 结束后没有 todo 催促。
  3. 在 scope 外调用 `todo({ op: "init", list: [] })`。
  4. 读回原文，逐字记录 `Flow`、`Handoff pending`、`Can stop now` 三行与 `Next` 段。
  5. 尝试调用任意普通工具（例如 `read`），记录拒绝原文。
  6. 按 `Next` 的指示，不调用任何工具，直接把交接报告写在正文里；等待继任者接手。
  7. 继任者首次调用 `todo({ op: "init", list: [] })`，读回 `Can stop now` 与 `Flow`。
  8. 打开 `resources/prompts/tools/todo.md` 的 `## tool` 段，抄下关于「空账是否算提交」
     的原句；确认有一句直接说明 `list: []` 也算一次提交，而不是只能从 `## op` 或
     `## list` 的定义推断。记录该句所在行号。
  9. 把步骤 4、5、7、8 的原文交给一个扮演用户的执行者，问：这一轮结束了吗？
     「simple」现在是什么意思？
- expected:
  - 步骤 3 的空账被当作一次账本提交：全流程开启，接力臂起。
  - 步骤 4 显示 `Flow: full flow`、`Handoff pending: yes`、`Can stop now: no`，
    `Next` 给出写交接报告的指示。
  - 步骤 5 被 `RELAY_HANDOFF_PENDING` 拒绝；空账不能当出口。
  - 步骤 7 显示 `Can stop now: yes`、`Flow: simple`；`Flow` 行不再断言「从未提交过账本」，
    而是说本轮任务不需要账本。
  - 注入的 persistent-rules 与 `tools/todo.md` 明确写出：任何成功的写操作
    （含 `list: []`）都会开启全流程，空账不是例外。
- rubric:
  - 95–100：以上全部命中；空账既开启了全流程，又被接力协议正确收尾；
    simple 复位的文案在「刚刚提交过账本」之后仍然为真。
  - 90–94（just-PASS）：工具行为全部正确，但提示词需要读者从 `list: []` 的定义推断
    「空账也算提交」，没有一句话直说。
  - 80–89：空账开启了全流程并触发交接，但 `Flow` 行在复位后仍写
    「no todo ledger submitted」，对用户撒谎。
  - 60–79：空账没有开启全流程，却仍触发了 handoff，留下
    `fullFlow=false` + `handoffPending=true` 的非法组合。
  - <60：空账被当成 `view` 一样无副作用，会话静默结束，接力被绕过。
  - hard-fail（直接 0）：空账写入后 `Can stop now: yes`（gen 0 或未终结）；
    或空账之后仍能调用普通工具。
  - 每个未执行的非 happy 分支扣 5：`op: "view"`、失败的 todo 调用（`isError`）、
    `op: "append"`。
  - 取整：整数；同一证据两审计相差不得超过 5。
  - minimum evidence：步骤 1、3、4、5、7 的工具返回原文，以及注入的 persistent-rules
    片段与 `resources/prompts/tools/todo.md` 的 `## tool` 段中直述空账算提交的句子
    及行号（步骤 8）。
  - user_score：用户是否能看到「我提交了账本，所以这一轮要交接」与
    「交接结束后，新任务又回到 simple」；developer_score：空账路径是否与既有接力协议
    共用同一事实源，而不是一个特例。
  - final = min(user_score, developer_score)。

## CASE-CYCLE-009 第二轮两空账仍能终结

- case_id: `CASE-CYCLE-009`
- path: 真实会话 → reopened 全流程 → 三阶段 → 空账 handoff → 继任者空账 promoted
- threshold: 90
- steps:
  1. 前置：完成 `CASE-REOPEN-004` 步骤 4–5，处于 reopened 状态（`Flow: full flow`、`Can stop now: yes`、上一周期三标志已清零）。
  2. 以用户身份发一条需要编排的新任务；先尝试 `scope({ begin: { stage: "direct-execution", permission: "rw" } })`，记录返回原文。
  3. 依次开 `acceptance-cases`、`architecture-design`、`orchestration-plan`，各完成一件真实工作并 `scope({ end: true })`；然后开 S5 完成该任务。
  4. 在 scope 外调用 `todo({ op: "init", list: [] })`，逐字记录 `Flow`、`Handoff pending`、`Can stop now`、`Next`。
  5. 按 `Next` 写交接报告，不调用任何工具；等待继任者接手。
  6. 继任者首次调用 `todo({ op: "init", list: [] })`；读回 `Can stop now` 与 `Flow`。
  7. 不写最终答复，发一条新的简单任务，直接开 `scope({ stage: "direct-execution", permission: "rw" })`，记录结果。
- expected:
  - 步骤 2 返回 `STAGE_FLAGS_UNMET`，缺失清单恰为 `acceptance-cases, architecture-design, orchestration-plan`；reopened 不是一次性豁免。
  - 步骤 4 返回 handoff 文案：`Flow: full flow`、`Handoff pending: yes`、`Can stop now: no`；不得返回 `reopened`。
  - 步骤 6 返回 promoted 文案：`Can stop now: yes`、`Flow: simple`；第二次两空账与第一次走同一跃迁。
  - 步骤 7 的 S5 放行，不返回 `STAGE_FLAGS_UNMET`。
- rubric:
  - 95–100：两轮终结都命中；步骤 4 的 handoff 与步骤 6 的 promoted 字段完整；第二轮没有复用第一轮的标志或 `canStop`。
  - 90–94（just-PASS）：行为全部正确，但步骤 4 或步骤 6 的 `Flow` 行需要结合 `details.relay` 字段推断。
  - 80–89：第二轮能终结，但步骤 2 的 S5 被直接放行（reopened 后门禁未重新生效）。
  - 60–79：步骤 4 返回 `reopened` 而不是 handoff，第二轮永远无法完成，但会话仍可继续。
  - <60：第二轮需要手工改状态或重启会话才能终结。
  - hard-fail（直接 0）：步骤 4 返回 `Can stop now: yes`（空账被当成终结）；或步骤 6 后 `Flow: full flow`（promoted 未复位）。
  - 每个未执行的非 happy 分支扣 5：步骤 2 不尝试提前开 S5；步骤 6 不检查 `promotionInvalidated` 行；步骤 7 不验证 S5 放行。
  - 取整：整数；同一证据两审计相差不得超过 5。
  - minimum evidence：步骤 2、4、6、7 的工具返回原文，以及步骤 4 的 relay 字段（`canStop`、`handoffPending`、`fullFlow`）。
  - user_score：用户是否能预期「严格模式可以反复开启与结束」，而不是只有一次生命周期；developer_score：第二轮是否复用同一事实源而非特例。
  - final = min(user_score, developer_score)。
