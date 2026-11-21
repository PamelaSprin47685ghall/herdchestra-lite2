# 验收用例集：重构计划实施

本文件是 PLAN v8 的可执行验收面。每一条都能被一个人按顺序跑一遍，看命令输出判断对错。
重构的验收标准是**行为等价 + 结构到位**，不是“看起来改了”。

## 0. 共用约定

- 工作目录：仓库根。
- 基线数字：`bun test tests` 917 用例 / 67 文件 / 0 失败（批次 A 结束时）。
- 任何一个切片合并前，`git status --short` 必须为空；合并后必须重跑全量。
- 评分口径（每条用例通用，0–100）：
  - 100：命令与预期完全一致，且全量绿。
  - 80：命令通过，但留下一条注释或文档偏差（可修）。
  - 60：命令通过，但残留符号被 grep 到（不算完成）。
  - 0：全量红，或工作区不干净。
  - **硬失败**：全量红、`git status` 有未提交改动、或为让测试变绿而改断言。

## 1. 三张全局验收（每个端口切片都要过）

### G1 契约对每个实现都跑

```bash
bun test tests/contract 2>&1 | tail -5
```

预期：每个端口的 `describe("implementation: …")` 数量等于该端口实现数；
某实现失败时消息形如 `[scope/bare] 某个用例: …`。

硬失败：只跑了一个实现、或失败消息里没有实现名。

### G2 不设环境变量时行为与今天一致

```bash
env -u HERD_SCOPE -u HERD_RELAY bun test tests 2>&1 | tail -3
```

预期：全绿；`HERD_SCOPE` 缺省为 `batch`、`HERD_RELAY` 缺省为 `handoff`，
其余端口缺省 `on`（可用 `bun -e` 直接读 `resolvePorts({})` 核对）。

硬失败：缺省值与 PLAN §四 表格不一致。

### G3 禁用的实现不能被工单重新打开

```js
// bun -e
import { resolvePorts } from "./src/core/ports/resolve.mjs";
console.log(resolvePorts({ clock: "on" }, { HERD_DISABLE_CLOCK: "1" }));
```

预期：`{ ok: false, code: "PORT_UNAVAILABLE", port: "clock", wanted: "on", available: ["off"] }`。

硬失败：返回 `ok: true`（说明选择器只是装饰）。

## 2. 清理切片

### E0a 工具面

```bash
grep -n 'defer' src/activation/tools.mjs src/tools/index.mjs src/tools/descriptions.mjs src/tools/tickets.mjs
grep -n 'defer' resources/prompts/*.md resources/prompts/*/*.md
```

预期：第一条无输出；第二条只剩历史说明（若有，须写明“已删除”）。

硬失败：仍注册了 `defer` 工具，或提示词里仍在教模型调用它。

### E0b 状态与逻辑

```bash
grep -rn 'defers\|residualDefers\|deferTicket\|deferIntent' src
```

预期：无输出（注释除外）。

硬失败：旧快照恢复时仍有字段被读写，或 `bun test tests` 因缺符号而红。

### E0c 测试清理

```bash
grep -rn 'defer' tests | wc -l
bun test tests 2>&1 | tail -3
```

预期：grep 只剩注释（应为 0 或个位数注释行）；全量绿。

硬失败：为了让测试变绿而删除了与 defer 无关的断言。

## 3. 契约与骨架切片（已完成，保留作回归）

### E1 端口表与解析器

```bash
bun test tests/ports-resolve.test.mjs 2>&1 | tail -3
```

预期：14 用例全绿；`PORT_NAMES` 长度 11；`scope`/`relay` 各有三值。

### E2 契约脚手架

```bash
bun test tests/contract/harness.test.mjs 2>&1 | tail -3
```

预期：5 用例全绿；`runCase` 的失败消息精确等于 `[probe/beta] breaks: deliberate`。

### E3 分账方向

```bash
bun test tests/bill-split 2>&1 | tail -3
```

预期：7 用例全绿；每个用例的发布方状态在判断后与之前深相等。

## 4. 端口切片（S1–S8）

每个端口照同一张表验收，`P` 换成端口名，`IMPLS` 换成 PLAN §四 的实现名。

| 检查 | 命令 | 预期 |
| :--- | :--- | :--- |
| 契约覆盖 | `bun test tests/contract/P.test.mjs` | 每个实现各一组用例，全绿 |
| 关闭态形态 | 见 PLAN §四 的“`off` 形态”列 | 空对象 / 拒绝 / 直路，与表一致 |
| 领域无开关判断 | `grep -rn 'features\.on\|HERD_DISABLE' src/features/P` | 无输出 |
| 回执一致 | 跑一次该端口的最小场景 | 回执里只出现所选实现的措辞 |

### 各切片的额外一条

- **S1 `scope/bare`**：`bun -e` 调 `ports.scope.begin(...)` 返回 `PORT_UNAVAILABLE` 或统一拒绝码；
  且不安装 UI/输入/dispose 桥（`grep -n 'installFissionUI' src/activation` 只在一处，且受该实现控制）。
- **S2 `clock`**：`clock=off` 时回执无 `time` 段（跑一个 scope 看回执文本）。
- **S3 `relay`**：`none` 时不要求账本；`ledger` 时非空账本禁止静默停止；`handoff` 时才有交接回执。
- **S4 `pin`/`amend`**：`off` 为统一拒绝码；`on` 时工具存在且状态跨折叠存活。
- **S5 `status`/`observer`**：两者可分别关闭；关一个不影响另一个的输出。
- **S6 `stages`/`herd`**：`herd=off` 时 `stages` 不允许 decision-framing（读事实，不反向写）。
- **S7 `folding`/`modelSwitch`**：折叠不复活被撤拍子（用 amend 的台账断言）。
- **S8 `scope/single` 与 `scope/batch` 归位**：三版同一套契约；
  `batch` 下现有 fission 行为与今天逐条一致（全量绿即证据）。

## 5. 集成切片

### I1 接线与 `uses`

```bash
grep -rn 'features\.on\|HERD_DISABLE' src/station src/activation | grep -v 'core/ports'
```

预期：无输出（接线层只读 `resolvePorts` 的结果，不再自己判断开关）。

### I2 提示词切片

```bash
grep -rn 'HERD_DISABLE\|features\.on' resources/prompts
```

预期：无输出（提示词由实现自带片段，不在文本里判断开关）；
再跑一次 `bun test tests/prompts.test.mjs`，全绿。

## 6. 收尾

```bash
bun test tests 2>&1 | tail -3
git status --short
git log --oneline -12
```

预期：全绿、状态干净、每个切片一个提交，提交信息能独立解释理由。

硬失败：把多个切片的改动塞进一个提交。
