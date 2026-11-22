---
name: todo-any-level
description: 修改 todo 工单、根分支接力、fork 身份、计费或 skill:// 读取准入时载入。
---

# 台账写入与接力评估

宿主原生 todo 持有台账。插件只处理准入和根分支的接力评估，不另存一份台账。

| 调用 | 根分支 | 子分支 |
|---|---|---|
| `todo view` | 不评估台账；成功读取可清除继承账本的 `viewRequired` | 不评估，也不清除根分支的继承义务 |
| `todo` 写入 | 非空账照常评估；空账且有未收结果时返回 `held`，接力状态不变 | 写原生台账，不改接力状态，不触发交接 |
| `read` 的 `skill://` 路径 | 免费放行 | 免费放行 |
| 普通 `read`（含其他 URL） | `ROOT_HAS_NO_BUDGET` | 扣本分支的 `read` 预算 |

未开启 autopilot 时原生台账直接生效、不评估接力；autopilot 开启且交接待定时返回 `RELAY_HANDOFF_PENDING`。根分支继承台账后，写入前须先 `view`，否则返回 `INHERITED_LEDGER_UNVIEWED`。autopilot 开启时原生台账仍可用，但只由根分支评估接力。

## 改动入口

- `src/host/fork-wiring.mjs`：`attachForkPorts` 提供 `forkOwnerId()`；根返回 `null`，子分支返回 `forkId`。依赖宿主令 `config.agentId = flowId`，故在 `createSession` 前预绑 `spec.agentId ?? spec.forkId`。先创建再绑定会把子分支误判为根，漏扣预算，且子分支空账可能触发交接。
- `src/station/gates.mjs`：在计费前放行 todo；未收子结果不得阻止台账写入。`src/scope/budget.mjs` 的 `isFreeCall` 统一判定免费工具和 `read` + `skill://` 路径；不为其他读路径豁免。
- `src/tools/todo.mjs`：在根分支执行 `recordLedgerEvaluation`、`armHandoff` 与 `markInheritedLedgerViewed`；子分支在原生调用后直接返回。原生结果缺快照时先依 transcript 回放找最近一次成功写入；仍找不到则保留原生结果，不推进接力。
- `src/station/handoff-state.mjs`：归根分支的空账冻结；`src/relay/texts.mjs` 根据结果选取 `resources/prompts/receipts/relay.md` 中的反馈，不能反过来由文案控制状态。

## 验收与围栏

- `tests/todo-any-level.test.mjs`：根非空评估、空账冻结、子分支读写不改变 relay、待定交接优先、根普通读取拒绝与子分支免费读取。原契约标记：`todo-any-level-forkjoin/1`。
- `tests/fork-todo-gate.test.mjs`：子分支有孙辈未收结果，仍可写。
- `tests/fork-wiring.test.mjs`：创建子会话期间已可解析 fork 身份。真实 omp 安装的创建时序不是单测结论；宿主改动身份分配时，须在真实会话走一次 `scope_fork` → 子分支 `todo`。

不恢复旧 `scope(begin/end)` 或 `TODO_OUTSIDE_SCOPE_ONLY`。新设计记录写入 `.agent/skills/<name>/SKILL.md`；历史 `docs/` 不因这份合同自动迁移。
