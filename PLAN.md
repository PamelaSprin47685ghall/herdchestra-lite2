# 架构重构：工单服务站落地方案

| Field | Value |
| :--- | :--- |
| **Exported** | November 20, 2026 at 10:23 PM |
| **Model** | Gemini |
| **Messages** | 6 |

---

## 💬 Conversation

### 👤 User

目前工单服务站方法没有落实好。实际上，本项目是由若干或松散、或紧密耦合的功能构成的。我们应该让每个服务站对应一种功能，可以独立开启/关闭。这样也方便用户选择和消融。而且代码也会有章法，更优雅，而不是现在这种没分区。

---

### 🤖 Gemini

这份诊断非常准确。对照 AGENTS.md（工单服务站方法）审视当前仓库，问题不是局部代码风格，而是**架构边界已经退化成了「一个巨型上帝服务台 + 一个躲在 host/ 里的巨型异步调度器 + 两个影子前台接线层」**。这也是现在既无法按功能分区、也无法独立开关做消融（ablation）的根因。

下面先给出基于当前代码的精确诊断，再给出一套**「一功能一服务台、依赖显式成 DAG、支持干净消融、严格落地工单服务站方法」**的重构设计方案与渐进迁移路径。

---

### 一、现状审计：工单服务站方法在哪里失守了

对照 AGENTS.md 的三条铁律和反模式清单，当前代码有五处结构性破防：

1. **只有一个上帝服务台（SessionStation）与一坨共享大状态（createState()）**src/station/station.mjs 把作用域栈、预算、棋钟计时、defer、amend、pin、折叠与缓存经济学、模型切换、五阶段门禁、/herd、接力状态机、子代理 todo 授权、fission 退场门禁全部塞进了同一个 SessionStation。底层纯领域模块也被反向污染：src/scope/state.mjs 直接 import 了 createRelay 和 createStageFlags；src/scope/accounting.mjs 直接读取 state.herdMode、state.relay.fullFlow、state.relay.firstEvaluation、state.stageFlags。结果是哪怕只想保留最简单的“预算 scope”，也拆不掉 relay、stages 和 herd。持久化是单一的 scope.state 大快照，所有功能绑在同一条增量链上。
2. **最重的功能 fission 绕过了 ESLint，演化成了 AGENTS.md 明确反对的「第二套中心调度器」**eslint.config.mjs 只检查 src/station/、src/scope/、src/relay/ 禁 async/await。src/host/fission-scheduler.mjs（1600+ 行）躲在 src/host/ 下，把同步领域状态机（batches、flows、handoffs、broadcastLedger、paused、interruptGeneration）和异步 I/O 编排（spawnFlow、copyHandoff、runFlowTurn、finalizeBatch、resumeBroadcast）全揉在一个闭包里。同时因为所有状态都在一个 SessionStation 里，fission 不得不靠 SessionStation.forkForFlow() 的 Object.create(this) 原型继承、createFlowState() 的 getter/setter 代理（共享 herdMode/relay/stageFlags/pins）、以及 promote() 里硬编码 OWNER_MODE_KEYS 和手写 merge 来勉强隔离。连 src/host/provider-observer.mjs 都不得不写 Object.hasOwn(station, "providerObservation") 来防原型链串味。
3. **接线层退化成了「影子前台」**AGENTS.md §3.1 要求接线层只做纯机械装配、零业务判断。但现实是：src/activation/hooks.mjs 的 retirePendingBatch、batchRunning、session_stop、agent_end 直接读写 batch.remainingTrailingIds、batch.retired、station.pendingFission 并决定是否中止或吞掉 stop。src/activation/fission.mjs 承载了完整的输入广播窗口等待、Esc 暂停、dispose 升级屏障、tokenRate 转发、vibe 探测等业务状态机。
4. **工单越权、尾位置开单失守、全局可变单例暗度陈仓工单读内部状态做业务裁决**：src/tools/todo.mjs 的 todoTicket 直接读 currentScope(station.state)、station.state.herdMode、station.state.relay.handoffPending；src/host/provider-observer.mjs 直接往 station 身上挂 station.providerObservation 且窥探 station.state.amends/collapses/relay。**非尾位置开单**：SessionStation.policy(ctx) 在看似只读的查询中副作用调用 syncTodo() 开出 activateTools 工单；gates.mjs 的 prepareRequest 在 observeHostBoundary / observeActualModel 之前就开了 ensureTools 工单；controls.mjs 的 handleScopeCall 先 deliverSteer 再 queueModelSwitch。**全局单例**：registry.mjs（FLOWS_KEY、SCHEDULER_KEY）、status.mjs（STATE_KEY）、activation/fission.mjs（STATE_KEY）各自在 globalThis 挂状态表。
5. **消融被锁死在提示词、Schema 和不可关闭的 fission 上**fission 删除了单流开启入口（INVALID_BEGIN_SHAPE），哪怕开 1 条流也要走整套新起 AgentSession + 退场 + 收养 + UI 复用 + dispose 屏障，无法关闭。resources/prompts/system.md、tools/scope.md、station/texts.mjs 把十几个功能的规则硬拼在一起；即使在代码里跳过某个门禁，提示词和工具 Schema 仍会持续向模型灌输已关闭功能的规则，导致消融实验失真。

---

### 二、功能分区与服务台清单（依赖 DAG）

先划出**不可消融的薄底座（Core / Host Kernel）**，其余所有业务能力拆成 **14 个独立功能服务台**，严格分层、无环依赖。

#### 0. 薄底座（不承载业务规则，不可单独开关）

- **Host Adapter & Capture**：sessionOf、managerOf、modelOf、thinkingOf、contextHeaderOf、setAgentMessages、policy(ctx)（纯身份分类，不再偷偷激活 todo）。
- **Prompt & Schema Assembler**：按已启用功能列表，在启动期**静态**拼装系统提示词管理块和 scope 工具参数 Schema（启动后全程不变，不破坏 Prompt Cache）。
- **Context Pipeline & Receipt Commit**：context-preparation.mjs + hack-context.mjs 提供「每轮 <skill> 回执片段收集 + 唯一提交」与「出站消息顺序变换」两条管线。
- **Persistence Engine**：复用现有的 createPersistenceAnchor + delta/checkpoint 算法，供每个有状态服务台**按独立 customType 各自持久化**。
- **Diagnostics Ring**：64 槽环形缓冲 + /herd-diag（外加 /herd-features 打印当前开启/关闭的功能图谱）。

#### 1. 14 个功能服务台（一功能一服务台）

区分两种关系：**requires（硬依赖：前置关则本功能不可开）** 与 **enhances（软协同：两者都开时才生效，缺一不报错）**。

##### Layer 0 — 完全正交的基础功能（不依赖 scope，可任意独立开关）

|  |  |  |  |  |  |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 功能 ID | 服务台 | 单一职责与私有状态 | 硬依赖 | 可选软协同 (enhances) | Fission 下的作用域 |
| status | StatusStation | 编辑器上方单行用量/花费/前缀/主机/告警挂件（totals、last、去重缓存） | 无 | fission（代理归并到共享 manager） | Session 共享 |
| observer | ProviderObserverStation | before_provider_request / after_provider_response 帧哈希与前缀漂移分类 | 无 | amend/folding/relay（只读不透明 revision 令牌） | Flow 独立 |
| rules | PromptRulesStation | Repo-aware 通用工程规范、简体中文思考/回答提醒、vibe 文案改写与工具保留 | 无 | 可按子开关拆出 commonRules / chineseReminder / vibeCompat | Session 共享 |
| pin | PinStation | 会话级持久化备忘录（pin 工具，pins[]） | 无 | folding（折叠保 pin）、relay（交接注入 ## Pinned Context）、fission（合流去重） | Session 共享 |
| herd | HerdStation | /herd [text] 人工开关、herdMode、ask 工具放行门禁 | 无 | stages（锁 decision-framing）、relay（暂停接力）、scope（允许自然停） | Session 共享 |
| relay | RelayStation | todo 覆盖、fullFlow 按需启用、两空账晋升、自交接压缩、停机续推、读写子代理 todo 授权 | 无 | scope（scope 外才能调 todo、首次账本前禁 rw）、stages（交接/翻转清标志）、herd（暂停）、pin（注入 pin） | Session 共享 |

> **关键发现**：relay、pin、herd 实际上**都不硬依赖 scope**。把它们从 scope 解耦后，你可以做诸如「只要两空账接力，不要 scope 预算（relay + pin）」或「只要预算 scope，不要接力和阶段（scope + amend）」的纯消融实验。

##### Layer 1 — 作用域内核

|  |  |  |  |  |  |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 功能 ID | 服务台 | 单一职责与私有状态 | 硬依赖 | 可选软协同 | Fission 下的作用域 |
| scope | ScopeStation | 嵌套 scope 栈、按拍分摊的预算记账（1 单位/轮）、scope 外工具拦截、同消息执行屏障（dispatch-tracker、processed） | 无 | relay（放行 scope 外 todo） | Flow 独立（可 fork / adopt） |

> **关键清理**：ScopeStation 的 scope 记录只保留最小内核字段：{ id, intent, beginToolCallId, budget, remaining, spent, epoch }。不再出现 stage、deadlineAt、overtimeAt、defers、modelSpec、baseInputTokens、herdMode、relay、pins、stageFlags。

##### Layer 2 — 挂载在 scope 生命周期上的可消融能力（彼此独立）

|  |  |  |  |  |  |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 功能 ID | 服务台 | 单一职责与私有状态 | 硬依赖 | 可选软协同 | Fission 下的作用域 |
| timer | TimerStation | begin.time 墙钟预算、Map<scopeId, { budgetMs, deadlineAt, overtimeAt }>、超时+1s强杀与棋钟训斥、UTC 会话时钟 | scope | fission（barrier 尾随工具按批次 deadline 计时） | Flow 独立 |
| defer | DeferStation | defer 工具、Map<scopeId, { active[], residual[] }>、出 scope 时 steer 交付 | scope | amend（撤销拍子里的 defer 转 residual）、fission（流结束丢弃残余并告警） | Flow 独立 |
| amend | AmendStation | amend 工具、amends[]（被撤拍子键列表）、出站过滤 filterAmends | scope | defer（转 residual）、folding（rebase 时裁剪死键）、fission（抄写不复活已撤拍子，收养合并） | Flow 独立 |
| folding | FoldingStation | elder_report 热工作台、collapses[]、modelCaches{}、usage-ledger、缓存租金与 82%/90% 折叠、分支重写 | scope | pin（保留 pin）、amend（裁剪死键）、modelSwitch（多模型缓存视角与 95% 溢窗拦截） | Flow 独立 |
| modelSwitch | ModelSwitchStation | model 规格解析、Map<scopeId, ModelChoice>、baseModel、modelRecovery、/switch 恢复 | scope | folding（提供目标模型定价与窗口） | Flow 独立 |
| stages | StageStation | 五阶段枚举与系统提示词前缀、Map<scopeId, stage>、stageFlags 及 direct-execution 顺序门禁 | scope | herd（开 herd 仅许 decision-framing）、relay（仅 fullFlow 下启门禁，凭代际水印自动清零） | Session 共享（stageFlags）+ Flow 独立（stageByScope） |
| fission | FissionStation | 并发多流批次状态机、流生命周期、抄写队列、广播台账、Esc 暂停/恢复、所有者退场与继承者收养 | scope | pin、amend、folding、timer、modelSwitch、status（通过各自标准接口协同） | Session 共享 |

依赖关系是一个干净的浅层 DAG（最大深度只有 2）：

```
Layer 0（正交）:  status   observer   rules   pin   herd   relay
                                                            ┆ (软协同)
Layer 1（内核）:                      scope ◄───────────────┘
                   ┌──────┬──────┬──────┼──────┬──────────┬────────┐
Layer 2（挂靠）:  timer  defer  amend  folding modelSwitch stages fission
                                         ▲  ▲                ▲
                                    (软)─┘  └─(软)          (软: herd, relay)
```

---

### 三、五大关键机制：如何做到「零互引、可消融、仍守住强不变式」

仅仅画框图不够，真正决定重构能否落地的，是解决五个硬骨头。

#### 机制 1：区分「松耦合管线」与「紧耦合跨台事务」（严格落实 AGENTS.md）

1. **松耦合功能走「声明式管线贡献」**（由接线层按固定因果顺序挂到宿主事件或管线，服务台之间互不知情）：**Tool Call 门禁链（短路）**：fission(ownerRetired / barrier / flowScope) → relay(handoffPending / todoOutsideOnly) → herd(ask) → scope(inScope & budget) → timer(markOvertime)。哪个功能关闭，链表里就没有那一段。**Outbound Context 变换链（纯顺序）**：amend(filterAmends) → folding(accrue & applyCollapses) → rules(rewriteVibe) → folding(noteSentContext)。**Skill 回执拼装**：每个已启用服务台提供同步只读方法 receiptFragment(ctx, snapshots)，只渲染自己那一行（如 scope 出层级/预算、timer 出 UTC 时钟、folding 出 pending elder、herd 出模式、stages 出当前阶段、relay 出流状态与下一步）。**Stop 裁决链（短路）**：fission(batchLive) → herd(allowStop) → scope(openScopeContinue) → relay(handoff/nudge/allow)。
2. **紧耦合跨台事务走「工单 + 只读快照 + 纯领域决策函数 + 三段式提交」**（AGENTS.md 指南 3 & 指南 5）：以最复杂的 **scope({ begin })（scopeBeginTicket）** 为例：// src/workflows/scope-begin.ticket.mjs（唯一允许 await 的编排层）
   // Phase 1: 只读快照 + 纯领域预检（零变更，任一拒绝即原子返回）
   const snap = {
   scope: stations.scope.snapshot(),
   fission: stations.fission?.snapshot(ctx),
   relay: stations.relay?.snapshot(ctx),
   herd: stations.herd?.snapshot(),
   stages: stations.stages?.snapshot(),
   timer: stations.timer?.snapshot(),
   folding: stations.folding?.snapshot(ctx, base),
   model: stations.modelSwitch?.snapshot(ctx),
   };
   const plan = planScopeBegin(args, snap); // 纯领域函数，不 import 任何 Station 类
   if (!plan.ok) return errorResult(plan.code, plan.message, plan.details);
   
   // Phase 2: 同步原子提交（Compute 完毕后才 Commit，全部纯同步）
   if (plan.elderArchive) stations.folding?.commitElder(plan.elderArchive);
   if (plan.foldBatch) stations.folding?.foldAndRebase(plan.foldBatch);
   if (plan.overflowCheck) { /* 复核 95% 窗口，不通过直接返回 */ }
   
   const opened = plan.mode === "fission"
   ? stations.fission.commitRegisterBatch(plan.batchSpec)
   : stations.scope.commitBegin(plan.scopeSpec);
   
   stations.stages?.commitStageBegin(opened.id, plan.stage, snap.relay);
   stations.timer?.commitStart(opened.id, plan.timeMs);
   stations.relay?.commitScopeOpened(plan.herdOn);
   const switchReq = stations.modelSwitch?.commitQueueSwitch(opened.id, plan.modelPlan);
   
   // Phase 3: 尾位置开异步工单（仅在所有状态提交之后）
   if (switchReq) await runModelSwitchAndReconcile(stations.modelSwitch, ctx, switchReq);
   return formatScopeBeginResult(opened, plan, stations);再看 **amendTicket**：读 scope.snapshot() 与 amend.snapshot()；调纯函数 findAmendTarget(scopeSnap, amendKeys, base, index)；同步提交：amendStation.record(beat.key) + scopeStation.refund(scopeId, beat.toolCalls) + deferStation?.moveToResidual(scopeId, beat.toolCallIds)。**效果**：ScopeStation、AmendStation、DeferStation、StageStation、RelayStation、FoldingStation **互相零 import**；关掉其中任何一个，stations.xxx 为 null，planScopeBegin 直接跳过该维度的校验和产出。

#### 机制 2：独立持久化 + 代际水印（彻底告别单一 scope.state 与跨台锁）

- 每个有状态服务台持有自己的 PersistenceAnchor，写到独立命名空间 herd.<feature>.state（如 herd.scope.state、herd.relay.state、herd.folding.state、herd.stages.state、herd.pin.state 等）。因为 planStateEntry 在无变更时返回 null，一轮中没变的服务台写 0 字节；高频变化的 scope.charges 触发 checkpoint 时，也不会拖着 pins、collapses、modelCaches 一起重写。启动恢复时提供一层只读兼容适配器：若分支上尚无 herd.<feature>.state，从旧版 scope.state 读取对应切片一次，升级零破坏。
- **如何无锁保证「Relay 交接 / fullFlow 翻转时 StageStation 标志必然清零」？（原 stage-gates-fix.md S2 不变量）**不依赖「同时持久化两个服务台」的脆弱假设，改用 **水印（Watermark）**：StageStation 的状态是 { relayGen, fullFlowEpoch, flags }。每次工单向它查询门禁时，传入 RelayStation 当前的 (generation, fullFlowEpoch)；只要水印不等，StageStation 直接视标志为全 false 并就地复位。即使进程在 RelayStation.persist() 之后、StageStation.persist() 之前崩溃，重启后依然绝对不可能误用上一代的绿灯。

#### 机制 3：把 Fission 真正工单化，并使其可完整关闭

这是当前仓库收益最大的改造，解决两个顽疾：

1. **拆解 1600 行的 fission-scheduler.mjs 与 activation/fission.mjsFissionStation（纯同步，纳入 ESLint 强约束）**：只持有内存领域状态（batches、flows、handoffQueue、broadcastLedger、ownerRetirements、paused、interruptGeneration）和三段式同步方法，返回判别联合指令（{ kind: "spawn" | "copy" | "nudge" | "adopt" | "pause" | "carryOver" | "noop" }）。**Fission Tickets（瘦协程）**：startBatchTicket、flowTurnTicket、handoffFlushTicket、finalizeBatchTicket、pauseAllTicket、resumeBroadcastTicket、disposeBarrierTicket。每次 await 返回后，携带 turnEpoch / interruptGeneration 调 fissionStation.reconcileXxx(...) 核销，过时即自退（AGENTS.md §2.2 协作式取消 + 指南 4 三明治模式）。**Host Bridges（纯机械适配器）**：fission-manager.mjs、fission-session.mjs、fission-ui.mjs、event-mux.mjs、queue-retraction.mjs 不持有任何业务决策。
2. **用「服务台归属」替代 createFlowState() 和 Object.create(this)**既然功能按服务台拆开了，创建一条 Flow 时，容器只需组装该 Flow 的服务台集合：**Session 级服务台**（relay、herd、pin、status、fission、rules、stages.flags）：直接传**同一个实例引用**；**Flow 级服务台**（scope、timer、defer、amend、folding、modelSwitch、observer）：各自调用自己的 forkForFlow(flowManager) 生成独立实例；继承者收养时，对每个 Flow 级服务台调用它自己的 adoptFromHeir(heirStation)（例如 AmendStation 并集 amends、FoldingStation 合并 collapses/modelCaches、ModelSwitchStation 保留 owner 基准模型）。FissionStation 从此**完全不知道** collapses、amends、modelCaches、OWNER_MODE_KEYS 这些别家内部字段的存在！
3. **恢复 ScopeStation 原生单流能力，让 fission: false 成为一等公民**src/scope/accounting.mjs 本就保留着完整的单流 beginScope / closeScope。当 fission: false 时：不安装 installFissionUI、installFissionInput、installDisposeBarrier、不代理 SessionManager、不退场 owner；scope({ begin }) 直接在当前会话栈上压入 scope（工具 Schema 与提示词也自动切为单流形态 { intent, budget, ... }）。这样既支持消融「并发 fission 相比单流 scope 的收益/成本」，又在需要排查宿主 seam 问题时有一键退回纯净单流模式的安全阀。

#### 机制 4：提示词与工具 Schema 按功能动态装配（保证消融纯净）

消融最怕「代码关了，提示词还在说」。所有模型可见资产按功能切片：

```
resources/prompts/
  rules/          # common-rules.md, language.md, vibe-mode.md
  scope/          # rules.md, tool.md, receipts.md, errors.md
  timer/          # rules.md, param.md, receipts.md, errors.md
  defer/          # rules.md, tool.md, receipts.md, errors.md
  amend/          # rules.md, tool.md, receipts.md, errors.md
  pin/            # rules.md, tool.md, receipts.md
  folding/        # rules.md, param.md, receipts.md, errors.md
  model-switch/   # rules.md, param.md, errors.md
  stages/         # rules.md, header.md, stages.md, param.md, errors.md
  herd/           # rules.md, receipts.md, errors.md
  relay/          # rules.md, todo.md, param-permission.md, receipts.md, errors.md
  fission/        # rules.md, param.md, receipts.md, errors.md
```

启动时 assemblePromptBlock(enabledFeatures) 和 assembleScopeSchema(enabledFeatures) 一次性产出冻结的系统提示词与工具 Schema：

- 关掉 timer → Schema 无 time 字段、系统提示词无棋钟规则、回执无 UTC 时钟；
- 关掉 folding → Schema 无 elder_report、无热工作台规则、无 pending elder 行；
- 关掉 stages → Schema 无 stage、系统提示词不注入 Stage Prompts 大块；
- 关掉 relay → 不注册 todo 覆盖工具、Schema 无 permission（若 herd/stages 也关）、无 RELAY STATE；
- 关掉 fission → Schema 为单流 { intent, budget, ... }，无 fission 规则。

#### 机制 5：用户配置、预设与 ESLint 硬卡死

1. **配置与消融预设**（优先级：调用参数 > HERD_FEATURES 环境变量 > 配置文件 > 默认 full）：预设示例：full：全开（默认）single-flow：全开，唯独关 fissionno-relay：关 relay（消融接力协议）no-stages：关 stages（消融五阶段提示词与门禁）no-folding：关 folding（消融折叠经济学）no-timer：关 timer（消融棋钟超时）minimal-scope：只开 scope + statusrelay-only：只开 relay + pin + status依赖解析规则（poka-yoke）：显式矛盾（如 enable: ["folding"], disable: ["scope"]）→ **启动期显式报错**，不悄悄忽略；只传 disable: ["scope"] → **级联关闭**所有硬依赖它的功能，并在 /herd-features 明确标注关闭原因（user vs cascade(scope)）。
2. **ESLint 静态卡死两条铁律**（eslint.config.mjs）：规则 1：所有 src/features/**/station.mjs 与 src/features/**/domain/**/*.mjs **禁止 async / await / for await**（彻底堵死 fission-scheduler.mjs 这种漏洞）。规则 2：用 no-restricted-imports 静态禁止 src/features/<A>/** 引入任何其他 src/features/<B>/**。跨服务台协作**只能**发生在 src/workflows/（工单 + 跨台纯领域决策函数）与 src/activation/（纯机械组装）。

---

### 四、目标目录布局

```
src/
  main.mjs                        # 极薄入口：解析功能开关 → 装配底座 → wireFeatures
  core/                           # 不可消融的共享底座（无业务规则）
    host/                         # capture, adapter, policy, diagnostics, headless-tui,
                                  # context-preparation, hack-context, scope-dispatch
    persistence/                  # persistence-anchor, delta-engine, legacy-migrator
    prompts/                      # loadDoc, render, assembler
    features/                     # resolveFeatureGraph, presets, container（无 globalThis 单例）
  features/                       # 14 个自治功能区（彼此严禁 import！）
    status/                       # station.mjs, usage.mjs, index.mjs
    observer/                     # station.mjs, request-frames.mjs, provider-projector.mjs, index.mjs
    rules/                        # station.mjs, vibe-rewrite.mjs, index.mjs
    pin/                          # station.mjs, index.mjs
    herd/                         # station.mjs, index.mjs
    relay/                        # station.mjs, domain/{state,ledger}.mjs, texts.mjs, todo.ticket.mjs, index.mjs
    scope/                        # station.mjs, domain/{state,budget,accounting}.mjs, dispatch-tracker.mjs, index.mjs
    timer/                        # station.mjs, domain/clock.mjs, index.mjs
    defer/                        # station.mjs, index.mjs
    amend/                        # station.mjs, domain/amend.mjs, index.mjs
    folding/                      # station.mjs, domain/{economics,usage-ledger,collapse}.mjs, fold.mjs, index.mjs
    model-switch/                 # station.mjs, pricing.mjs, switch.ticket.mjs, index.mjs
    stages/                       # station.mjs, domain/{stages,stage-flags}.mjs, index.mjs
    fission/                      # station.mjs (纯同步!), domain/{plan,broadcast,handoff-queue}.mjs,
                                  # tickets/{start,turn,handoff,finalize,pause,barrier}.mjs,
                                  # host/{manager,session,ui,event-mux,journal,queue-retraction}.mjs, index.mjs
  workflows/                      # 跨台纯领域协调函数 + 跨台工单（唯一允许同时引用多台快照之处）
    scope-begin.policy.mjs        # 纯函数：整合已启用的多台快照做 begin 预检
    scope-begin.ticket.mjs        # 三段式工单：Snapshot -> Commit -> Dispatch
    scope-end.ticket.mjs          # close + folding + defer steer + model restore
    amend.ticket.mjs              # amend + scope refund + defer residual
    handoff.ticket.mjs            # relay self-handoff + pin 注入 + host boundary 同步
    turn-hooks.mjs                # 组合 tool_call / context / stop / compact 管线
  activation/                     # 纯机械组合根（零业务分支）
    index.mjs                     # 根据 feature graph 实例化服务台、绑定宿主事件/工具/命令
    commands.mjs                  # /herd-diag, /herd-features
```

---

### 五、渐进式迁移路径（低风险、每步全绿）

不建议一次推倒重写，按耦合度从外向内分五步切分，每步都有现有测试套件兜底：

1. **Step 1：建立底座与配置骨架 + 迁出 4 个零依赖服务台**引入 src/core/features/（特性表、依赖图解析、预设、/herd-features）与 ESLint 双铁律。把 status、observer、rules、pin 独立成第一批自治服务台，先消除 provider-observer.mjs 写 station 字段和 status.mjs 全局单例。验收：单独关掉这 4 个中的任意子集，全量测试与对应消融测试均通过。
2. **Step 2：剥离 scope 的 4 个轻/中度挂靠服务台（timer、defer、amend、modelSwitch）**从 ScopeStation / createState() 抽离这四块状态，各自挂独立 PersistenceAnchor（附旧 scope.state 只读兼容）。落地 amend.ticket.mjs 与 scope-end.ticket.mjs，修复 handleScopeCall 里先 deliverSteer 再 queueModelSwitch 的非尾位置开单问题。
3. **Step 3：剥离 folding（缓存经济学 + usage-ledger + elder_report）**把 collapses、modelCaches、usage-ledger、fold.mjs 完整归入 FoldingStation。消融验证：folding: false 时 scope.begin 不再要求 elder_report，出站不做折叠重写。
4. **Step 4：剥离 herd、stages、relay + 落地提示词/Schema/回执动态装配**把 policy(ctx) 改成纯只读查询，把 todo 激活移到 RelayStation 的显式门卫尾部。StageStation 改用水印 (relayGen, fullFlowEpoch) 替代跨台事务同步清零。拆分 resources/prompts/，让系统提示词、工具 Schema、<skill> 回执随功能开关纯净裁剪；落地 workflows/scope-begin.{policy,ticket}.mjs。
5. **Step 5：重写 fission（拆开 fission-scheduler.mjs 与影子前台）+ 恢复单流可切换**拆出纯同步 FissionStation + 瘦工单协程，把 activation/hooks.mjs 与 activation/fission.mjs 里的业务状态机全部收回 FissionStation 与 fission/tickets/。用「Session 级共享服务台 + Flow 级 forkForFlow/adoptFromHeir」替换 createFlowState 和 SessionStation.forkForFlow。恢复 fission: false 下的原生单流 scope({ begin })，让 fission 可以真正独立关闭。

---

### 六、动手前需要和你确认的 3 个边界取舍

在开始拆代码之前，有三个会影响对外契约的决定最好先定下来：

1. **关闭 fission 时，scope.begin 的参数形状是否跟随退化？方案 A（推荐，利于消融）**：fission: false 时 scope.begin 自动切回扁平单流形状 { intent, budget, ... }，不出现 fission 数组字样；fission: true 时保持当前 { fission: [...] } 形状。提示词与 Schema 同步切换。**方案 B**：外部永远保持 fission: [...] 形状，只是 fission: false 时只接受长度为 1 的数组并在当前会话原地执行（不新起 AgentSession）。
2. **rules（Repo-aware Rules / 简体中文提醒 / Vibe 改写）是否需要拆成细粒度开关？**消融实验里经常需要单独关闭「Repo-aware Rules」或「强制简体中文」，建议把 rules 作为一个服务台，但内部提供三个独立开关（或直接拆成 commonRules、chineseReminder、vibeCompat），你倾向哪种粒度？
3. **功能开关的配置入口**：除了 HERD_FEATURES 环境变量与 activate(pi, { features }) 传参外，是否需要读 ~/.omp/agent/herdchestra.json（及项目级 .omp/herdchestra.json）作为持久化用户配置？

如果你确认这三个方向，我可以先按 **Step 1（底座 + 特性图 + ESLint 双铁律 + 首批正交服务台）** 写出详细的接口契约与施工计划，再一步步推进。

---

### 👤 User

关闭 fission 时，scope.begin 的参数形状是否跟随退化？方案 A。rules（Repo-aware Rules / 简体中文提醒 / Vibe 改写）需要拆成细粒度开关。功能开关用环境变量，默认全开，每个环境变量控制一个功能关闭。请你输出讨论小结。

---

### 🤖 Gemini

42.6s

---

### 🤖 Gemini

## 讨论小结：按功能分区落实工单服务站方法与可消融架构

### 1. 核心诊断

当前代码尚未真正落实 AGENTS.md 的工单服务站方法，且无法按功能选择或消融，根因有五点：

1. **上帝服务台与共享大状态**：SessionStation 与 createState() 吞并了全部功能，src/scope/accounting.mjs 反向依赖 stages/relay/herd，所有状态绑在单一 scope.state 快照上。
2. **躲在 host/ 里的第二套状态机**：src/host/fission-scheduler.mjs（1600+ 行）混写同步状态与 async/await 流程，绕过了 eslint.config.mjs 的同步约束。
3. **接线层退化为影子前台**：src/activation/hooks.mjs 与 src/activation/fission.mjs 持有领域状态和业务分支。
4. **越权工单、非尾位置开单与全局单例**：todoTicket 直接读内部状态裁决；policy(ctx) / prepareRequest / handleScopeCall 存在非尾位置开单；registry.mjs、status.mjs、activation/fission.mjs 各自维护 globalThis 可变单例；forkForFlow 依赖 Object.create(this) 原型继承与 createFlowState 代理补丁。
5. **消融不纯净**：fission 删掉了单流开启路径无法关闭；提示词、工具 Schema、<skill> 回执硬编码耦合在一起，关代码不关文案会污染实验。

---

### 2. 已确认的关键决策

1. **一功能一服务台，共 16 个自治功能服务台**：每个服务台是纯同步充血聚合根，严禁 async/await，服务台之间严禁互相 import，各自持有独立状态与 PersistenceAnchor（herd.<feature>.state，首次加载只读兼容旧 scope.state）。
2. **fission 关闭时采用方案 A（Schema 随开关退化）**：fission 开启（默认）：scope.begin 使用 { fission: [...] } 并发批形态，走 FissionStation + 瘦工单协程 + 宿主 UI/输入/dispose 桥。fission 关闭：scope.begin 退化为扁平单流形态 { intent, budget, ... }（仅包含其余已启用功能的参数），由 ScopeStation 在当前会话原地执行，**不安装** fission-ui、fission-input、dispose-barrier，不新起 AgentSession，不退场 owner。
3. **rules 拆分为 3 个细粒度开关**：commonRules（Repo-aware Rules 工程/沟通规范）chineseReminder（简体中文思考与回答提醒）vibeCompat（vibe 模式文案改写与 activateVibeTools 工具保留）
4. **功能开关统一由环境变量控制，默认全开，一个环境变量控制一个功能关闭**：不引入额外配置文件，统一约定 HERD_DISABLE_<FEATURE>=1（1/true/yes/on 视为关闭，未设或 0/false/空串视为开启）。关闭前置硬依赖（如 HERD_DISABLE_SCOPE=1）时，自动**级联关闭**所有硬依赖它的功能，并在 /herd-features（或 /herd-diag）中明确标出关闭原因（env vs cascade: scope）。

---

### 3. 16 个功能服务台、环境变量与依赖 DAG

公共薄底座（不可消融）：Host Capture/Adapter、policy(ctx) 纯只读身份分类、Prompt/Schema 启动期静态拼装器、Context Preparation 提交管线、通用增量持久化引擎、Diagnostics 环形缓冲与 /herd-diag、/herd-features。

|  |  |  |  |  |  |  |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 层级 | 功能 ID | 关闭环境变量 | 单一职责 | 硬依赖 | 可选软协同 (enhances) | Fission 作用域 |
| Layer 0 | status | HERD_DISABLE_STATUS | 编辑器上方单行用量/花费/前缀/主机/告警挂件 | 无 | fission | Session 共享 |
| Layer 0 | observer | HERD_DISABLE_OBSERVER | before_provider_request / after_provider_response 前缀漂移观测 | 无 | amend/folding/relay（不透明 revision） | Flow 独立 |
| Layer 0 | commonRules | HERD_DISABLE_COMMON_RULES | Repo-aware 工程/沟通/元规则系统提示词 | 无 | 无 | Session 共享 |
| Layer 0 | chineseReminder | HERD_DISABLE_CHINESE_REMINDER | 持久规则与每轮回执中的简体中文提醒 | 无 | 无 | Session 共享 |
| Layer 0 | vibeCompat | HERD_DISABLE_VIBE_COMPAT | vibe 上下文文案改写与 activateVibeTools 保留工具 | 无 | 无 | Session 共享 |
| Layer 0 | pin | HERD_DISABLE_PIN | pin 工具与会话级持久化备忘录 | 无 | folding、relay、fission | Session 共享 |
| Layer 0 | herd | HERD_DISABLE_HERD | /herd [text] 开关、herdMode、ask 门禁 | 无 | stages、relay、scope | Session 共享 |
| Layer 0 | relay | HERD_DISABLE_RELAY | todo 覆盖、fullFlow 开关、两空账晋升、自交接压缩、子代理 todo 授权 | 无 | scope（scope 外 todo 与 rw 门禁）、stages、herd、pin | Session 共享 |
| Layer 1 | scope | HERD_DISABLE_SCOPE | 嵌套 scope 栈、按拍分摊预算记账、scope 外拦截、同消息执行屏障 | 无 | relay | Flow 独立 |
| Layer 2 | timer | HERD_DISABLE_TIMER | begin.time 墙钟、deadline+1s 强杀、棋钟超时训斥、UTC 时钟 | scope | fission | Flow 独立 |
| Layer 2 | defer | HERD_DISABLE_DEFER | defer 工具、出 scope 时 steer 交付 | scope | amend、fission | Flow 独立 |
| Layer 2 | amend | HERD_DISABLE_AMEND | amend 工具、拍子回退与预算退还、出站过滤 | scope | defer、folding、fission | Flow 独立 |
| Layer 2 | folding | HERD_DISABLE_FOLDING | elder_report 热工作台、usage-ledger、缓存租金、82%/90% 折叠与 rebase | scope | pin、amend、modelSwitch | Flow 独立 |
| Layer 2 | modelSwitch | HERD_DISABLE_MODEL_SWITCH | scope/flow 级 model 解析、/switch 切换与压缩恢复 | scope | folding | Flow 独立 |
| Layer 2 | stages | HERD_DISABLE_STAGES | 五阶段提示词块、阶段记录、stageFlags 门禁（凭代际水印自动清零） | scope | herd、relay | 标志共享 / 栈独立 |
| Layer 2 | fission | HERD_DISABLE_FISSION | 并发多流批调度、共享日志抄写、广播台账、Esc 暂停/恢复、退场与收养 | scope | pin、amend、folding、timer、modelSwitch、status | Session 共享 |

---

### 4. 核心协作与约束机制

1. **松耦合走声明式管线，紧耦合走跨台工单 + 纯领域函数**：Tool Call 门禁链、Context 变换链、Stop 裁决链、<skill> 回执片段由接线层在启动期按固定因果顺序装配，关闭的功能不进入链条。scope.begin、scope.end、amend、handoff 等跨台事务放在 src/workflows/，严格执行 **读取多台只读快照 → 纯领域决策函数预检 → 同步原子提交 → 尾部开异步工单**（Compute → Commit → Dispatch）。
2. **提示词、工具 Schema 与回执同步裁剪**：resources/prompts/ 按功能分区；启动时依据已启用功能**一次性静态拼装**系统提示词管理块与 scope 工具参数 Schema，保证消融无文案残留且 Prompt Cache 前缀全程稳定。当 relay 与 stages 均关闭时，scope.begin 不再要求无实际意义的 permission 字段。
3. **水印消解跨台持久化锁**：StageStation 记录 (relayGen, fullFlowEpoch) 水印，校验时与 RelayStation 快照比对，不相等即视三标志为全 false，崩溃也不存在半状态。
4. **Fission 用服务台归属取代原型继承补丁**：Session 级服务台直接共享引用，Flow 级服务台各自实现 forkForFlow() 与 adoptFromHeir()，消灭 createFlowState、Object.create(this) 和 OWNER_MODE_KEYS。
5. **ESLint 双重静态卡死**：规则 1：所有 src/features/**/station.mjs 与 domain/**/*.mjs 严禁 async/await/for await（含 FissionStation）。规则 2：用 no-restricted-imports 严禁任意 src/features/<A>/ 引用 src/features/<B>/。

---

### 5. 渐进式实施顺序

1. **Step 1**：搭建 src/core/features/（16 项环境变量解析、级联规则、/herd-features）与 ESLint 双铁律；拆出首批零依赖服务台（status、observer、commonRules、chineseReminder、vibeCompat、pin）。
2. **Step 2**：从 ScopeStation 剥离 timer、defer、amend、modelSwitch，独立持久化并落地 amend / scope-end 跨台工单。
3. **Step 3**：剥离 folding（elder_report、usage-ledger、折叠经济学与 rebase）。
4. **Step 4**：剥离 herd、stages、relay，落地按功能动态拼装的系统提示词、工具 Schema、<skill> 回执与 scope-begin 跨台工单。
5. **Step 5**：拆解 fission-scheduler.mjs 与影子前台为纯同步 FissionStation + 瘦工单协程 + 纯宿主桥，并恢复 HERD_DISABLE_FISSION=1 下的单流退化模式（方案 A）。


---

*Exported by [AI Chat Exporter for Google AI Studio](https://github.com/TheRajatJain/ai-chat-exporter) · November 20, 2026 at 10:23 PM*
