# 验收用例集：阶段门禁的两处修正

本文件定义两处修正的**体验**，不是实现证明。每个 CASE 由一名执行者（AI 或人）**手工**
扮演模型/用户，经由真实接口操作：

- 主代理侧：本仓库扩展已加载的真实 omp 会话，直接调用 `scope`、`todo` 工具。
- 子代理侧：用真实 `task` 工具派生的子代理会话（宿主会写入 `session_init`，`readOnly`
  由 agent 定义决定），在子代理内部调用 `scope`。
- handoff 侧：真实 relay 接力（提交空账本 → 本代际交接 → 继任者接手），不得用单元测试
  桩替代。

禁止把自动化测试（`bun test`）当作本 CASE 的通过证据。测试只证明代码自洽，本 CASE 证明
模型与用户实际经历的拒绝/放行。

被修正的两个缺陷（供执行者对照）：

1. relay handoff 后，`state.stageFlags` 仍然带着前任的 `acceptance-cases`、
   `architecture-design`、`orchestration-plan` 三个 `true`，继任者在一次 `direct-execution`
   都没重新开过的情况下即可执行。
2. 子代理（`READ_WRITE_SUBAGENT`，以及宿主未记录 `readOnly` 的旧会话）继承主代理的
   `STAGE_FLAGS_UNMET` 限制，无法在 S2–S5 间自由切换。

---

## CASE-GATE-1 — handoff 之后，三个门禁标志必须归零

- **case_id**: CASE-GATE-1
- **path**: 主代理真实会话；`todo` + `scope`；relay 接力边界
- **threshold**: 90
- **steps**:
  1. 在当前代际内依次开三个 scope：`stage: "acceptance-cases"`、`stage:
     "architecture-design"`、`stage: "orchestration-plan"`，每个都正常关闭。记录三次都
     未报错。
  2. 开一个 `stage: "direct-execution"` 的 scope，确认放行（这是交接前应有的状态），
     然后关闭它。
  3. 让 relay 进入交接：提交一次空账本（`todo` 写操作，列表为空）。记录本代际的
     `todo` 结果返回的 RELAY STATE：Generation 与 `canStop: no`。
  4. 继任者接手后，**不要**重新开 S2–S4，直接 `scope({ begin: { stage:
     "direct-execution", ... } })`。记录工具返回的原文。
  5. 依次开三个缺失阶段（顺序任意），再开 `direct-execution`。记录每步返回。
  6. 在步骤 5 之后关闭所有 scope，检查 `todo` 的 RELAY STATE 未被异常改写（仍在本代际，
     账本与步骤 3 一致）。
- **expected**: 步骤 4 返回 `STAGE_FLAGS_UNMET`，且文本点名的缺失阶段恰好是
  `acceptance-cases, architecture-design, orchestration-plan` 三项，不是零项、不是一项；
  此次拒绝不改变任何状态（步骤 5 重开 S2 依然成功、预算与 scope 计数无异常）。步骤 5
  按序重开后 `direct-execution` 被放行。步骤 6 账本与代际不变。
- **rubric**:
  - 维度与权重：门禁行为 50（步骤 4 拒绝 + 缺失阶段清单完整准确）、状态不被污染 20
    （拒绝后仍可正常重开三个阶段且无额外报错）、重开后放行 20（步骤 5 全部成功）、
    代际与账本稳定 10（步骤 6）。
  - just-PASS（90）：步骤 4 报 `STAGE_FLAGS_UNMET` 且缺三项全列；步骤 5 四次开启全部成功；
    步骤 6 账本无变化。允许扣分项只有回执文案措辞不清（最多扣 5）。
  - just-below-PASS（89 及以下）：缺失阶段只列出 1 或 2 项；步骤 4 放行；步骤 4 的拒绝
    造成状态损坏（后续重开 S2 报错）；步骤 6 代际或账本被意外改写。
  - 硬失败（记 0）：步骤 4 放行（缺陷未修）；继任者无需任何 S2–S4 就能执行；为了通过而
    把 `direct-execution` 的门禁整体删除（步骤 5 中 `direct-execution` 在未开 S2–S4 时
    也放行，则整体判 0，因为修了缺陷 1 却引入了更宽的漏洞）。
  - 未覆盖路径扣分：未在真实 handoff 中验证（改用单元测试或直接改文件模拟）、未验证
    拒绝后状态完好、未验证重开后放行——每缺一项扣 20。
  - 舍入与粒度：每个维度按 5 的整数倍打分，总分取整到 10 的整数倍，便于双审对齐。
  - 最低证据：步骤 4 与步骤 5 的工具返回原文（逐字），以及步骤 6 的 RELAY STATE 原文。
  - WTP：`user_score`（用户视角：这次接力是否让我相信新一代真的重新走过了三个阶段，
    而不是继承上一代的绿灯）；`developer_score`（维护视角：门禁是否只有一处真源、
    拒绝是否原子、证据是否可重放）。`final = min(user_score, developer_score)`。

---

## CASE-GATE-2 — 子代理可在 S2–S5 间任意切换

- **case_id**: CASE-GATE-2
- **path**: 真实 `task` 派生的读式子代理（拥有 `scope`/`edit` 等工具，即
  `READ_WRITE_SUBAGENT`）的真实子会话
- **threshold**: 85
- **steps**:
  1. 从主代理派生一个拥有写工具的子代理，任务要求它"先在 `direct-execution` 开 scope
     做一件小事"。
  2. 在该子代理内，**不**开任何 S2–S4，直接开 `stage: "direct-execution"`。记录返回。
  3. 关闭后，在子代理内按 `orchestration-plan` → `direct-execution` →
     `acceptance-cases` → `direct-execution` 的乱序依次开启并关闭。记录每步返回。
  4. 回到主代理，检查主代理自己开 `direct-execution`（在未跑 S2–S4 的情况下）得到的
     返回。
  5. 记录子代理是否产出任何 `STAGE_FLAGS_UNMET` 原文。
- **expected**: 步骤 2、3 全部放行，无一次 `STAGE_FLAGS_UNMET`；回退与重复开启都不被
  额外拦截（仅受原有 scope 边界规则约束：同一消息不得 begin+end 同一 scope、elder
  report 等）。步骤 4 主代理仍被拒绝，说明豁免只作用于子代理。步骤 5 为空。
- **rubric**:
  - 维度与权重：子代理放行 55（步骤 2、3 每一次开启）、豁免不外溢 30（步骤 4 主代理
    仍被拒）、可重复/回退 15（步骤 3 的乱序与重复）。
  - just-PASS（85）：步骤 2 放行，步骤 3 四次全放行，步骤 4 拒绝。允许扣分：子代理回执
    文案语气异常（最多扣 5）。
  - just-below-PASS：任一子代理开启被 `STAGE_FLAGS_UNMET` 拒绝；或步骤 4 主代理被放行
    （豁免外溢，等于把门禁删了）。
  - 硬失败（记 0）：仅在子代理中删除门禁（例如按工具名或 stage 全局放行，导致主代理也
    被放行）；或子代理的开启改写了主代理会话的 `stageFlags`（跨会话污染）。
  - 未覆盖路径扣分：未测旧式会话（`session_init` 无 `readOnly`、只有 `tools` 列表）、
    未测硬编码 `edit` 的读式子代理被判为读写子代理的情形——每缺一项扣 15。
  - 舍入与粒度：维度按 5 整数倍，总分取整到 5 的整数倍。
  - 最低证据：子代理内每次 `scope` 的返回原文与子代理的 `session_init`（`agent`、
    `readOnly`、`tools` 字段）；主代理步骤 4 的返回原文。
  - WTP：`user_score`（子代理是否真的能按需自由取阶段，而不是被主代理的账本绑架）；
    `developer_score`（豁免判定是否只用一处策略真源，是否可被旧会话正确分类）。
    `final = min(user_score, developer_score)`。

---

## CASE-GATE-3 — 主代理的顺序限制仍然成立，且不改动既有边界规则

- **case_id**: CASE-GATE-3
- **path**: 主代理真实会话；`scope` 的开始、组合（end+begin）、拒绝路径
- **threshold**: 90
- **steps**:
  1. 在未跑任何 S2–S4 的主代理会话里开 `direct-execution`，记录 `STAGE_FLAGS_UNMET`。
  2. 保持一个 scope 打开，用组合形式（`end: true` + `begin` 到 `direct-execution`）
     提交。记录返回，并确认原 scope **仍然开着**（随后的 `end: true` 成功）。
  3. 可只开 `acceptance-cases` 一个，再试 `direct-execution`，确认缺失清单只剩两项，
     且清单顺序与工作流顺序一致。
  4. 开 `decision-framing`（需 herd 模式）后检查三个标志被清零；随后 `direct-execution`
     再次被拒绝。若无 herd 模式可用，改为读取设置并如实记录"未执行"。
  5. 检查 `read`/`write` 等普通工具不因阶段未跑而被拦截。
- **expected**: 步骤 1 拒绝；步骤 2 拒绝且原 scope 未受损；步骤 3 缺失清单精确为另两项且
  顺序正确；步骤 4 决策框定清空标志；步骤 5 普通工具全程不被阶段门禁拒绝。
- **rubric**:
  - 维度 与权重：拒绝正确性 40、组合调用的原子性 30（先校验、失败不关 scope）、
    清单精确性与顺序 20、普通工具不受影响 10。
  - just-PASS（90）：步骤 1–3、5 全部符合预期；步骤 4 执行或如实记录不可用。
  - just-below-PASS：组合调用失败却先关闭了原 scope；或缺失清单顺序错乱；或普通工具被
    误拦。
  - 硬失败（记 0）：`direct-execution` 在主代理无前置阶段时被放行。
  - 未覆盖路径扣分：未测组合调用、未测清单顺序、未测普通工具——每缺一项扣 15。
  - 舍入与粒度：维度按 5 整数倍，总分取整到 5 的整数倍。
  - 最低证据：每次 `scope` 返回原文；失败后原 scope 仍在的回执；普通工具调用成功的一次
    记录。
  - WTP：`user_score`（限制是否仍然可信且不被新豁免顺手削掉）、`developer_score`（校验
    是否仍在任何状态变更之前）。`final = min(user_score, developer_score)`。
