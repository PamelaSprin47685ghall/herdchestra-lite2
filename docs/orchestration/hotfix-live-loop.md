# 编排：live loop 历史对齐热修

对应架构：`docs/architecture/hotfix-live-loop.md`。验收：`docs/acceptance/hotfix-live-loop.md`。
本次是单文件行为修复，切片之间是真实契约依赖，不派发并发 worker。

## 1. 切片

| 切片 | 写集 | 输入契约 | 输出 | 停止条件 |
| :--- | :--- | :--- | :--- | :--- |
| H1 纯函数 | `src/host/context-preparation.mjs` 的 `partitionPending` / `splitRequestHistory` | 现有 `{prefix, pending, recovered}` 语义与尾定位算法 | 任意位置的死 assistant 帧进 `recovered`；半提交帧返回 `frameInFlight`；孤立 toolResult 仍抛错 | 纯函数用例覆盖五种形状（无残留、开头死帧、插话死帧、半提交帧、孤立结果） |
| H2 钩子策略 | 同文件 `prepareState` | H1 的 `frameInFlight` | 为 true 时记录诊断并返回，不写回执、不改 `context.messages` | 钩子级用例：延迟一次后上下文逐项不变；帧提交后下一次恢复回执 |
| H3 回归与清理 | `tests/context-preparation.node.test.mjs` | H1/H2 | 旧的「输入后的输出必须抛错」用例改为隔离断言 | `bun test tests` 全绿 |

## 2. 安全不变量

- **S1**：`pending` 只含输入角色。
- **S2**：`recovered` 永不进入模型输入，也不写回 journal。
- **S3**：提交尾缺失、重复、歧义三种损坏仍抛 `CONTEXT_PREPARATION_HISTORY_MISMATCH`。
- **S4**：孤立 toolResult（既不属 pending 帧，也不属提交帧）仍抛错。
- **S5**：`frameInFlight` 时本次调用零写入：不写 journal、不改 live 数组、不推进时钟。

## 3. 活性

- **L1**：交接压缩后的自动续跑不再被该错误中止。
- **L2**：延迟一次后，下一次模型调用若已对齐，回执恢复。
- **L3**：诊断环留下角色、计数与 toolCallId，复现可定位。

## 4. 验证

```bash
bun test tests/context-preparation.node.test.mjs
bun test tests
bun test tests/contract
env -u HERD_SCOPE -u HERD_RELAY bun test tests
```

## 5. 执行记录

| 提交 | 内容 | 验证 |
| :--- | :--- | :--- |
| `6604400` | H1–H3 | context-preparation 30 通过；全量 1013 通过；contract 99 通过 |
