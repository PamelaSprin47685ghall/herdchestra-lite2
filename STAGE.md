# HerdchestraLite2/M 多阶段工作流接入设计文档

## 1. 设计原则

本方案将五阶段工作流接入 `HerdchestraLite2/M` 的 `scope` + `relay` 主框架，遵循以下边界约束：

1. **默认无阶段、禁 `ask`**：在所有 `scope` 之外不涉及阶段，且默认禁止调用 `ask`。
2. **开 `scope` 必选阶段**：每次调用 `scope({ begin })` 必须显式指定 `stage`。
3. **运行模式由 `/herd` 独占切换**：`herdMode` 只能由用户通过 `/herd` 命令手动开关，不设自动退出或审批回调。
4. **阶段与 `relay` 正交解耦**：不新增阶段间强制接力或阶段状态机，`relay` 仅在 `herdMode === false` 时按原规则运作。
5. **无读写校验、无写入门禁**：不对 `read`、`grep`、`edit`、`write` 施加任何阶段级权限拦截或已读校验。
6. **`pin` 跨压缩永不丢失**：产物路径不作为 `scope` 参数或状态台账，落盘后直接 `pin`，并在 handoff 时将全部历史 `pin` 灌入继任者上下文。
7. **阶段提示词常驻全局系统提示词**：五个阶段的完整提示词统一并入全局系统提示词的管理块，`beginText(scope)` 只按名字引用当前阶段，不再逐 scope 注入大段文案。系统提示词是稳定前缀，可被提供方提示缓存复用；逐 scope 注入则会让同一段文案随对话历史在每次请求中反复回放并重复计费。

---

## 2. 去梯子化阶段枚举

去掉 `S1`–`S5` 代号，统一采用职责明确的双词英文阶段名：

| 原代号（改名溯源） | 阶段枚举值 | 职责说明 | 允许开启条件 |
|---|---|---|---|
| S1 | `decision-framing` | 需求澄清、非目标裁剪、方案决策（支持 `ask` 交互） | 仅 `herdMode === true` |
| S2 | `acceptance-cases` | 用户体验验收：用例设计、AI 或人手工扮演用户的实测、体验评分标尺 | 仅 `herdMode === false` |
| S3 | `architecture-design` | 模块边界、数据流与开发指南设计 | 仅 `herdMode === false` |
| S4 | `orchestration-plan` | 文学化伪代码、不变量定义与并发任务协调编排 | 仅 `herdMode === false` |
| S5 | `direct-execution` | 实干：代码实现、测试执行、实测验收与交付闭环 | 仅 `herdMode === false` |

- 在 `herdMode === false`（默认模式）下，模型可在 `acceptance-cases`、`architecture-design`、`orchestration-plan`、`direct-execution` 之间**任意跳转、回退或重复开启**，不设前置阶段门禁。
- 一旦进入 `herdMode === true`，模型开启新 `scope` 时**只能**指定 `stage: "decision-framing"`。
- 离开所有 `scope` 后，当前天然处于无阶段状态，不在 `state` 中维护全局 `stage`。
- 表首列仅用于记录本次改名的来源，便于审阅旧对话；运行时枚举、`scope.begin.stage` 的 schema、提示词与工具契约中**一律不得出现 `S1`–`S5`**。

### 2.1 语义轴：why、what、how、do

五阶段不是五个等价的步骤，而是一条从意图到交付的语义轴。层次一旦错位，设计与编排就会互相污染：

| 阶段 | 轴 | 回答的问题 |
|---|---|---|
| `decision-framing` | **why** | 为什么做、为谁做、明确不做什么。决策与取舍先于一切设计。 |
| `acceptance-cases` | **experience** | 用户体验：把 why 翻译成用户将真实经历的使用——用户会看到什么、做到什么、感受到什么。评分标尺度量的是这段体验本身，不是替实现自证。 |
| `architecture-design` | **what** | 工程本身的设计：产物的结构、模块边界与契约。它就是工程，不是完成工程的计划。 |
| `orchestration-plan` | **how** | 如何完成这项工程：过程本身的设计，写成文学化伪代码。 |
| `direct-execution` | **do** | 按 how 把 what 做出来，并接受验收。 |

两条不可逾越的分界：把过程编排、角色分工或交付排期写进 `architecture-design`，是把 how 冒充成 what；把产物的模块结构或接口契约写进 `orchestration-plan`，是把 what 冒充成 how。两者都是层次错位。Knuth 的文学化编程同样适用于后者——写清楚"完成这项工程的过程"，和写清楚工程本身一样，都是设计。

验收阶段同样不是"证明"，而是"体验"。它不替产物举证，而是规定一段用户将要经历的真实体验：由 AI 或人**手工**扮演用户去亲手经历它——真实界面、真实输入、真实反馈；不是跑一遍自动化断言就宣布通过。注意是"手工"而非"人工"：执行者可以是 AI，关键是像用户一样亲手使用，而不是让机器代劳。

### 2.2 保留各阶段大师与心法（Thinkers & Weapons）

去梯子化重命名仅去除 `S1`–`S5` 编号外壳，各阶段对应的思想家与方法论武器完整保留，用于镇场并约束模型在当前 `scope` 内的推理深度与行为纪律（仅通过常驻全局系统提示词注入，不引入代码级门禁）：

| 阶段 | 保留大师（Thinkers & Weapons） | 核心约束焦点 |
|---|---|---|
| `decision-framing` | **Ronald A. Howard**、**Ray Dalio**、**Jeff Bezos**、**Charlie Munger**、**Nassim Nicholas Taleb** | 决策框定与 VoI、激进求真、单/双向门区分、逆向 pre-mortem、via negativa 裁剪非目标 |
| `acceptance-cases` | **James Bach**、**Glenford J. Myers**、**Gerald M. Weinberg** | **experience**：验收即用户真实经历的使用体验；由 AI 或人**手工**扮演用户实测（"手工"不是"人工"）；Testing ≠ Checking，面向寻错而非 happy-path；可复现 0–100 体验评分与双视角 WTP |
| `architecture-design` | **George Polya**、**Alan H. Schoenfeld**、**David L. Parnas**、**Rich Hickey**、**John Ousterhout** | **what**：逆推与最小内核、早杀无效方案、按变更秘密信息隐藏、去 complect、深模块与 poka-yoke |
| `orchestration-plan` | **Donald E. Knuth**、**Frederick P. Brooks Jr.**、**Leslie Lamport & Edsger W. Dijkstra**、**Gene Amdahl & Donald G. Reinertsen** | **how**：Knuth 的文学化伪代码同样用于书写"完成工程的过程"，显式状态先行；清晰角色分工、O(1) 任务边界与零共享可变状态堆砌；显式 Safety/Liveness 不变量、防死锁与幂等接力；消除人为批次波浪、流水线化调度并压缩单板关键路径 |
| `direct-execution` | **无大师（纯实干阶段）** | 系统提示词中不设该阶段章节；专注执行编排计划、落盘编码、运行验证与交付 |

---

## 3. 状态模型与持久化

**涉及模块**：`scope/state.mjs`、`scope/persistence.mjs`、`scope/accounting.mjs`

1. **`createState()` 新增字段**：
   - `herdMode: false`：布尔值，表示当前是否处于 `/herd` 交互授权模式。
   - `pins: []`：字符串或结构化条目数组，按时间顺序保存所有 `pin` 记录。
2. **`makeScope()` 新增字段**：
   - `stage`：字符串，记录当前 `scope` 开启时传入的 `begin.stage`。
3. **持久化与边界清理**：
   - `serializeState` / `deserializeState` 兼容读写 `herdMode`（默认 `false`）与 `pins`（默认 `[]`），以及每个 `scope` 的 `stage`。
   - `truncateForHostBoundary(state)` 在压缩或切换边界清理 `scopes`/`collapses` 时，**保留 `state.herdMode` 与 `state.pins` 不被重置**。

---

## 4. `scope.begin.stage` 与免费工具

**涉及模块**：`tools/descriptions.mjs`、`scope/budget.mjs`、`station/controls.mjs`

1. **Schema 约束（`tools/descriptions.mjs`）**：
   - 在 `scopeParameters.properties.begin.required` 中加入 `"stage"`。
   - 在 `scopeParameters.properties.begin.properties` 中新增：
     ```js
     stage: {
       type: "string",
       enum: ["decision-framing", "acceptance-cases", "architecture-design", "orchestration-plan", "direct-execution"],
       description: "Required workflow stage for this scope."
     }
     ```
2. **阶段合法性校验（`station/controls.mjs` `handleScopeCall`）**：
   - `herdMode === true` 时：若 `begin.stage !== "decision-framing"`，返回错误 `INVALID_STAGE`（提示当前处于 herd 模式，只能开启 `decision-framing`）。
   - `herdMode === false` 时：若 `begin.stage === "decision-framing"`，返回错误 `INVALID_STAGE`（提示平时禁止开启 `decision-framing`，仅允许 `acceptance-cases | architecture-design | orchestration-plan | direct-execution`）。
   - 不校验前序阶段是否完成，允许组合调用 `scope({ end: true, begin: { stage: ... } })` 直接跨阶段切换。
3. **免费工具扩充（`scope/budget.mjs`）**：
   - 将 `ask` 与 `wait` 视为免费工具（与 `CONTROL_TOOLS`、`todo` 同等对待）：
     - `beatShares()` 跳过 `ask` 与 `wait`，不参与单元分摊。
     - `begin.budget` 中无需为 `ask` 或 `wait` 分配额度。

---

## 5. 工具门禁与停止放行

**涉及模块**：`station/gates.mjs`、`station/station.mjs`

1. **`onToolCall` 门禁**：
   - **`ask`**：仅当 `state.herdMode === true` 且栈顶 `currentScope(state)?.stage === "decision-framing"` 时放行；其余所有情况（`herdMode === false`，或在所有 `scope` 之外）一律 `block: true`。
   - **`wait`**：在 `scope` 内直接放行且不调用 `chargeTool`；在 `scope` 外仍遵循“仅允许 `todo` 与控制工具”的边界规则。
   - **`read` / `grep` / `edit` / `write`**：不做任何阶段级限制或读写追踪。
2. **`onSessionStop` 与 `maybeNudge` 停止控制**：
   - 当 `state.herdMode === true` 时，`onSessionStop` 直接返回 `undefined`，`maybeNudge` 直接 `return` 不发 `steer`，允许模型在 `decision-framing` 对话中自然停下等待用户输入。
   - 当 `state.herdMode === false` 时，`relay` 逻辑照旧运行（未完成账本或未晋升前禁止自然停止）。

---

## 6. `/herd` 命令与提示词反馈

**涉及模块**：`activation/`（新增命令注册）、`station/texts.mjs`

1. **`/herd` 切换命令（仅支持手动切换）**：
   - **`false → true`**：
     - 置 `state.herdMode = true` 并 `persist()`。
     - 通过 `steer` 通知模型：已进入 herd 模式，请尽快结束当前事务并开启 `stage: "decision-framing"` 的 scope（此时已放行 `ask` 与自然停止）。
   - **`true → false`**：
     - 置 `state.herdMode = false` 并 `persist()`。
     - 通过 `steer` 通知模型：已退出 herd 模式，请尽快离开 `decision-framing`，后续只能开启 `acceptance-cases | architecture-design | orchestration-plan | direct-execution` 的 scope。
     - 此时 `relay` 与 `insideScopeNudge` 立即恢复生效，若模型仍停留在 `decision-framing` 内未关闭，会自动被催促离开。
2. **动态回执（`station/texts.mjs`）**：
   - `skillReceiptText(state, relayOn)` 中附加当前 `herdMode` 状态与栈顶 `scope.stage`（若在 scope 内）。
3. **阶段提示词常驻系统提示词（`host/prompts.mjs`、`station/texts.mjs`）**：
   - 各阶段的大师名单与精炼心法作为独立章节，随 `injectSystemPrompt` 一次并入全局系统提示词的管理块；`beginText(scope)` 只输出一行阶段名引用（如 `Stage: acceptance-cases`），不携带任何提示词正文。
   - `direct-execution` 在系统提示词中不设章节，其入口回执只说明按 `orchestration-plan` 产物执行。

---

## 7. `pin` 跨 handoff 永不丢失与全文阅读约定

**涉及模块**：`station/controls.mjs`、`station/handoff-state.mjs`、`relay/texts.mjs`

1. **产物落盘与 `pin` 登记**：
   - 阶段产物直接落盘到约定目录，模型通过调用 `pin` 记录落盘路径与关键结论。
   - `handlePinCall` 提取 `pin` 参数中的非空字段（`assumption`、`deduction`、`induction`、`finding`、`conclusion`），格式化后追加到 `state.pins` 并持久化。
2. **handoff 全量灌入**：
   - 在 `commitSelfHandoff` 组装 `successorOpeningText(relay, report, state.pins)` 时，将 `state.pins` 中的全部历史记录作为 `## Pinned Context` 区块注入开场文本，使前任所有 `pin` 跨越压缩边界永不丢失。
3. **全文阅读提示词约定**：
   - 在 `relay/texts.mjs` 的 `successorOpeningText` 与 `handoffFocus` 中明确要求：继任者在开始工作前，应对 `Pinned Context` 中列出的重要落盘文档使用 `read` 进行**全文阅读**，不得以 `grep` 片段代替通读。

---

## 8. 改动文件总览

| 文件 | 改动摘要 |
|---|---|
| `scope/state.mjs` | 增加 `herdMode`、`pins` 与 `scope.stage`；边界清理保留 `herdMode` 与 `pins` |
| `scope/persistence.mjs` | 序列化/反序列化 `herdMode`、`pins` 与 `scope.stage` |
| `scope/budget.mjs` | `beatShares` 免除 `ask` 与 `wait` 的预算分摊 |
| `tools/descriptions.mjs` | `scope.begin` 必填字段增加 `stage` 枚举 |
| `station/controls.mjs` | `handleScopeCall` 校验 `herdMode` 与 `stage` 匹配；`handlePinCall` 写入 `state.pins` |
| `station/gates.mjs` | `onToolCall` 控制 `ask` 放行与 `wait` 免扣费；`onSessionStop` 在 `herdMode` 下放行 |
| `station/station.mjs` | `maybeNudge` 在 `herdMode` 下放行 |
| `host/prompts.mjs` | 将五阶段提示词并入全局系统提示词管理块，作为稳定缓存前缀 |
| `station/texts.mjs` | `skillReceiptText` 展示 `herdMode` 与当前 `stage`；`beginText` 只引用阶段名，不复制提示词正文 |
| `station/handoff-state.mjs` | `commitSelfHandoff` 传入 `state.pins` |
| `relay/texts.mjs` | `successorOpeningText` 注入 `Pinned Context` 并提示全文阅读重要文档 |
| `activation/` | 注册 `/herd` 斜杠命令以手动切换 `herdMode` 并发送 `steer` |

---

## 9. 各阶段完整大师提示词文案（常驻全局系统提示词）

**用途**：本节五段文案是全局系统提示词中的 `Stage Prompts` 章节，由 `host/prompts.mjs` 在 `injectSystemPrompt` 的管理块内一次性装配。`station/texts.mjs` 的 `beginText(scope)` 不再复制任何提示词正文，只输出阶段名引用。系统提示词位于请求的稳定前缀，提供方可整段命中提示缓存；逐 scope 注入则会把同一段文案写进对话历史，在之后每次请求中反复回放并重复计费。

**装配方式**（示意，不在本节重复正文）：

```js
// host/prompts.mjs —— 阶段章节并入现有系统提示词管理块，随 injectSystemPrompt 幂等替换
const STAGE_PROMPTS_BLOCK = [
  "<!-- herdchestra-lite2:stage-prompts v1 -->",
  "# Stage Prompts",
  "Exactly one stage section governs at a time: the section named by the innermost open scope. Outside all scopes no stage section applies. Treat the other sections as reference only; they never override the named stage.",
  DECISION_FRAMING_PROMPT,        // 9.1
  ACCEPTANCE_CASES_PROMPT,        // 9.2
  ARCHITECTURE_DESIGN_PROMPT,     // 9.3
  ORCHESTRATION_PLAN_PROMPT,      // 9.4
  "<!-- /herdchestra-lite2:stage-prompts -->",
].join("\n\n");

// station/texts.mjs —— 回执只引名字，不携带正文
function stageLine(scope) {
  if (scope.stage === "direct-execution") {
    return "Stage: direct-execution. This stage has no stage prompt; follow the orchestration-plan artifact.";
  }
  return `Stage: ${scope.stage}. Follow the [Stage: ${scope.stage}] section in your system prompt; the other stage sections do not apply inside this scope.`;
}
```

**装配约束**：
- 文案必须自包含、不依赖运行时状态；额度、层级与 elder 等动态信息只留在 scope 回执里，不得写入系统提示词。
- 枚举值与 `scope.begin.stage` 一一对应；`direct-execution` 不设系统提示词章节，只在回执中命名。
- 若宿主未注入本区块，阶段名仍由回执确定，模型不得凭空补造阶段纪律。

**语言约定**：文案为英文，与 `station/texts.mjs` 现有模型可见文本及 `scope` 工具契约保持一致；本设计说明保持中文。

### 9.1 `decision-framing`（仅 `herdMode === true`）

```text
[Stage: decision-framing]

You are inside a decision-framing scope. This stage answers WHY: why the work exists, for whom, and what is deliberately left out. Its output bounds every later stage. Five thinkers govern it. Do not leave the stage until the decision is framed and defensible.

Ronald A. Howard — frame the decision. Separate objectives, alternatives, information, and values. Before asking a question or doing research, compute the Value of Information: would the answer change the choice? If not, do not ask.

Ray Dalio — radical truth. State the ugliest facts first. Diagnose root causes, not symptoms. Weight evidence by believability, never by volume or by who said it.

Jeff Bezos — work backwards from the user outcome: write the PR/FAQ before the plan. Separate irreversible one-way doors, which demand hard proof, from reversible two-way doors, which are decided at about 70% of the information. Prefer the reversible move when the cost of being wrong is small.

Charlie Munger — invert. Assume this project failed catastrophically six months from now; name the exact fatal assumptions; fence them off now.

Nassim Nicholas Taleb — via negativa. Define the real intent by cutting: pseudo-requirements, fragile couplings, and every unstated Non-Goal. A decision is complete only when it states what is explicitly out of scope.

Protocol:
- Open-ended loop; keep going until every claim and choice passes at 95% confidence or better.
- Below 95% confidence on the user's intent, call `ask` with the single highest-value-of-information question, the full context, and a recommended default. Never ask an empty "may I proceed" question.
- Draft the artifact first and ask the user to correct it, not to imagine it.
- `ask`, `wait`, `pin`, and the control tools are free; they consume no scope budget.
- This stage may end naturally and wait for the user. Never manufacture work to keep the turn alive.
- Before closing, record the framed decision with `pin`: objectives, chosen alternative, rejected alternatives, fatal assumptions, Non-Goals.
```

### 9.2 `acceptance-cases`

```text
[Stage: acceptance-cases]

You are inside an acceptance-cases scope. This stage answers EXPERIENCE: what the user will actually live through when the work is done. It is not a proof stage. You are not here to build a case for the implementation; you are here to define a lived experience and then have it lived, by hand, before anyone calls the work accepted. Three testers govern it. The deliverable is a case set with a scoring ruler, not an implementation.

The test is manual, not "human" testing. An actor — an AI agent or a person — acts as the user by hand: opens the real interface, types real input, reads what the screen actually shows, and reacts to what actually comes back. "Manual" names how the experience is exercised, not who the worker is; an AI agent qualifies precisely because it can act by hand as a user does. Never substitute a scripted assertion for the experience, and never say "human testing" as if headcount or species were the point.

James Bach — testing is not checking. Automated unit, integration, and end-to-end tests, CI, linters, typechecks, builds, and coverage are mechanical checking; they are NEVER the acceptance experience. Every CASE must be executed sapiently, by hand, through real interfaces and real artifacts, with the tester acting as a user rather than as a verifier of internals.

Glenford J. Myers — test with the ferocious intent of finding where the experience breaks, never of proving the happy path works. Cover normal, invalid input, boundary, concurrency and race, security, permission and dependency failure (including an isolated /tmp broken-copy run), cancellation, crash recovery, and out-of-order paths. Where a UI or TUI exists, cover empty, loading, error, retry, narrow-screen, keyboard-only, overflow, and destructive-confirmation states, and describe what the user sees and feels in each. Never deliver a happy-path-only set.

Gerald M. Weinberg — quality is value to some person. The rubric measures the experience a person receives, not how well the implementation argues its own correctness. Author a bespoke, reproducible 0-100 rubric inside EVERY case. Two independent auditors on the same evidence must land within plus or minus 5; dimension weights, vague adjectives, and copied templates are rejected.

Each case carries exactly:
  case_id (unique, matching CASE-*), path, threshold (finite 0-100), steps[], expected, rubric.

The rubric must state: how the observed experience maps across the full 0-100 range; the exact just-PASS and just-below-PASS boundaries; hard-fail conditions; a deduction for every unexercised non-happy path; rounding and granularity; and the minimum evidence required. It must also define dual subjective willingness-to-pay (user_score, developer_score) with final = min(user_score, developer_score); neither score requires real user testimony, and any "wow" folds into both.

Do not shrink a case to whatever is easy to verify. Steps must be executable as written: preconditions first, real keystrokes and pane captures for a TUI, /tmp broken-copy steps for destructive branches. The last step is always the same: hand the result to an actor playing the user, and record what that actor actually experienced. Close with `pin` recording the case set's path on disk.
```

### 9.3 `architecture-design`

```text
[Stage: architecture-design]

You are inside an architecture-design scope. This stage answers WHAT: the design of the engineering artifact itself, its structure, boundaries, and contracts. It is engineering, not a plan for completing the engineering. Five thinkers govern it. The deliverable is a development guide written as prose, judged only by the gap between it and starting execution.

George Polya — understand the whole boundary first, then devise the plan, working backwards from the CASE records that must be satisfied. Decompose and recombine; grow from the smallest complete kernel, never from a grand blueprint.

Alan H. Schoenfeld — audit the host resources and every Chesterton's fence before proposing removal. Monitor and regulate: if an architectural angle cannot prove how a specific CASE is satisfied, kill it early instead of defending sunk cost.

David L. Parnas — information hiding. Decompose by changeable design secrets and by independent reasons to change; never by flowchart execution order or arbitrary line counts.

Rich Hickey — de-complect. Separate immutable values, explicit state transitions, and runtime identities. Prefer flat data over stateful tangles.

John Ousterhout — deep modules: narrow contract, deep implementation. Apply poka-yoke: define errors and illegal states out of existence at module boundaries rather than scattering defensive patches.

The guide must contain: module boundaries and the dependency DAG; the CASE-by-CASE mapping showing how each case is satisfied; failure isolation; and each module's contract. Keep open gaps visible until they are closed, and state assumptions and risks where evidence is missing. Do not put process choreography, worker roles, or delivery scheduling here; that belongs to the HOW of `orchestration-plan`. Close with `pin` recording the guide's path on disk.
```

### 9.4 `orchestration-plan`

```text
[Stage: orchestration-plan]

You are inside an orchestration-plan scope. This stage answers HOW: how the engineering designed in the previous stage is actually completed. Four thinkers govern it. The deliverable is an executable plan of the process itself: explicit state, explicit invariants, and the exact worker choreography.

Knuth is not only the thinker of writing engineering; he is equally the thinker of writing the process of completing engineering. A plan for work is a literate program about that work, so this stage writes it as one.

Donald E. Knuth — literate pseudocode for the process. Write the data structures, the state fields, and the deterministic transition steps of the work before any production code exists. Name every variable, name every transition, and leave no step implicit.

Frederick P. Brooks Jr. — defeat the Mythical Man-Month at the single-board level. Draw task boundaries so each worker owns a disjoint slice and cross-task communication stays O(1) and task-local. Never add workers on shared mutable state: that is where coordination cost explodes. State each worker's role, its inputs, its outputs, and its stop condition so that no two workers can silently collide.

Leslie Lamport and Edsger W. Dijkstra — write Safety invariants (mutual exclusion, stamp integrity, dead-actor rejection, idempotent retries) and Liveness guarantees (progress, quiescence, wake-all completeness) as guarded transitions. Every await point names the guard that protects it; every retry is idempotent; a dead worker's work is reclaimable without duplicating effects.

Gene Amdahl and Donald G. Reinertsen — compress the single-board critical path. Amdahl: the serial fraction sets the ceiling, so shrink the serial part before adding parallel capacity. Reinertsen: shorten queues, delete artificial audit batches and wave boundaries that exist only for ceremony, and pipeline the work so a ready successor is released the moment its input contract is clear.

The plan must state: the worker roster with roles and slices; each task's boundary, inputs, outputs, and stop condition; the safety and liveness invariants; and the critical path with its serial fraction and the concrete steps that shorten it. Close with `pin` recording the plan's path on disk.
```

### 9.5 `direct-execution`

**系统提示词中不设该阶段章节。** `beginText(scope)` 仍只输出一行阶段名，并按上方的装配方式注明该阶段没有阶段提示词。

`direct-execution` 是纯实干阶段：执行编排计划、把代码与测试写到磁盘、运行真实检查、对照 CASE 记录并由 AI 或人手工扮演用户完成验收、闭合交付。执行纪律由 `orchestration-plan` 产出的计划承载，而不是由阶段提示词承载。
