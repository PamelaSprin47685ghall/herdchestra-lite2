# 架构重构计划（修订版）

| Field | Value |
| :--- | :--- |
| 起点 | `b33e76c` |
| 上一版 | 16 站台 Ticket Station 重构，执行到 `99414ac` 后整体废弃 |
| 本文修订 | v1 开关=功能消失；v2 开关=两版实现；v3 工单选实现；v4 开关词汇与环境变量同源 |
| 现状 | 分支 `feat/concurrent-fission` 回到 `b33e76c` 之上，只保留可独立成立的行为修复与提示词改进 |

上一版计划的原文（完整诊断、16 站台划分、五条机制、五步迁移）仍可从
`git show b33e76c:PLAN.md` 取回。本文只保留仍然有效的工作台清单。

---

## 一、根本前提：开关选的是实现，不是“在不在”

这一点错了，后面全错。v1 把开关理解为“关掉则站台不存在”，于是每个调用点都要问
“它在不在”，于是到处出现 `stations.fission?.begin(...)`、`if (features.on("timer"))`，
于是提示词、Schema、回执、门禁各自按开关再判断一遍。

正确的形状是：

> 每个工作台只有一个端口（一组同步方法）。端口下有若干**等位实现**，
> 由开单方选定，组合根负责解析。此后没有任何领域代码再问“开关是什么”。

1. **端口唯一。** `scope` 对外就是 `begin / end / charge / snapshot`，
   各实现的签名、返回值判别联合、错误码完全一致。
2. **关闭态是一版实现，不是缺席。** 它可以是空对象，也可以是一条更简单的直路。
   对象一定在，调用一定通。
3. **选择有明确的持有者。** 选择以数据形式写在工单的 `ports` 里（见 §二）。
4. **提示词与 Schema 是实现的产物。** 每个实现自带片段，组合根取所选那版拼装。

### 例子：`scope` 的两版实现（两版今天都已存在）

| | `batch` | `single` |
| :--- | :--- | :--- |
| 开启方式 | 注册批次、扇出流、执行屏障 | 在当前会话原地压栈 |
| 输入 | 广播到各流 | 交给本会话 |
| 收尾 | 退场、收养、dispose 屏障 | 直接关闭 |
| 端口 | `begin / end / charge / snapshot` | 同样四个方法 |

`src/scope/accounting.mjs` 本来就保留了 `beginScope` / `closeScope` 的单流能力。
重构要做的是给这条直路一个名字（`single`），把两版边界划清。

---

## 二、工单附带选择等位工作台

工单是唯一允许跨工作台编排的地方，也是唯一能回答“这件事需要哪一版”的地方。

```js
export const scopeBeginTicket = {
  ports: { scope: "single" },   // 端口名 -> 实现名；未列出的取默认实现
  run: async ({ ports, ctx, args }) => {
    const plan = planScopeBegin(args);        // 纯领域决策
    if (!plan.ok) return refusal(plan);
    return ports.scope.begin(plan.scopeSpec); // 已是具体实现，无分支
  },
};
```

- **`ports` 是数据，不是判断。** 工单里不出现 `features.on(...)`。
- **缺省是端口的默认实现**，绝大多数工单不必写这一行。
- **同一份工单在两版实现下都能跑**——契约测试参数化到实现，这就是“等位”的定义。

解析发生在**工单构造期**，早于任何 `await`，所以选错不会变成半个批次：

```js
{ code: "PORT_UNAVAILABLE", port: "scope", wanted: "single", available: ["batch"] }
```

三种拒绝，都必须在开单前给出：端口名不存在、该端口未注册这个实现名、该实现被当前配置禁用。
静态工单在启动期报错；模型触发的工具路径在开单前校验，失败即返回错误码，不进入状态变更。

---

## 三、开关词汇表与环境变量

开关不是布尔，也不是每个功能一套私有名词。它是一条**环境变量选一个实现名**，
而实现名来自一张很小的、彼此正交的词汇表。同一个词在任何端口上只允许一种含义。

### 3.1 词汇表（全部六个词）

| 词 | 唯一含义 | 不变量 |
| :--- | :--- | :--- |
| `full` | 该端口的完整实现 | 内部状态与输出都齐全 |
| `none` | 不产生任何效果 | 无状态、无输出；调用返回“无”，永不拒绝 |
| `refuse` | 拒绝调用 | 返回统一错误码，**不改变任何状态** |
| `single` | 一次处理一个 | 顺序、无并发、无屏障 |
| `batch` | 一次处理多个 | 并发、有批次与屏障 |
| `fixed` | 取固定值 | 不接受切换，读取恒定 |

正交的含义：`none` 与 `refuse` 的区别是“静默返回”与“明确拒绝”；
`single` 与 `batch` 的区别只是并发度，不是功能有无；
`full` 是“该端口应有的一切”，不引入别的语义。

**禁止同义词。** 不再有 `off` / `disabled` / `silent` / `open` 等变体——
同一个意思永远用同一个词。

### 3.2 环境变量

每个端口一个变量：`HERD_<PORT>`，值是实现名。默认值等于今天的行为。

| 端口 | 环境变量 | 允许值 | 默认 |
| :--- | :--- | :--- | :--- |
| `scope` | `HERD_SCOPE` | `batch` \| `single` | `batch` |
| `fission` | `HERD_FISSION` | `batch` \| `single` | `batch` |
| `timer` | `HERD_TIMER` | `full` \| `none` | `full` |
| `defer` | `HERD_DEFER` | `full` \| `refuse` | `full` |
| `amend` | `HERD_AMEND` | `full` \| `refuse` | `full` |
| `folding` | `HERD_FOLDING` | `full` \| `none` | `full` |
| `modelSwitch` | `HERD_MODEL_SWITCH` | `full` \| `fixed` | `full` |
| `stages` | `HERD_STAGES` | `full` \| `none` | `full` |
| `herd` | `HERD_HERD` | `full` \| `none` | `full` |
| `relay` | `HERD_RELAY` | `full` \| `none` | `full` |
| `pin` | `HERD_PIN` | `full` \| `refuse` | `full` |
| `status` | `HERD_STATUS` | `full` \| `none` | `full` |
| `observer` | `HERD_OBSERVER` | `full` \| `none` | `full` |
| `commonRules` | `HERD_COMMON_RULES` | `full` \| `none` | `full` |
| `chineseReminder` | `HERD_CHINESE_REMINDER` | `full` \| `none` | `full` |
| `vibeCompat` | `HERD_VIBE_COMPAT` | `full` \| `none` | `full` |

`HERD_DISABLE_*` 不再存在：布尔开关无法表达“选哪一版”，只能表达“有没有”。

### 3.3 校验取代级联

v1 之所以需要 `requires` 与级联关闭，是因为“关掉”被理解成“消失”，
于是一个功能关掉会连带关掉依赖它的功能。现在没有消失，也就没有级联。

剩下的只是**矛盾组合**，启动期直接拒绝，不猜：

| 矛盾 | 原因 |
| :--- | :--- |
| `HERD_SCOPE=single` + `HERD_FISSION=batch` | 批次形态必须有批次作用域 |
| `HERD_SCOPE=batch` + `HERD_FISSION=single` | 批次作用域没有可用的流调度 |
| `HERD_TIMER=full` + `HERD_SCOPE=single` | 单流路径没有墙钟语义（若要保留，需先定义） |
| `HERD_STAGES=full` + `HERD_HERD=none` | decision-framing 无法开启，阶段表不完整 |

报错形如：

```
HERD_SCOPE=single conflicts with HERD_FISSION=batch: the batch path needs a batch scope.
```

`/herd-ports` 打印每个端口的「当前实现 / 可选值 / 默认值 / 由哪个变量指定」，
替代原来解释级联原因的 `/herd-features`。

---

## 四、经验教训

每条都来自这次重构的可核对事实。

### 1. 一个提交只能有一个理由

`a582ece` 一次改 169 个文件（+14658/−1196），混着至少两处与结构无关的真修复：
未提交死帧阻塞后续输入、owner 退休与可恢复模型错误。整条链被废弃时，它们差点一起消失。

**做法**：`refactor:` 提交只搬移与改名；行为变化另开 `fix:` 并带复现测试。

### 2. 重构必须行为中性，用同一批测试证明

原提交信息写的是 “complete 16-station architecture, ablation switches, and
fission/error fixes”。于是没人能回答：测试变绿，是因为结构对了，还是因为顺手修了别的。

**做法**：重构前后跑同一批用例，全绿、数量不变。新增测试只有契约测试。

### 3. 搬家窗口要短，脏树是不可回退的债

失败现场是 171 个文件未提交（+3098/−11711），既不能提交也退不回去，只剩整体 stash。

**做法**：任何时刻工作区不超过一个可提交单元；搬一个文件、改完引用、跑测试、提交。

### 4. 拒绝态必须有清理路径

批次结束后 station 仍留 `ownerRetired`，此后本会话所有功能性工具都被拒，只能重启。

**做法**：门禁状态与它描述的对象同生共死；`before_agent_start` 与 `session_stop`
两条入口都要覆盖，并有测试。

### 5. 同一事实只有一处来源

门禁只要三个阶段，四处文案却写“五个阶段”。而这次连开关本身都有三套说法：
布尔环境变量、站台字段、提示词里的删段逻辑。

**做法**：条件只有一处；措辞由它推导；测试钉住那句话。开关的“那处”就是端口词汇表。

### 6. 最难的路径先在一个工作台上跑通

独立持久化、flow 级 fork、继承者 adopt——原本留到 169 个文件的最后才真正跑到。

**做法**：第一个工作台就选同时踩到 fork 与 persist 的那条。

### 7. 并发按写入集切分

四路并发、写入集两两不相交：三路干净落地；断流那一路也没污染别人。

**做法**：先列每个切片的写入集，再按冲突矩阵分批；单切片批次写明重叠符号或上游依赖。

### 8. 每一步都要能停

v1 的 Step 1 一改就是 169 个文件，于是“停在第 1 步”与“全部推倒”没有区别。

**做法**：每步结束时分支可构建、全量绿、工作区干净、能力与起点等价。

---

## 五、反模式清单

见到下列任何一种，就是接线决策漏进了领域层：

- `stations.fission?.begin(...)` —— 可选链等于“可能不存在”。
- 领域模块或工单里 `if (features.on("timer"))` / `if (config.fissionEnabled)`。
- 布尔开关：`HERD_DISABLE_FISSION=1`、`scope: false`、`enabled: true`。
- 给同一个含义造第二个词（`off` / `silent` / `open` / `disabled`）。
- 工单在拿不到所选实现时静默回退到另一版。
- 同一道门在 `batch` 与 `single` 各写一遍（门禁表、守卫、等待节奏）。
- 关掉功能时把对象置 `null`，让上层自己判空。
- 提示词、Schema、回执各自按开关删段，而不是由实现自带片段。
- 为关闭态另造错误码与回执文案，导致两种状态对用户可见地不同。

---

## 六、分步计划

### Step 0：端口、词汇与选择器先行（不改结构）

- 记录基线：`bun test tests`（当前 891 个用例、64 个文件、0 失败）。
- 落地端口表：端口名、允许的实现名（只能来自六词表）、默认实现。
- 落地 `HERD_<PORT>` 解析、矛盾组合校验、`PORT_UNAVAILABLE` 与 `/herd-ports`。
- 契约测试参数化到实现；先在现状上跑，跑不通处即两版已分叉处，记下来。

**完成标准**：词汇表、端口表、解析与三类报错都有测试。
**回退点**：纯新增，随时可停。

### Step 1：`scope` 一个工作台，两版实现归位

- 端口 `begin / end / charge / snapshot`；实现 `batch` 与 `single`。
- 抽出 `batch`（批次注册 + 屏障 + 广播 + 退场/收养）与 `single`（原地压栈 + 单流回执）。
- `scope-begin` 工单声明 `ports`；调用点删掉所有空值判断。

**完成标准**：两版跑同一套契约测试；`single` 下不安装 UI/输入/dispose 桥；
`batch` 行为与今天一致；矛盾组合有测试。
**回退点**：实现 A/B 各一个提交序列。

### Step 2：其余工作台逐个归位（pin → timer → amend → defer → modelSwitch → stages → folding → herd → relay）

每个工作台四拍，一次只做一个：

1. 写端口与契约测试（参数化到实现，先跑现状）；
2. 把现有逻辑归入 `full`，并给出第二个实现（`none` / `refuse` / `fixed`，只能取自六词表）；
3. 工单声明 `ports`，组合根接线，删掉调用点的可选链与开关判断；
4. 删除双写与旧字段。

**完成标准**：两版都过同一套契约测试；领域代码中不再出现开关判断。
**顺序理由**：`pin` 最独立，先验证四拍；`relay` 与 `stages` 用户可见行为最多，放后；
`folding` 与 `modelSwitch` 共享定价，相邻做。

### Step 3：提示词与 Schema 随实现切片

- 每个实现自带片段；组合根按所选实现拼装并冻结。
- **切片只搬运，不改措辞**；要改措辞另开 `docs(prompts)` 提交。
- 测试保证：选了哪版，提示词里只出现那版的词。

### Step 4：装配收口

- 组合根是唯一解析点；`features` 对象不再向下传递。
- 用 ESLint 或等价检查钉住反模式：领域目录禁止 `features.on`、禁止对 `stations.*` 用可选链、
  `ports` 的值必须来自六词表、禁止 `HERD_DISABLE_*`。

---

## 七、工作台清单（打勾 = 两版已归位、有契约测试、工单可声明实现名）

| 层 | 工作台 | 端口职责 | 实现名 | 默认 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | status | 用量/花费/前缀挂件 | `full` / `none` | `full` | 未开始 |
| 0 | observer | 请求帧观测与漂移分类 | `full` / `none` | `full` | 未开始 |
| 0 | commonRules | 工程与沟通规范片段 | `full` / `none` | `full` | 未开始 |
| 0 | chineseReminder | 简体中文提醒 | `full` / `none` | `full` | 未开始 |
| 0 | vibeCompat | vibe 文案改写与工具保留 | `full` / `none` | `full` | 未开始 |
| 0 | pin | 会话级备忘录 | `full` / `refuse` | `full` | 未开始 |
| 0 | herd | herdMode、ask 门禁 | `full` / `none` | `full` | 未开始 |
| 0 | relay | 账本、晋升、自交接 | `full` / `none` | `full` | 未开始 |
| 1 | scope | 嵌套栈、预算、屏障 | `batch` / `single` | `batch` | 未开始 |
| 2 | timer | 每 scope 墙钟 | `full` / `none` | `full` | 未开始 |
| 2 | defer | 待办与残余 | `full` / `refuse` | `full` | 未开始 |
| 2 | amend | 拍子回退与退还 | `full` / `refuse` | `full` | 未开始 |
| 2 | folding | 热工作台与折叠 | `full` / `none` | `full` | 未开始 |
| 2 | modelSwitch | 每 scope 模型选择 | `full` / `fixed` | `full` | 未开始 |
| 2 | stages | 阶段与标志 | `full` / `none` | `full` | 未开始 |
| 2 | fission | 批次、流、抄写、收养 | `batch` / `single` | `batch` | 未开始 |

---

## 八、已知风险与未决问题

1. **fork/adopt 的原型继承**：现状用 `Object.create(owner)` 与 getter/setter 代理共享
   Session 级状态，`previousObservation` 就因此读到过 owner 的槽位。两版实现必须显式
   声明“共享实例 / 派生实例”的边界。
2. **两版实现会分叉**：唯一护栏是同一套契约测试，以及“同一工单在两版下都跑”。
3. **词汇表会膨胀**：新增一个词就等于新增一种语义，必须先证明现有六词表达不了。
   每加一个词，六个端口都要重新检查一遍是否仍正交。
4. **选择器滥用**：工单能选实现，不等于任何调用点都能选。默认那版，确有理由才声明。
5. **持久化的双写期**：旧快照恢复必须有一次可验证的迁移测试。
6. **判定顺序是语义**：`blockExternalFailure` 与可恢复错误的先后，决定了 429 正文里
   出现 tool_choice 时的行为。两版实现里这类顺序必须一致，且有测试。
7. **未决**：`timer=none` 与 `scope=single` 是否应允许（单流是否需要墙钟）。
   当前列为矛盾；若允许，需要先定义单流墙钟语义。

---

## 九、修订记录

- v1：按“每个站台可独立缺席”分步抽离。
- v2：前提改为“开关 = 同一端口的两版实现，接线选择”。
- v3：工单用 `ports` 声明实现名，组合根解析，`PORT_UNAVAILABLE` 在开单前拒绝。
- v4：环境变量同源——`HERD_<PORT>=实现名`，六个正交词；删除 `HERD_DISABLE_*`
  与依赖级联，改为启动期矛盾校验与 `/herd-ports`。
