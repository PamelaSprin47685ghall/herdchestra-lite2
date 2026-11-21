# 架构：端口、实现与接线

本文只写结构、边界与契约。方法论与取舍在 `PLAN.md`，验收命令在
`docs/acceptance/refactor-plan.md`。文中出现的类型与默认值都以已提交的
`src/core/ports/registry.mjs`、`src/core/ports/resolve.mjs` 为准。

## 1. 模块布局

```
src/core/ports/
  registry.mjs      # 纯数据：PORTS、switchName、NAMED_SWITCHES、PORT_NAMES
  resolve.mjs       # 纯函数：readSwitch(port, env)、resolvePorts(uses, env)
  index.mjs         # 仅重导出上面两个文件

src/features/<port>/
  index.mjs         # 该端口的实现表：{ name -> implementation }
  <impl>.mjs        # 每个实现一个文件，互相不 import
  contract.md       # 该端口的方法、错误码、默认实现（可选，若与本文重复则省）

src/activation/     # 组合根：解析 uses，取实现，交给宿主
tests/contract/     # 每端口一个契约测试，用 _harness.mjs 跑遍所有实现
tests/bill-split/   # 六对分账的方向断言
```

约束：

- `src/core/ports/` 不 import 任何 `src/features/**`，也不 import 宿主。
- `src/features/<A>/**` 不 import `src/features/<B>/**`，也不 import `src/activation/**`。
- 只有 `src/activation/**` 同时看见端口表、实现表与宿主。

## 2. 依赖 DAG

```
        host (omp)                core/ports (pure data)
             ▲                          ▲
             │                          │ 读表与解析
        activation ─────────────────────┘
          │      │
          │      └──────────────► features/<port>/<impl>   （互不 import）
          │                                  │
          └──────── 运行时调用 ──────────────┘
```

- 方向单一：`activation → features`，`activation → core/ports`。
- `features` 之间没有边。任一 feature 需要另一端口的能力时，拿到的是**实现对象**，
  不是另一个 feature 的模块；这由组合根在装配时注入。
- `core/ports` 是叶子：只有数据与纯函数，没有副作用，因此可被任何一层引用。

## 3. 端口契约

每个端口是一组同步方法，返回判别联合：

```js
{ ok: true, ...payload } | { ok: false, code: "…", port: "…", detail?: string }
```

共同规则：

1. **同步。** 端口方法不返回 Promise。需要 I/O 的编排属于工单，不属于端口。
2. **不抛异常作为控制流。** 拒绝是返回值，带 `code` 与 `port`。
3. **实现同形。** 同一端口的所有实现，方法名、参数、返回形状完全一致。
4. **不读全局开关。** 实现不知道自己的开关状态；它只知道自己被选用了。

各端口：

| 端口 | 方法（最小集） | 实现 | 默认 |
| :--- | :--- | :--- | :--- |
| `scope` | `begin(spec)` `end(id)` `charge(id, amount)` `snapshot()` | `bare` `single` `batch` | `batch` |
| `relay` | `record(ledger)` `status()` `advance()` | `none` `ledger` `handoff` | `handoff` |
| `clock` | `start(scopeId, ms)` `remaining(scopeId, now)` `expired(scopeId, now)` | `on` `off` | `on` |
| `commonRules` | 无运行时方法：只决定 repo-aware 规则块是否进入 managed block | `on` `off` | `on` |
| `chineseReminder` | 无运行时方法：只剥离 persistent rules 里的简体中文提醒行 | `on` `off` | `on` |
| `vibeCompat` | `rewriteVibeMessage(message, options)` 读开关；`off` 时不改写 vibe 文案 | `on` `off` | `on` |
| `stages` | `open(scopeId, stage)` `allows(stage)` `snapshot()` | `on` `off` | `on` |
| `herd` | `mode()` `toggle(text)` | `on` `off` | `on` |
| `pin` | `add(note)` `list()` | `on` `off` | `on` |
| `amend` | `record(beatKey)` `refund(beatKey)` `retired()` | `on` `off` | `on` |
| `folding` | `note(context)` `fold()` `kept()` | `on` `off` | `on` |
| `modelSwitch` | `choose(spec)` `current()` | `on` `off` | `on` |
| `status` | `render(snapshot)` | `on` `off` | `on` |
| `observer` | `observe(frame)` `report()` | `on` `off` | `on` |

`off` 的形态按 PLAN §四：空对象、统一拒绝、或一条直路。三者的区别写在该端口的
契约测试里，不写在这张表里，因为它们是行为，不是签名。

## 4. 失败隔离

- **解析失败是启动期的。** `resolvePorts` 返回 `PORT_UNAVAILABLE` 时，接线层不装配任何
  端口；不存在“一半装上”的中间态。
- **调用失败是局部的。** 一个端口返回拒绝，其他端口的状态不变；没有任何端口在拒绝路径
  里写第二个端口。
- **实现内部异常不跨端口。** 组合根在调用点捕获并记入诊断环，返回该端口的拒绝形状；
  上层看到的是拒绝，不是异常栈。

## 5. 与验收的映射

| 架构约束 | 由哪条验收覆盖 |
| :--- | :--- |
| 实现同形、可互换 | G1 契约逐实现；S1–S8 各自的契约测试 |
| 默认等于今天 | G2 缺省环境跑全量 |
| 选择器不被静默推翻 | G3 `HERD_DISABLE_CLOCK` + `uses` 冲突 |
| feature 之间零 import | S1–S8 的 `grep features\.on\|HERD_DISABLE` 检查 |
| 组合根是唯一决策点 | I1 的 grep：`src/station`、`src/activation` 不再判断开关 |
| 分账方向 | `tests/bill-split/six-pairs.test.mjs` 六条 |

## 6. 已知的边界模糊处

1. **`scope` 与 `clock`**：截止时间存在哪个端口？本文的答案是 `clock` 拥有算术与判定，
   `scope` 只发布 `scopeId` 与调用起点（分账表第二行）。若实现时发现 `scope` 需要读取
   剩余时间做记账，那就是 `clock` 的新方法，不是把 deadline 塞回 scope 记录。
2. **`stages` 与 `herd`**：`stages` 判断准入，`herd` 只发布模式。若 `stages` 需要读
   `herd` 的第二步事实，说明分账错了，先改表再改代码。
3. **`fission` 到底是不是端口**：不是。它是 `scope` 的 `batch` 实现。任何 `fission` 端口
   提案都要先回答“为什么它不能是 scope 的一个实现”。

以上三处若在实施中变化，先改本文与分账表，再改代码——顺序反了就会重演上一版。
