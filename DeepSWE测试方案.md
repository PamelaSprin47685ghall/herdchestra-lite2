这次只有 **3 个两态变量**（$2 \times 2 \times 2 = 8$ 种全部组合），**直接上完整 $2^3$ 全析因设计（8 组）**是最优解：
* **比上批 9.0.0 更便宜**（上批跑了 12 组 672 题次、花 $364.64；这批完整全析因只要 **8 组 448 题次**，预计 ~$240–$275）；
* **零混叠**：不仅把 `scope`、`chinese`、`workspace` 三个主效应的样本量拉到 **224 对 224**（比上批 L9 的 168 更大、区间更窄），还能直接测出全部 **3 个双因子交互项**（顺便彻底解开上批 F0 比 L9 预测高出 7.1 个百分点的悬案）；
* **不需要额外补确认轮**：8 组覆盖了全部角落，胜出组合直接就是实测分，没有筛选偏差。

下面是一份可直接冻结执行的 **`10.3.0` DeepSWE 测试方案**。

---

# Herdchestra 10.3.0 DeepSWE 测试方案（$2^3$ 全析因）

## 一、目的与锁定条件

### 1. 本轮锁定（沿用 9.0.0 L9 已确认结论）
* `HERD_TESTING=off`
* `HERD_CONSTITUTION=full`
* `HERD_FRAMING=off`
* 启动首条消息统一使用 `/herd-goal <任务指令>`（进入 `ROOT_AUTOPILOT` 目标模式，无持久 autopilot 开关）

### 2. 本轮考察的 3 个两态变量
| 变量 | 环境变量 | 档位 `-1` | 档位 `+1` | 代码侧实质差异（10.3.0） |
|---|---|---|---|---|
| **S (`scope`)** | `HERD_SCOPE` | `adaptive` | `hard` | `adaptive` 仅 4 句按耦合拆包 + 明确提醒把路径/签名/报错写入 `dafny`；`hard` 注入正交拆分 + `at least sqrt(n)` + CPS 交棒不回传事实 + **`state.scopes_summary` 空闲人手催促**（仅 `scope=hard` 触发） |
| **C (`chinese`)** | `HERD_CHINESE` | `off` | `on` | 是否在 system prompt 与每轮 REPL probe 尾部强压简体中文思考与回答 |
| **W (`workspace`)** | `HERD_WORKSPACE` | `off` | `personal` | 是否注入非 CS 硕士详述、费孝通/迪拉德文风、`<95%` 规则（goal 模式下取默认并记残差）、`Obey AGENTS.md` 以及 `.agent/skills/` 设计与手工验收记录（**明确不测 `full` 元技能**） |

> **版本漂移提醒（9.0.0 → 10.3.0）**：`10.0.0` 移除了 `scope_fork` / `scope_abandon` 结果里的请求回显，`10.3.0` 新增了 `coerceComplex` 容错解析并把默认 `scope` 改成了 `hard`。因此 **8 组全部必须显式传齐 6 个 `HERD_*` 环境变量**，且组内结论严格只在 `10.3.0` 同提交内对比。

---

## 二、固定控制与运行纪律（修复上批 2 个流程卡点）

| 控制项 | 规定 |
|---|---|
| 代码版本 | 锁定 `10.3.0` 同一 git commit（冻结进 `manifest.json`）；跑前先过 `bun run lint`、`bun test tests`、`bun run smoke:relay` |
| 宿主与模型 | 严格沿用上批同一 `omp 19.2.1`、同一 `openai-codex/gpt-6.1-terra`（`medium`）、同一 DeepSWE v1.1 快照与官方独立评分器 |
| 数据集 | 阶段 1 复用**同一套 Dev-28（28 题 × 2 轮 = 56 题次/组）**，便于跨版本核对；不删掉全过/全挂题 |
| 锚点复用 | 若 `omp 19.2.1`、模型与快照均未变化，**原生 OMP `M0`（26/56 = 46.4%）直接复用上批数据，不重复花钱**；若上述任一变化，则补跑 `M0` |
| **评分器超时口径（预先写死）** | 官方评分器 1,800 秒超时**直接计 0 分**（保留 `verifier_exception` 与 `official_reward=null` 供审计），**不再因单题评分超时中断整批队列**；仅在容器崩溃、凭据失效、Git 基线异常或出现 ≥3 例非 `gql` 评分异常时停机 |
| **工具计数口径** | 从第一天起按根/子会话调用 ID 去重，并展开 `js` 的 `innerCalls` 统计外层调用、测试/构建命令与拒绝码 |

---

## 三、阶段 1：Dev-28 完整 $2^3$ 实验矩阵（分 2 个正交半块执行）

把 8 组拆成**两个互补的正交半块（Block 1 + Block 2）**：
* **同时跑完两块 = 完整 8 组全析因（无混叠、主效应与双因子交互项全解析）**；
* **如果中途想看半程成绩**：先跑完 Block 1（4 组、约 $120–$140），它本身就是一个平衡的 $2^{3-1}$ 正交筛选，且已经包含上批 L9 的预测冠军 `E1`（`C_pred`）；若出现单边大雪崩（例如某档暴跌 >10 个百分点）可当场止损，否则无缝补跑 Block 2 拼齐完整 $2^3$。

> 每组均固定：`HERD_TESTING=off HERD_CONSTITUTION=full HERD_FRAMING=off`

| 编号 | 批次 | `HERD_SCOPE` | `HERD_CHINESE` | `HERD_WORKSPACE` | 特殊对照意义 |
|---|---|---|---|---|---|
| **E1** | Block 1 | `adaptive` | `off` | `off` | **9.0.0 L9 预测冠军 `C_pred`**（直接验 63.7% 预测，兼作 `10.3.0` 基线） |
| **E2** | Block 1 | `adaptive` | `on` | `personal` | `adaptive` + 中文 + 个人交互约定 |
| **E3** | Block 1 | `hard` | `off` | `personal` | `hard`（CPS）+ 英文 + `.agent/` 设计记录（验 CPS × 设计记录协同） |
| **E4** | Block 1 | `hard` | `on` | `off` | `hard` + 中文 + 纯净仓库 |
| **E5** | Block 2 | `hard` | `off` | `off` | 与 `E1` 单挑：**纯 `hard` 对 `adaptive`** |
| **E6** | Block 2 | `hard` | `on` | `personal` | `10.3.0` 新默认近似版（关掉 `testing`/`framing`/元技能后的全开版） |
| **E7** | Block 2 | `adaptive` | `off` | `personal` | 与 `E1` 单挑：**纯 `workspace=personal` 对 `off`** |
| **E8** | Block 2 | `adaptive` | `on` | `off` | 与 `E1` 单挑：**纯 `chinese=on` 对 `off`** |

**环境变量模板（以 `E5` 为例）：**
```sh
HERD_TESTING=off \
HERD_CONSTITUTION=full \
HERD_FRAMING=off \
HERD_SCOPE=hard \
HERD_CHINESE=off \
HERD_WORKSPACE=off \
<deep-swe-runner>
```

---

## 四、除了通过率，必须顺手抓取的 5 项机制指标

为了不只看到“谁高几分”，还能知道**为什么高、为什么贵**，每轮从 JSONL 自动抽这 5 组副指标：

1. **成本与时效**：全会话总估价（含子会话）、每满分摊销成本、单题求解均值/中位耗时、平均模型轮次、每轮输入 token（含缓存命中率）。
2. **`scope=hard` 行为验真（重点）**：
   * 平均 `scope_fork` 次数及**四角色占比**（`manager` / `inspector` / `editor` / `devops`）；
   * **跨 upscope 交棒占比**（`upscopePath !== callerPath`，验证模型是真的在用 CPS 交棒，还是只在平铺瞎拆）；
   * `state.scopes_summary` 实际触发次数；
   * `scope_fork` 各类拒绝计数（`DUPLICATE_SCOPE_PATH`、`UNKNOWN_UPSCOPE`、`ROLE_ESCALATION`、`DEVOPS_ALREADY_RUNNING`、`INVALID_EDITOR_TARGETS`）——专门核对 `10.0.0` 去掉控制结果回显后有没有增加路径出错率。
3. **`workspace=personal` 副作用检查（重点）**：
   * 是否在目标仓库写入了 `.agent/` 文件（题次数），以及失败题里有没有因此触发仓库脏工作树/目录测试失败；
   * 平均输出 token 数（量化“非 CS 硕士详述 + 费孝通文风”的输出通胀）。
4. **`10.3.0` 容错与稳定性**：`js` `SyntaxError` / `JS_UNCAUGHT` 次数、空补丁数、`CONTEXT_LIMIT` 次数、求解超时数、未检出测试/构建命令题次数。
5. **失败画像**：按新功能用例失败 / 既有回归失败 / 两类都挂拆分，与上批 `M0`、`F0` 同口径对比。

---

## 五、统计口径与事先锁定的拍板规则

### 1. 主效应与交互效应计算（全部 8 组跑完，共 448 题次）
全部统计以**28 道整题（每题绑两轮）为配对抽样单元**，4,000 次 bootstrap（种子 `612`）给 95% 置信区间，并补按题精确置换检验 p 值：

* **3 个主效应（每档合并 4 组，224 题次 对 224 题次）**：
  * $\Delta_{\text{scope}} = \text{均分}(E3,E4,E5,E6) - \text{均分}(E1,E2,E7,E8)$
  * $\Delta_{\text{chinese}} = \text{均分}(E2,E4,E6,E8) - \text{均分}(E1,E3,E5,E7)$
  * $\Delta_{\text{workspace}} = \text{均分}(E2,E3,E6,E7) - \text{均分}(E1,E4,E5,E8)$
* **3 个双因子交互效应（直接看变量之间有没有互相打架或互相托底）**：
  * `scope × workspace`：检验 `hard` 的 CPS 交棒是不是依赖 `workspace=personal` 的 `.agent/` 设计记录；
  * `scope × chinese`：检验 `hard` 的英文 `omp grandpa rules` 内部通信是否与 `chinese=on` 冲突；
  * `chinese × workspace`：检验两者联合能否复现上批 `F0` 高出预期 7.1 个百分点的现象。

### 2. 拍板规则（跑前写死，拒绝事后找补）
1. **明显胜出**：某档主效应的 95% 区间全程在零的同一侧（或点估计领先 $\ge 4$ 个百分点且无反向交互），直接入选。
2. **噪声带平局的简约原则**：若某因子两档主效应差值 $< 2$ 个百分点且无显著交互，优先选**更省钱、更快、不污染外部仓库**的档位：
   * `workspace` 平局 → 选 `off`（不向陌生仓库写 `.agent/`）；
   * `scope` 平局 → 选每满分摊销更低、或求解耗时明显更短的那档；
   * `chinese` 平局 → 评测与英文长程任务默认 `off`，日常中文交互可按需开 `on`。
3. **存在强交互时**：不看单个主效应，直接从 8 组里选综合通过率与性价比最优的组合（若第 1、2 名只差 $\le 2$ 个题次，把两者一起送进阶段 2 终审，不在 Dev-28 上过度微调）。

---

## 六、阶段 2：Full-113 全量终审（最终定默认值的唯一依据）

Dev-28 跑完锁定胜出组合 `C*` 后，在 **Full-113（113 题 × 1 轮；预算允许可跑 2 轮）** 只跑 **3 个点**（若 `adaptive` 与 `hard` 在 Dev-28 紧咬在 2 题内，则补第 4 个点做终极对决）：

| 组别 | 配置 | 作用 |
|---|---|---|
| **`M0`** | 原生 OMP 19.2.1（无插件） | 全量基准线 |
| **`K0`** | `10.3.0` 纯机制（6 开关全 `off`） | 全量机制基线 |
| **`C*`** | `10.3.0` Dev-28 胜出组合 | 候选新默认配置 |
| **`C2`** *(可选)* | 仅当 `adaptive` 与 `hard` 在 Dev-28 差距 $\le 2$ 题次时加跑 | 在 113 题上终极裁决 `adaptive` vs `hard` 的分/钱/时三角 |

**最终合入默认值的门槛**：
* `C*` 在 Full-113 上需稳定领先 `M0` 且不劣于 `K0`；
* 若 `C*` 与次优档差距在 Full-113 上 $< 3$ 题，按**每满分摊销成本更低、求解更快、无 `.agent/` 仓库污染**者胜出；
* `chinese` 若对英文题无正收益，仅作个人日常偏好开关，不靠硬编码绑死在长程默认里。