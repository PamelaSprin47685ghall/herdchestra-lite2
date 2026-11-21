# 验收：live loop 历史对齐热修

本用例集验收一个用户可见的失败：交接压缩之后，自动续跑的那一轮以
`The live loop contains uncommitted output that cannot be aligned safely with the committed history.`
中止，屏幕上出现 ✘ 提示，并用一条空的 assistant 消息结束该轮。修好之后，同样的序列必须
正常跑完，而真实损坏的历史仍必须被拒绝。

**失败证据（修复前，已实跑）**：`~/.omp/logs/omp.2026-11-21.3900027.log` 第 70 行，
12:43:58 记录 `agent turn ended with provider error`，错误文本就是上面这句；同一 session
在 12:43:49 刚写入 `compaction`（handoff）并注入 `session-stop-continuation`。
用户屏幕上的提示为 `✘ … Dismissed when you send your next message.`

## 0. 共用约定

- 工作目录：一个干净的临时目录（不要用本仓库；本仓库的插件会改动被验收对象的会话）。
- 真实界面：终端里的 omp TUI。所有步骤由一名执行者（人）或一名代理按屏幕与键盘完成，
  不允许用脚本断言代替。
- 观测文件：`~/.omp/logs/omp.<日期>.<pid>.log` 与
  `~/.omp/agent/sessions/<cwd>/<session>.jsonl`，两者都是真实产物。
- 每个用例都带自己的 0–100 评分尺；两名独立评审对同一份证据的分数必须落在 ±5 内，
  否则证据不足，重跑。
- 权重、形容词堆叠、照抄模板一律不算评分尺。

## 1. CASE-LIVE-LOOP-01：交接压缩后的自动续跑

- path：真实 omp 会话 → 交接压缩 → 自动续跑 → 下一轮用户消息
- threshold：80
- 前置条件：
  1. omp 已安装且本仓库的扩展由 `package.json` 的 `omp.extensions` 加载；
  2. 新会话（不是恢复旧会话），todo 账本为空；
  3. 执行者能在终端看到完整的 TUI 与提示行。
- steps：
  1. 在临时目录启动 `omp`，等首屏出现。确认工具面里有 `todo` 与 `scope`。
  2. 输入一句普通请求（例如 `说一句你好`）并回车。等这一轮结束、输入框重新可见。
  3. 本轮的 todo 账本保持为空，不要调用 `todo`。观察交接序列：屏幕上应出现上下文被替换
     （handoff 摘要）与自动续跑的开始。
  4. 盯住续跑轮次的第一条模型调用。记录屏幕是否出现
     `✘ The live loop contains uncommitted output …` 或其任何截断形式。
  5. 用 `tail -n 200 ~/.omp/logs/omp.<当天>.<pid>.log | grep -n 'provider error\|uncommitted output'`
     检查日志。再在 session JSONL 的最后 20 条里确认续跑轮次有非空的 assistant 输出，
     且没有以空 assistant 结束。
  6. 续跑结束后，输入 `继续` 并回车；这条普通消息必须正常得到回答。
  7. 把步骤 4–6 的屏幕文本、日志行、JSONL 行交给执行者复述一遍实际体验。
- expected：续跑轮次的模型调用到达提供方并产出非空回答；屏幕与日志都没有对齐错误；
  `继续` 正常回答；会话不需要用户先发一条消息才恢复。
- rubric（0–100）：
  - 100：步骤 1–7 一次跑通，屏幕与日志零错误行，续跑回答非空，`继续` 正常。再做一次
    同样序列（第二次 handoff）仍然 100。
  - 80（just-PASS）：续跑正常、无错误行，但出现一处不影响数据的异常（例如回执重复、
    一条 pending 输入显示顺序变化），执行者确认没有消息丢失或重复。
  - 79（just-below-PASS）：续跑正常但需要用户先发一条消息才能继续，或日志里出现一次
    可疑的 `provider error` 其它文本。
  - 40：出现对齐错误提示，但输入 `继续` 后会话能恢复；每多中断一次再扣 20。
  - 0：对齐错误之后会话无法继续，或出现消息丢失/重复。
  - 硬失败（直接 0，不进入加权）：出现 `uncommitted output` 文本（屏幕或日志）；续跑
    轮次没有产生任何 assistant 输出；任何用户消息被丢弃或重复。
  - 未覆盖路径扣分：四条非快乐路径每条未跑扣 15 分——(a) 续跑期间用户插话（steer），
    (b) 连续两次 handoff，(c) 边界处存在未完成的工具调用帧，(d) 注入真实损坏历史
    （由 CASE-02 覆盖，未跑同样扣分）。
  - 粒度与取整：先按整数记分，未跑路径按 15 分递减，最后四舍五入到整数；同一证据
    两名评审相差超过 5 分视为评分失败，重跑。
  - 最低证据：续跑轮次的屏幕文本或 pty 转录 + 日志对应行 + session JSONL 对应条目。
    只有单元测试结果不算通过本用例（扣 10 分且最高 60）。
  - 双 WTP：`user_score` 按“用户是否感到被打断”给分（无感 100；看见一次 ✘ 扣 30；
    需要手动再发一条消息扣 40；会话卡死 0）；`developer_score` 按“是否有隐藏异常”给分
    （零错误行且无丢/重 100；每处需人工解释的异常扣 20；需要重跑才稳定扣 20）。
    最终分 = min(user_score, developer_score)。

## 2. CASE-LIVE-LOOP-02：真实损坏仍被拒绝

- path：手动调用 `splitRequestHistory`（真实模块，不 mock）的坏输入分支
- threshold：100
- 前置条件：仓库根可运行 `bun`；不修改任何源文件。
- steps：
  1. 在 `/tmp` 写一个一次性脚本，`import { splitRequestHistory } from "<repo>/src/host/context-preparation.mjs"`。
  2. 依次喂三组输入，每组单独打印结果：
     (a) `messages = [user, assistant(toolCall id=read-1), toolResult(toolCallId=read-2)]`，
         `committed = [user]`（工具结果不属于前一帧）；
     (b) `messages = [user]`，`committed = [assistant]`（提交历史在循环里丢失）；
     (c) `messages = [clone(tail), tail]`，`committed = [tail]`（尾部位置不唯一）。
  3. 每组必须抛出 `CONTEXT_PREPARATION_HISTORY_MISMATCH`；记录 `error.message` 与
     `error.code`。脚本退出后删除。
  4. 再喂一组合法输入：`messages = [user, custom(steer), assistant(旧输出)]`，
     `committed = [user]`；修复后的实现必须返回 `prefix=[user]` 且不抛错，执行者记录
     返回的 pending 形状。
- expected：三组坏输入全部被拒绝且拒绝码一致；合法输入被安全对齐，不中止。
- rubric：
  - 100：三组坏输入全部抛出 `CONTEXT_PREPARATION_HISTORY_MISMATCH`，合法输入返回而
    不抛错，pending 只含输入角色。
  - 80：坏输入全部拒绝，但合法输入的对齐保留了不应保留的输出（记下具体角色）。
  - 0：任一坏输入被静默吞掉并返回；或合法输入仍抛错。
  - 硬失败：为了让合法输入通过而让坏输入也通过；或改动断言而不是实现。
  - 最低证据：三组 `code`/`message` 输出 + 合法输入的 `JSON.stringify(result)`。
  - 双 WTP：`user_score` = 100（坏输入本就不该出现在用户界面）；`developer_score`
    按“拒绝是否精确、是否可诊断”给分（每条拒绝消息含具体原因 100；笼统一句扣 20；
    静默吞掉 0）。最终分 = min。

## 3. 执行记录

| 时间 | 用例 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| 修复前（已发生） | CASE-01 的失败形态 | 失败 | 主机日志 12:43:58 的 provider error 行；session JSONL 的 compaction + session-stop-continuation 条目 |
| 修复后（待跑） | CASE-01 / CASE-02 | 待填 | 屏幕转录、日志行、JSONL 条目、`bun test tests` 结果 |
