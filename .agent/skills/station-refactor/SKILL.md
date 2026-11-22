---
name: station-refactor
description: Use when making every feature port the only production path and enforcing the Ticket Station Method in HerdchestraLite2. Covers the ablation matrix, Station/Ticket/Wiring boundaries, and the phased strangler plan.
---

# Station Refactor

## 目标

让抽象层成为唯一生产路径：每个功能端口要么被生产消费、可单独关停，要么被删除；Station 是充血聚合根，Ticket 只做异步编排，Wiring 只做机械装配。验收不是“代码看起来分层”，而是关掉一个端口后系统行为按定义变化，且测试能证明。

## 已选目标 A

端口必须真正可关停/替换：生产唯一路径 + 定义关闭行为（fail-fast 或文档化降级，二选一）+ 消融测试。半删残留与死代码一并清理（B 是 A 的子集）。

## 非目标

- 不做一次性大重构；按 Phase 切片，每片可回退。
- 不保留兼容别名或“测试专用档”；旧行为要么接线，要么删除。
- 不把 `.agent` 设计记录写成日记；运行结果放 pin/ledger，这里只放可复用决策。

## 阶段

- Phase 0：基线、三份勘测、工作区归属。
- Phase 1：Station 卫生（重复方法、fire-and-forget catch-all、policy 纯查询、onContext Compute→Commit）。
- Phase 2：folding/clock 端口成为唯一生产路径；契约测试走组合根；消融测试。
- Phase 3：scope(bare/batch)、relay 三档、nullTickets、死代码收敛。
- Phase 4：Station 充血，按事件切片（tool_call、context、fork/join、relay/handoff），每片加棘轮。
- Phase 5：Wiring 收薄（spawnChildTicket、attachStation、业务分支）。
- Phase 6：全量 test/lint/smoke + 手工场景 + 文档。

## 记录

- `station.md`：SessionStation 类地图、Phase 1 精确补丁、测试契约、与未提交改动的重叠。
- `ports.md`：12 个端口的生产消费者/测试专用实现、folding/clock/scope/relay 的旁路、消融矩阵设计。
- `wiring.md`：fork-wiring 的影子前台、spawnChildTicket/attachStation 迁移设计。

## 验收

`bun test tests` 全绿；`bunx eslint .` 全绿；smoke 与手工场景通过；每个端口在矩阵中有一行；每个 Station 事件入口满足 Compute→Commit→Dispatch；fire-and-forget 全部有 catch-all。
