# 编排：stages 关闭开关的最小上线切片

用户要求：先把「关闭 stage 功能」的开关做成真的可用，然后关掉、重启。现状是端口表
已经认识 `stages: on|off`（`HERD_DISABLE_STAGES=1` 解析为 `off`），但运行期没有任何
调用点读它，所以关不掉。

## 1. 切片与写集

| 切片 | 写集 | 输入契约 | 输出契约 | 停止条件 |
| :--- | :--- | :--- | :--- | :--- |
| S-A 门禁读端口 | `src/station/controls.mjs`、`src/scope/accounting.mjs`、`tests/stages-switch.test.mjs`（新增） | `validateFission(state, begin, options)` 现有签名；`options` 增加 `stagesOff` | 当 `stagesOff === true` 时，`STAGE_FLAGS_UNMET` 分支不触发；其余校验不变 | 新增用例：`HERD_DISABLE_STAGES=1` 解析为 `off` 后，`validateFission` 不再拒绝 `direct-execution`；全套测试绿 |
| S-B 提示词块不再注入 | `src/host/prompts.mjs`、`src/station/gates.mjs`、`src/host/index.mjs`、`tests/prompts.test.mjs`（若需） | `injectSystemPrompt(prompt, { stages: "on"|"off" })` | `off` 时不注入 `stagePromptsBlock`，也不保留旧的 stage 段 | `managedBlock` 与数组注入两条路径都不含 `stagePromptsStart`；`on` 时逐字节不变 |

S-A 与 S-B 写集不相交，可同批；但 S-B 依赖 S-A 已经把 `ports.stages` 传到 station
（同一个读取点），因此按 **S-A → S-B** 两批执行，批次 2 单项的理由是真实依赖。

## 2. 读取口

- `SessionStation` 已经持有 `registry`，而 registry 的 `ports()` 返回启动时解析的表。
- `controls.handleFissionBegin` 组 `options` 时加入 `stagesOff: station.registry?.ports?.().stages === "off"`。
- `gates.onBeforeAgentStart` 调 `injectSystemPrompt(event?.systemPrompt, station.registry?.ports?.() ?? {})`。

不在 `src/scope/accounting.mjs` 里读环境变量：领域层只接收布尔事实，开关判断留在组合根。

## 3. 安全与活性

- **S1**：`stagesOff` 只影响 `STAGE_FLAGS_UNMET` 一条拒绝；`INVALID_STAGE`、预算、权限、
  relay 前置条件全部保留。
- **S2**：`stagesOff` 缺省 false；未设置环境变量时行为逐字节不变。
- **S3**：`injectSystemPrompt` 的新参数缺省 `{}`，现有调用者无需改动。
- **L1**：设置 `HERD_DISABLE_STAGES=1` 并重启后，`scope({stage:"direct-execution"})`
  不再因缺三个前置阶段被拒。
- **L2**：不设置该变量时，`bun test tests` 与今天完全一致。

## 4. 验证

```bash
bun test tests/stages-switch.test.mjs
bun test tests
env -u HERD_SCOPE -u HERD_RELAY bun test tests
HERD_DISABLE_STAGES=1 bun -e 'import { resolvePorts } from "./src/core/ports/resolve.mjs"; console.log(resolvePorts({}, process.env))'
```

最后一条必须打印 `ports.stages === "off"`。

## 5. 交付方式

两个切片各自一个提交；S-A 先提交，用户即可在重启后关闭 stage 门禁。S-B 紧随其后，
让系统提示里的 stage 段也消失。最终答复必须给出确切变量名与启动方式：
`HERD_DISABLE_STAGES=1 omp`（或写入 shell 环境后重启）。
