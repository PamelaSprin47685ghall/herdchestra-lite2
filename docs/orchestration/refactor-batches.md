# 编排：批次、写入集与集成

本文件把 ledger 的 15 项变成可同时开工的批次。方法与验收见
`PLAN.md`、`docs/architecture/refactor-ports.md`、`docs/acceptance/refactor-plan.md`。

## 1. 切片表

写集是**互斥判据**：两切片只要有一个文件相同，就不能同批。

| ID | 切片 | 写集 | 读集 | 交付（合并后可假定） | 停下条件 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `A1` | E0a 工具面 | `src/activation/tools.mjs`、`src/tools/{index,descriptions,tickets}.mjs`、`resources/prompts/**`（defer 段）、`tests/prompts.test.mjs` | — | `defer` 工具不存在，提示词不再提及 | 提示词里还有 defer 调用示例 |
| `A2` | E0b 状态与逻辑 | `src/scope/{state,accounting,persistence}.mjs`、`src/station/{controls,texts,station,gates,execute,messages,dispatch-tracker}.mjs` | `A1` 的删除结果（不必须，但需同一批合并） | 状态里无 `defers`，close 路径无 steer | 旧快照恢复时仍读 defers |
| `A3` | E0c 测试清理 | `tests/**`（除 `tests/prompts.test.mjs`） | `A1`+`A2` 已合并 | 全量绿，无 defer 断言 | 为变绿而删了无关断言 |
| `B1` | S1 `scope` 契约 + `bare` | `src/features/scope/**`、`tests/contract/scope.test.mjs` | `registry.mjs`、`_harness.mjs` | `bare` 通过契约，调用被拒且无副作用 | 需要改动 `resolve.mjs` |
| `B2` | S2 `clock` 两版 | `src/features/clock/**`、`tests/contract/clock.test.mjs` | 同上 | 两版同契约；`off` 无 time 段 | 需要 `scope` 改签名 |
| `B3` | S3 `relay` 三档 | `src/features/relay/**`、`tests/contract/relay.test.mjs` | 同上 | 三档同契约、递进可辨 | 需要写 `stages` 状态 |
| `B4` | S4 `pin`/`amend` | `src/features/pin/**`、`src/features/amend/**`、`tests/contract/pin.test.mjs`、`tests/contract/amend.test.mjs` | 同上 | 两端口各两版；`off` 统一拒绝 | 需要在 `off` 时静默成功 |
| `B5` | S5 `status`/`observer` | `src/features/status/**`、`src/features/observer/**`、两个契约测试 | 同上 | 两端口可分别关闭 | 合并后无法只开其一 |
| `B6` | S6 `stages`/`herd` | `src/features/stages/**`、`src/features/herd/**`、两个契约测试 | 同上 + 分账表第 4/5 行 | `herd` 只发布模式，`stages` 判断准入 | `stages` 反向写 `herd` |
| `B7` | S7 `folding`/`modelSwitch` | `src/features/folding/**`、`src/features/model-switch/**`、两个契约测试 | `amend` 契约 | 折叠不复活被撤拍子 | 需要改 `amend` 的台账 |
| `B8` | S8 `scope/single`+`batch` 归位 | `src/scope/**`、`src/activation/fission.mjs` | `B1` 的契约 | 三版同契约；`batch` 行为与今天一致 | 全量出现新红 |
| `C1` | I1 接线与 `uses` | `src/activation/index.mjs`、`src/station/registry.mjs` | 全部契约 | 组合根是唯一决策点 | 领域码仍判断开关 |
| `C2` | I2 提示词切片 | `resources/prompts/**`（非 defer 段） | 各实现自带的片段 | 选哪版只出现哪版措辞 | 改动了措辞本身 |
| `D1` | 全量验证 | — | 全部 | 全绿、状态干净、一提交一切片 | 有未提交改动 |
| `D2` | 逐条跑验收 | — | `docs/acceptance/refactor-plan.md` | 偏差记录在案 | 有硬失败项 |

## 2. 冲突矩阵

`×` 必须排序；`·` 可同批。

| | A1 | A2 | A3 | B1–B7 | B8 | C1 | C2 |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| A1 | · | · | · | · | · | · | × |
| A2 | · | · | · | · | · | · | · |
| A3 | · | · | · | · | · | · | · |
| B1–B7 | · | · | · | · | × | × | · |
| B8 | · | · | · | × | · | × | · |
| C1 | · | · | × | × | × | · | · |
| C2 | × | · | · | · | · | · | · |

真依赖四条：`A1 → C2`（同写 prompts）、`A1 → A3`（测试要删被删掉的东西）、
`B1 → B8`（同写 `src/scope/`）、`B* → C1`（接线要读实现）。

## 3. 批次

- **批次 1**：`A1`、`A2`、`B1`–`B7` —— 九个切片同时开工。
  `A2` 与 `A1` 写集不交（`src/scope`/`src/station` vs `src/tools`/prompts），可同批。
- **批次 2**：`A3`、`B8`、`C2` —— 三个切片。
  `A3` 要 `A1` 已合并；`B8` 要 `B1`；`C2` 要 `A1`。
- **批次 3**：`C1` —— 单切片，理由：它要同时读全部实现，且写集与三者都交；
  这是本计划唯一一处有记录的串行。
- **批次 4**：`D1`、`D2` —— 验证与逐条验收，由集成者完成。

## 4. 安全与活锁不变量

**安全（每批合并后必须成立）**

1. `bun test tests` 全绿。
2. `git status --short` 为空。
3. 任一端口的所有实现通过同一套契约（G1）。
4. 缺省环境下行为与今天一致（G2）。
5. 没有两个切片修改同一文件后各自提交。

**活锁（进度保证）**

1. 一个切片失败时，只回退该切片；兄弟切片继续。
2. 被回退的切片不阻塞依赖它的切片**直到**下一批；批次 3/4 例外，必须等。
3. 任何切片超过两次回退，停下来改设计（分账表或端口契约），不在代码里绕。
4. 集成者不做实现，只合并与解冲突；冲突由写集作者修。

## 5. 关键路径

```
A1 ──► C2
A1 ──► A3
B1 ──► B8 ──► C1
B1…B7 ─────► C1
```

串行部分只有三跳：`A1→A3`、`B1→B8`、`B` 批→`C1`。
缩短它的做法：

- `C2` 与 `A3` 都在批次 2，互不阻塞。
- `B8` 不必等 `B2`–`B7`，只等 `B1`；其余端口与它并行。
- `C1` 必须最后，因为它是唯一同时读全部实现的切片；不要为了“早点接线”把它拆开，
  拆开会产生两个决策点。

## 6. 每个切片的开工契约

开工前写清四行，缺一不开：写集、读集（含依赖的提交号）、交付、停下条件。
写集变更即视为新切片，重新走冲突矩阵。
