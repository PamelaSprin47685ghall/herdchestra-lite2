# DeepSWE 测试方案

## 0. 目的与非目标

本方案只回答一个问题：在**同一份代码、同一模型、同一评测环境**下，`/herd` 的每个提示词特征对 DeepSWE 通过率是正收益、零收益还是负收益。

非目标：

- 不写只对 DeepSWE 生效的隐藏提示词，不维护“跑分版”和“日常版”两套互相隐瞒缺陷的文本。
- 不先验判断“该不该跑红灯”“该不该 clean break”。所有结论来自实测边际效应。
- 不在 Full-113 上反复调参。Full-113 只做最终确认。

评测时提示词开关全部通过启动环境变量设置；headless 容器里不需要执行 `/herd`。

## 1. 固定控制

每一轮必须锁定并记录：

| 项目 | 要求 |
|---|---|
| 代码版本 | 同一 git commit；记录 hash |
| 模型 | 同一 provider/model/thinking 档位 |
| 任务集 | Dev-30 或 Full-113，题号固定 |
| 单题超时 | 固定值 |
| 镜像/依赖 | 同一镜像与 lockfile |
| 评分 | 官方隐藏 verifier；不读 test.patch |
| 并发 | 固定并发数；避免资源竞争改变超时 |
| 重试 | 默认不重试；失败题保留 |
| 记录 | 每题 JSONL + 汇总表；保存环境变量 |

## 2. 数据集与指标

### 2.1 Dev-30

从 DeepSWE 113 题按语言分层抽取 30 题：TypeScript、Go、Python、JavaScript、Rust 各 6 题。用于阶段 1 和阶段 2 的筛选，避免每轮都跑全量。

### 2.2 Full-113

最终只在全量 113 题上跑 3 个点：原版 omp `M0`、最佳纯机制内核 `K*`、最终组合 `C*`。

### 2.3 指标

| 指标 | 定义 | 用途 |
|---|---|---|
| pass/total | 官方 verifier 通过题数 / 总题数 | 主指标 |
| zero-change | 最终 diff 为空或仅注释的题数 | 定位提前停机/不行动 |
| early-stop | 未完成工具链就自然停止的题数 | 定位 autopilot/ask/review |
| never-tested | 从未运行编译、类型检查或相关测试的题数 | 定位 testing 特征 |
| timeout | 超时题数 | 定位 review/context/fork 开销 |
| steps | 每题平均模型步数与工具调用数 | 定位并行与自省成本 |
| context-limit | 触发 `CONTEXT_LIMIT` 的次数 | 定位读文件策略与 fork 粒度 |
| forks | 平均 `scope_fork` 次数 | 定位 scope 策略 |
| tokens | 输入/输出 token | 成本与上下文税 |

主指标用配对比较：同一题在不同配置下的通过/失败。不要只比总数。

## 3. 阶段 1：锚定上下界

所有评测配置默认 `HERD_AUTOPILOT=on`；`M0` 是原版 omp，不加载本插件。

| 组 | 配置 | 回答的问题 |
|---|---|---|
| `M0` | 原版 omp，无插件 | 目标基准线 |
| `K0` | `autopilot=on, review=off, chinese=off, testing=off, constitution=off, framing=off, scope=off, workspace=off` | 纯机制（js + scope_*）相对原版是正、零还是负 |
| `K1` | `K0` 仅改 `review=on` | Root 首次大 oath 的强制 rewind 是正还是负 |
| `F0` | `autopilot=on, review=on, chinese=on, testing=lean, constitution=full, framing=full, scope=aggressive, workspace=full` | 当前 6.1 全量默认的基线（默认值复现 6.0 提示词） |

闸门：

1. 若 `K0` 与 `K1` 都显著低于 `M0`，先查机制，不要继续调提示词：`js` 报错、Root 无普通工具、`CONTEXT_LIMIT` 50% 锁定、`renderChildRecord` 剥离 `toolResult`、fork/join 摩擦。
2. 若 `K0`/`K1` 接近或超过 `M0`，进入阶段 2。
3. 取 `K0`/`K1` 中较高者作为后续的 `K*`，并固定其 `review` 值。

## 4. 阶段 2：L9(3^4) 正交筛选

固定：`autopilot=on`、`chinese=off`、`workspace=off`、`review=K1 胜者`。

四个三态因子：`testing`、`constitution`、`framing`、`scope`。用 `L9(3^4)`，每行只跑 Dev-30 一次；9 轮可并发。

| Run | testing | constitution | framing | scope |
|---:|---|---|---|---|
| 1 | off | off | off | off |
| 2 | off | core | plan | adaptive |
| 3 | off | full | full | aggressive |
| 4 | no-red | off | plan | aggressive |
| 5 | no-red | core | full | off |
| 6 | no-red | full | off | adaptive |
| 7 | lean | off | full | adaptive |
| 8 | lean | core | off | aggressive |
| 9 | lean | full | plan | off |

任意两列的全部 3×3 组合恰好各出现一次，因此每个档位的边际均值不受其他三个因子影响。

### 4.1 边际均值

对因子 `f` 的档位 `v`：

```
mean(f=v) = average(pass_rate of the 3 rows where f=v)
delta(f=v) = mean(f=v) - mean(all 9 rows)
```

报告每个因子的三个 `mean` 与 `delta`，并附 `never-tested`、`early-stop`、`context-limit` 的边际率。

### 4.2 加性预测与 1 轮确认

每个因子取边际均值最高的档位，拼成 `C_pred`：

```
predicted(C_pred) = overall_mean + sum_f (mean(f=best_f) - overall_mean)
```

实跑 1 轮 `C_pred`：

- 实测接近预测：加性成立，锁定 `C_pred`。
- 实测明显低于预测：存在负交互。只对边际变动最大的两个因子补一个 2×2（其余固定为最佳档位），不要回到全网格。

### 4.3 噪声带内的配对复跑

若两个档位只差 1–2 题，不要重跑整套 30 题。只取两者结果不同（一过一挂）的分歧题子集，复跑 k=2–3 次，用配对 McNemar 检验判断差异是否稳定。通过率差值在 ±1 题内按“无结论”处理。

## 5. 阶段 3：Full-113 终审

只跑 3 个点：

| 组 | 配置 |
|---|---|
| `M0` | 原版 omp |
| `K*` | 阶段 1 胜出的纯机制内核 |
| `C*` | 阶段 2 胜出的组合 |

每个点跑 1 次全量；若预算允许，关键点跑 2 次取均值。Full-113 的结果只用于拍板，不用于继续搜索。若 `C*` 与 `K*` 差距小于 4 题，视为噪声，优先选择提示词更少、行为更简单的配置。

## 6. 环境变量示例

`K0`：

```sh
HERD_AUTOPILOT=on \
HERD_REVIEW=off \
HERD_CHINESE=off \
HERD_TESTING=off \
HERD_CONSTITUTION=off \
HERD_FRAMING=off \
HERD_SCOPE=off \
HERD_WORKSPACE=off \
<deep-swe-runner>
```

`L9 Run 5`（`testing=no-red, constitution=core, framing=full, scope=off`）：

```sh
HERD_AUTOPILOT=on \
HERD_REVIEW=<K1-winning-review> \
HERD_CHINESE=off \
HERD_TESTING=no-red \
HERD_CONSTITUTION=core \
HERD_FRAMING=full \
HERD_SCOPE=off \
HERD_WORKSPACE=off \
<deep-swe-runner>
```

`F0`：

```sh
HERD_AUTOPILOT=on \
HERD_REVIEW=on \
HERD_CHINESE=on \
HERD_TESTING=lean \
HERD_CONSTITUTION=full \
HERD_FRAMING=full \
HERD_SCOPE=aggressive \
HERD_WORKSPACE=full \
<deep-swe-runner>
```

`HERD_HERD=off` 只用于确认命令被禁用，不用于评测。

## 7. 结果记录模板

每轮一行：

| run | commit | model | tasks | pass | zero-change | early-stop | never-tested | timeout | context-limit | forks | tokens | notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|

每轮另存：

- 环境变量全集；
- 每题 pass/fail、步数、耗时、token；
- 失败题的错误类别（编译、类型、测试、超时、上下文、未改动）；
- 与上一轮的配对分歧题列表。

## 8. 解释与防过拟合

- Dev-30 的单轮通过率标准误约 `sqrt(0.25/30) ≈ 9.1%`，约 3 题；不要把 1–2 题的差异当结论。
- Full-113 的采样噪声通常在 ±3–4 题；最终判断用配对差异与置信区间。
- 先跑 `M0/K0/K1/F0`，再跑 `L9`；不要因为某一轮“看起来好”就提前锁定。
- 所有配置只通过 `HERD_*` 环境变量表达；不要为评测新增代码分支或隐藏提示词。
- 如果某个特征在 `K0` 上为负，但在 `C*` 组合中为正，记录交互，不把它单独设为默认。
- 最终默认值取“Full-113 上不劣于 `K*` 且对真实长程任务更稳”的配置；个人交互偏好（`chinese`、`workspace`）默认可以保持日常值，但必须能一键切到评测预设。

## 9. 判定标准

一个特征档位只有在以下条件同时成立时才进入默认组合：

1. Dev-30 边际效应为正，或至少不在噪声带内为负；
2. Full-113 配对差异不劣于 `K*`；
3. 没有显著增加 `zero-change`、`never-tested` 或 `timeout`；
4. 在真实长程任务中可解释、可维护，不是只对榜单有效的特调。
