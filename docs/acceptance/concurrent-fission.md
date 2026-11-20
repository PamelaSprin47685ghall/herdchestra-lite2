# concurrent-fission 验收用例

这些用例是**人工经验测试**，不是单元/集成断言的别名。执行者必须在隔离的 `/tmp` 副本中启动真实的 omp 会话或仓库自带 fake-host harness，按步骤看真实会话文件、真实事件输出与真实状态条，再扮演用户回答最后一步。机器断言只能作为证据，不能替代最后一步。

阈值统一为 85。每条 rubric  personally 定义 0–100：

- 90–100：全部要求与列出的非顺利路径都成立，用户愿意为这个体验付费，开发者也愿意签字。
- 85–89：核心体验可用，仅有不超过一个轻微瑕疵；刚好通过。
- 75–84：有一个明确缺陷或一个非顺利路径未证实；刚好不通过。
- 60–74：多个核心行为缺失，需要返工。
- 0–59：数据损坏、假成功、线索丢失或范围失守。
- 每条未实际执行的非顺利路径扣 5 分；越界改源码、把断言结果当成屏幕事实、跳过 `/tmp` 隔离，各算硬失败。
- 判定以 1 分为粒度，不取平均；两位审计者在同一证据上的差值不得超过 5。
- `user_score` 与 `developer_score` 各自独立给出；`final = min(user_score, developer_score)`。任何“wow”同时进入两者，不能只救一边。
- 最少证据：会话文件相关用例要有相关 entry 的父链/类型/数量；UI 用例要有逐事件输出与屏显；故障用例要有故障前后的文件痕迹或 warning；继承用例要有 owner/继承者 agent 的实际消息。

| 设计验收项 | 覆盖用例 |
|---|---|
| 1–4、11 | CASE-01 / CASE-03 / CASE-13 |
| 5、9 | CASE-04 / CASE-08 |
| 6、9 | CASE-05 |
| 7 | CASE-06 |
| 8 | CASE-07 |
| 10 | CASE-11 |
| 12 | CASE-07 |
| 13–15、19 | CASE-08 |
| 16、17、18 | CASE-09 |
| 20、21 | CASE-10 |
| 4 个缺口：状态条键、`kind:"sub"`、`tokenRate`、审批 label | CASE-12 |

## CASE-01

- case_id: CASE-01
- path: `/tmp/fission-accept/01-bifurcation`
- threshold: 85
- steps:
  1. 复制仓库到 `/tmp/fission-accept/01-bifurcation`，运行 `bun test tests/fission-scheduler.test.mjs tests/fission-manager.test.mjs`，确认基线工具可用；这只是准备，不是验收。
  2. 启动带本扩展的真实 omp 会话，开一个普通 scope，再调用 `scope({ begin: { stage: "architecture-design", elder_report: null, fission: [{ intent: "甲", budget: { read: 3 }, permission: "rw" }, { intent: "乙", budget: { read: 2 }, permission: "ro" }] } })`。
  3. 在两条流尚未结束时打开会话 jsonl，逐条查看 `toolCall`、`toolResult`、`scope.begin`：批次 `scope.begin` 应有两个 `toolResult` 子节点，各自带不同 `details.fissionReceipt.flowId` 与对应 intent；每个 toolResult 下再挂一条该流的 `scope.begin`。所有者的 toolResult 不在任何一条流的父链上。
  4. 等两条流各写至少一条 assistant 消息，分别沿父链向上读回，核对它们 tail 不同，重载会话后这两条 tail 仍可从文件重建。
  5. 把结果交给扮演用户的 actor，请他根据页面与会话文件回答：“这是不是两个同时开始、各自有完整上下文的工作线？”
- expected: 真分叉，结构为共享调用 → 批次 begin → 每流独立回执 → 每流 begin → 各自后续；重载后不丢失。
- rubric: 100 = 五步全部成立且两个 tail 可重建、owner 回执不混入任何流；90 = 结构正确但日志标注不够直观；85 = 父链正确但其中一条流未自行写入，只靠调度器边界；84 = 任一回执缺失或两流共享 parent；75 = 重载丢失一条 tail；低于 60 = 只有一条真流。未打开 jsonl 逐条读链扣 5；未重载扣 5；杀掉其他流隔离扣 5。hard fail：伪造 entry 或把单元测试通过当成屏幕事实。`user_score`/`developer_score` 按是否愿意以此结构继续工作独立评分，final = min。

## CASE-02

- case_id: CASE-02
- path: `/tmp/fission-accept/02-handoff-mainline`
- threshold: 85
- steps:
  1. 在 `/tmp` 副本启动两流批次；甲流内部再开一个普通子 scope 并写一条独特文本，然后调用 `scope({ end: true })`；乙流保持运行。
  2. 等抄写队列清空，查看乙流 tail 的父链：顺序必须是乙流原 tail → `fission.handoff.begin` → 甲流的 `scope.begin…scope.end` → `fission.handoff.end`；乙流后续 message 必须挂在该 `handoff.end` 之后。
  3. 检查乙流 agent 的实际 `state.messages`，其中必须出现甲流的 message 与 begin/end CustomMessage，且不出现 `fission.handoff.begin/end` 账本消息。
  4. 让乙流结束，观察批次 end 写在继承者边界之后，整批 scope 正常回到外层。
  5. 把结果交给扮演用户的 actor，请他判断：“乙流看到的甲流历史是不是顺着自己的主线接上的，而不是一段悬空旁支？”
- expected: 抄写段是接收方主线，边界进上下文，账本不进上下文。
- rubric: 100 = 父链与上下文序列同时正确，且无重复；90 = 父链正确但一处 UI 显示次序轻微不顺；85 = 父链正确、账本未注入；84 = 任一边界缺失或账本泄漏；75 = 抄写成旁支；60 = 乙流没有收到甲消息。未执行运行中的乙流直接写兜底扣 5；未读真实 agent messages 扣 5；未验证批次 end 扣 5。hard fail：只凭 `appendCustomEntry` 源码推断。双侧 WTP 各评一次，final = min。

## CASE-03

- case_id: CASE-03
- path: `/tmp/fission-accept/03-depth-text-shift`
- threshold: 85
- steps:
  1. 用 CASE-02 的同批结构，但甲流内部开两层子 scope，并确保旧流的 scope nudge / receipt / inside 文本进入其消息历史；乙流在抄写前也打开自己的子 scope，使 `shift !== 1`。
  2. 抄写后从文件中读取源段与被抄段的每一条 `scope.begin/end`，按结构推导深度：被抄段逐项应等于源段逐项加同一个 shift。
  3. 阅读被抄的 message 文本：所有 `scope level <n>` 的 n 应加同一个 shift；`Remaining budget`、`intent`、时间戳和行号不得改变。
  4. 让乙流调用一次实时 scope 工具，确认其新回执的深度仍按当前 state 计算，不沿用历史里的旧数值。
  5. 把结果交给扮演用户的 actor，请他说出“历史深度”和“当前深度”各自代表什么。
- expected: 结构平移、文本数值平移、预算文本原样、实时回执不平移。
- rubric: 100 = 四步全对且能解释语义；90 = 深度与文本全对但解释略含糊；85 = 全部数值正确、个别无关文本多改一处；84 = 深度对但有一处 scope level 未平移；75 = 预算也被换算；0 = 写死 shift=1。未检查两层内部 scope 扣 5；未检查 budget 原文扣 5；未检查实时回执扣 5。hard fail：抄写后引入 depth 字段。双侧 WTP，final = min。

## CASE-04

- case_id: CASE-04
- path: `/tmp/fission-accept/04-half-handoff-recovery`
- threshold: 85
- steps:
  1. 在 `/tmp` 副本准备含两个 flow 的 batch，人为在抄写一个段的中途杀掉进程，保留已有 `fission.handoff.begin` 与部分被抄 entry，且**不**写 `handoff.end`。
  2. 重启会话，观察调度器的恢复记录：旧记录有完整 source range/target tail/shift 时按同一记录重抄；旧记录只有 handoffId/sourceBeginId 时只退役不猜范围。
  3. 检查重抄结果：除两个 handoff 标记外，新增 entry 数量与类型序列与复制窗口一致；残留 begin 不改变活动叶；审计明确标记 `copied/skipped/failed`，退役不写成 delivered。
  4. 再做一次同名 handoff 重试，确认幂等，盐值 collision 时仍有合法 `[0-9a-f]+` id。
  5. 把结果交给扮演用户的 actor，请他回答：“崩溃后重载，能不能放心继续？”
- expected: 无悬挂 half begin，不复制不存在历史；幂等重抄；报告诚实。
- rubric: 100 = 一半崩溃、旧记录、幂等三种全过；90 = 重抄过程过但报告不够细；85 = 只覆盖新记录且结果正确；84 = 重抄数量差一处；75 = 旧记录被猜抄；0 = 半段进入活动叶。漏掉崩溃路径扣 5；漏掉旧记录扣 5；漏掉 collision 扣 5。hard fail：删除源段历史当作恢复。双侧 WTP，final = min。

## CASE-05

- case_id: CASE-05
- path: `/tmp/fission-accept/05-dispose-isolation`
- threshold: 85
- steps:
  1. 启动两流批次，在两流都在跑时对其中一条的 flow agent 调用 dispose/close，模拟一条流主动或异常释放。
  2. 查看共享 manager 的 seal/close 计数：单流释放不得封死 journal，另一条流的下一次 append 必须落盘并可在其分支上读到。
  3. 再释放第二条；确认最后一次才真正 seal/close/release，期间没有把 SessionManager 生命周期绑到某一批或某一 AgentSession。
  4. 并行写入阶段记录每次写前后的 `getConversationTip()`，抄写阶段记录叶是否停在段尾；两类断言标签各自独立、没有误报。
  5. 把结果交给扮演用户的 actor，请他确认：“一条流坏掉后，另一条是否还能工作？”
- expected: 引用计数正确；并行写恢复活动叶；抄写段不恢复活动叶。
- rubric: 100 = 四项均实证，无告警；90 = 一条释放后另一条能写但 leaf 恢复检查少一项；85 = 释放隔离正确、抄写叶检查正确；84 = 一个断言缺少证据；75 = 单流释放导致另一条写入被丢弃；0 = manager 被提前 seal。未在同批中做 dispose 扣 5；未检查 seal 计数扣 5；未做两种相反叶断言扣 5。hard fail：把 dispose 后的流当成功抄写对象。双侧 WTP，final = min。

## CASE-06

- case_id: CASE-06
- path: `/tmp/fission-accept/06-budget-permission-gate`
- threshold: 85
- steps:
  1. 在 `/tmp` 副本用不合法 begin 分四次尝试：缺 fission、fission 空数组、某项预算为负数或小数、permission 为 `"admin"`；每次检查工具结果错误码与文件状态。
  2. 用合法 begin 开两流：甲 rw、乙 ro，甲预算 `{read: 3}`、乙 `{read: 2}`。甲用超预算，乙继续读；确认乙的 remaining 不受影响，抄写到乙的预算文本不生成新额度。
  3. 在乙流调用 `edit`、`write`、`ast_edit`、破坏性与非破坏性 `bash`，按实现契约核对：这些写类工具全部拒绝，read 等读工具放行；另查 herdMode 下非 framing stage 返回 `INVALID_STAGE`，rw 在 decision-framing / ledger 前返回相应门禁错误。
  4. 把结果交给扮演用户的 actor，请他判断：“额度、权限和 stage 是否真的分别按流与批次执行？”
- expected: 整批原子校验；无半开流；预算不串；权限和 stage 门照现有语义。
- rubric: 100 = 四错全拒、预算隔离、ro 拦四类写工具、stage 门成立；90 = 有一处错误提示不够清楚但无状态污染；85 = 四种非法 begin 与预算隔离成立，ro 只拦三类；84 = 错误码正确但未查文件半开；75 = 一项非法 begin 留下 entry；0 = rw 门禁被突破。未做非法参数扣 5；未查文件状态扣 5；未执行 read 对拍扣 5。hard fail：任何状态污染未被清理。双侧 WTP，final = min。

## CASE-07

- case_id: CASE-07
- path: `/tmp/fission-accept/07-stop-and-costcap`
- threshold: 85
- steps:
  1. 两流批次中先结束一条，另一条仍跑；此时触发 `onSessionStop`，观察 relay 未推进，CLI/状态没有宣称整批成功。
  2. 把 `session.maxCost` 设为低值，让两流总支出触顶；观察**命中 gate 的那一条**收到 CostCapError 并写 `fission.aborted`，其余仍跑；最后无 running 流时批次 outcome 为 `cost-capped`，`onSessionStop` 不宣告成功。
  3. 另做一轮把预算仅给单条的大额度而不设 maxCost，确认两条流合计美元由同一个 CostGate 计数，不是每条各得一份 cap。
  4. 把结果交给扮演用户的 actor，请他确认：“停止与美元上限没有把未做完的活说成完成。”
- expected: running 流拖延停止；CostGate 共用；cost-capped 明确失败。
- rubric: 100 = 三 scenario 全对且文案诚实；90 = 语义对但 warning 缺 flow label；85 = 停止与 cost cap 均正确；84 = 只看到一条流被 cap，但 outcome 未检查；75 = 提前 relay 成功；0 = 两流各按 maxCost 放大。未实跑 onSessionStop 扣 5；未看 outcome 扣 5；未看共用 gate 扣 5。hard fail：cap 后仍开新 provider 请求。双侧 WTP，final = min。

## CASE-08

- case_id: CASE-08
- path: `/tmp/fission-accept/08-event-mux`
- threshold: 85
- steps:
  1. 在真实 UI/事件输出上同时跑三流，记录 `agent.subscribe` 输出和复用器输出；任何时刻输出序列中最多一个 open message，工具事件只在两条 message 之间。
  2. 让 A 持有租约并 slow stream，B/C 完成整段；Holding 的事件逐字原样转发。释放租约后 B/C 按完成顺序回放为 start → 一次 final update → end，工具 update 每 id 只留最新快照。
  3. 拔掉复用器重跑完整单流 N=1 场景，逐事件比对 type/order/payload，毫秒抖动内一致；界面输出也一致。
  4. 做一次嵌套外层与内层同时流式，确认全会话只有一个 FIFO/租约；状态条 label 带 `batch.0/batch2.1`；取消、Esc、审批归属跨层处理。
  5. 把结果交给扮演用户的 actor，请他看屏回答：“这是不是一条线？单流时是不是和以前一样？”
- expected: 单流 UI 行为不变；复用器恒等来自租约/FIFO 状态，不来自 length 分支；嵌套仍单 open。
- rubric: 100 = 四步全对，N=1 完全恒等；90 = 一个时序细节有毫秒差但顺序内容相同；85 = 单 open、回放、单流恒等都成立；84 = 工具 update 中间帧未压缩但 UI 正常；75 = N=1 丢帧或延迟；0 = 两 message 同时 open。未录屏/逐事件记录扣 5；未拔掉复用器对拍扣 5；未跑嵌套扣 5；未测取消和审批扣 5。hard fail：`flows.length === 1` 分支。双侧 WTP，final = min。

## CASE-09

- case_id: CASE-09
- path: `/tmp/fission-accept/09-heir-and-recursion`
- threshold: 85
- steps:
  1. 两流中让非 0 号最后结束；在它结束前给另一条流开内层 batch，内层开到一半时确认外层不抄写，内层结束且子树 closed 后外层才抄一次并包含内层全部 entry。
  2. 最后一条流结束时，观察六步顺序：先收前驱段、自己的 scope.end、批次 scope.end、owner agent reset/splice/setModel/branch、提升 flow state、释放非继承者。
  3. 检查活动叶、owner agent messages、todo/pins/budget/relay、下一步用户输入由继承者接收；owner 不再产生 provider 请求；模型身份来自继承者。
  4. 重复一轮让 0 号最后结束，再重复一轮 N=1，确认继承者可以是任何编号，且 N=1 前后是同一条线换驱动者。
  5. 把结果交给扮演用户的 actor，请他接着发一条普通消息，判断接管是否自然。
- expected: 子树完成语义；最后结束者继承；六步严格有序；无编号特权。
- rubric: 100 = 三种结束顺序 + 内层 + 用户输入全过；90 = 顺序正确但某个 flow state 字段无显示证据；85 = 非 0 继承与子树门成立；84 = 未验证 model 或 branch；75 = 内层未关就抄；0 = owner 继续生成或继承者未接管。未测非 0 继承扣 5；未测 N=1 扣 5；未发下一条输入扣 5。hard fail：scope 未关闭导致模型以为仍在 scope 内。双侧 WTP，final = min。

## CASE-10

- case_id: CASE-10
- path: `/tmp/fission-accept/10-broadcast`
- threshold: 85
- steps:
  1. 两流同时跑时向会话输入一句包含独特 token 的话；检查两条流的实际 agent messages 都出现它，正文以 `(broadcast to 2 flows)` 开头，details 里同一 broadcastId 与 recipients labels。
  2. 看屏幕，独特 token 只出现一次；UI 复用器按 broadcastId 去重，第一次显示的位置稳定。
  3. 让一条流在消费广播前声明完成/取消；观察未消费 copy 被撤回或沿 leaf 重投，不产生幽灵 turn。若无活流接手，交给 owner 时区分 accepted-with-error / failed / unknown 三种 warning，原文保留。
  4. 先结束一条流，确认该广播不在抄写段里重复；接收方上下文中同一 broadcastId 只有一份。
  5. 把结果交给扮演用户的 actor，请他确认自己只被问了一次。
- expected: 广播标注、去重、不转发两次、未能交付有可见 warning。
- rubric: 100 = 所有 copy/warning/上下文与屏幕全对；90 = 一类 warning 文案略粗；85 = 正常广播显示一次且不抄；84 = accepted-with-error 未单独测；75 = 某流重复看到或幽灵 turn；0 = 用户原文丢失且无 warning。未模拟未消费 copy 扣 5；未查 owner 通道扣 5；未查抄写后数量扣 5。hard fail：重投造成两次屏幕显示。双侧 WTP，final = min。

## CASE-11

- case_id: CASE-11
- path: `/tmp/fission-accept/11-ledger-and-amend`
- threshold: 85
- steps:
  1. 在 fission 内调用 `amend`，检查返回 `AMEND_UNAVAILABLE_IN_FISSION`，并说明会覆盖别流追加；确认文件未被重写。
  2. 检查抄写白名单：session_init、credential_pin、ttsr_injection、reset_boundary、compaction、fission.* 不进入被抄段；compaction 改为裁剪窗口摘要 CustomMessage；未被排除的 message/custom/model_usage/label/thinking_level/mode_change/branch_summary 按序进入。
  3. 检查 pin 合并进 `session.pins` 并按规范去重，defer 只留流内且终止时留审计，不抄给接收方。
  4. 检查 `model_usage` owner.parentId 经过 mapId，`activeLeafId` 清除，段外引用仍指向旧段。
  5. 把结果交给扮演用户的 actor，请他判断：“审计账没有变成模型对话，pin/defer/amend 的边界是否可信？”
- expected: amend 明确拒绝；白名单/裁剪正确；跨流 pin/defer 语义正确。
- rubric: 100 = 四步全成立且无多余 entry；90 = 一种被排除类型未明确观测但结果正确；85 = amend 拒绝和 fission.* 排除正确；84 = pin 去重只按文本未验规范字段；75 = compaction 被照抄；0 = amend 重写共享文件。未跑 amend 扣 5；未看 model_usage owner 扣 5；未看 defer 审计扣 5。hard fail：任何账本消息进入接收方上下文。双侧 WTP，final = min。

## CASE-12

- case_id: CASE-12
- path: `/tmp/fission-accept/12-status-tokenrate-approval`
- threshold: 85
- steps:
  1. 两流同时产出 usage，观察状态条：单值字段（usage/context/token rate/model/current tool）显示最近一次请求，累计 token/花费是总和；两条流都更新状态，不因 `kind:"sub"` 或 `depth > 0` 被 `showUsage` 直接跳过。
  2. 故意让 flow sessionManager 是共享 manager 的 fission proxy，核对 `keyFor(ctx)` 必须解析到**共享** manager，所有 proxy 累计落在同一会话记录，不能拆成 N 份。
  3. 让两流一快一慢产生不同 token rate；最近写入的速率必须转给主 session/状态条，不能停在主 agent 空闲时的旧值。
  4. 触发需要审批的工具，弹窗写出请求方 label；审批结果只作用于请求方，不误放行另一条 flow；嵌套时 label 带路径。
  5. 把结果交给扮演用户的 actor，请他看状态条和弹窗回答：“是否能分辨是哪条流在花钱和请求权限？”
- expected: 四个缺口修复；状态条既不丢流也不拆账；审批可归属。
- rubric: 100 = 四项全部实证，且 label 路径清晰；90 = 有一个显示细节例如 rate 滞后半拍但不误导；85 = 状态条累计不拆、flow 不被 sub 跳过、rate 有更新、审批有 label；84 = 审批 label 无路径；75 = tokenRate 仍停留旧值；0 = 状态条完全不更新或因 proxy 拆账。未用 proxy 复现扣 5；未让两流速率不同扣 5；未跑审批扣 5。hard fail：给 flow 设置 `kind:"sub"` 作为实现捷径。双侧 WTP，final = min。

## CASE-13

- case_id: CASE-13
- path: `/tmp/fission-accept/13-single-flow-parity`
- threshold: 85
- steps:
  1. 在当前版本运行一次单流任务：开普通 scope，读文件，调用 `scope({ end:true })`，记录剩余预算、todo/relay 行为、逐事件 UI 输出。
  2. 在同一会话调用 `scope({ begin: { stage: "direct-execution", elder_report: null, fission: [{ intent: "唯一流", budget: {...旧预算...}, permission: "rw" }] } })`，让唯一流执行相同工作。
  3. 检查实现中不存在 `flows.length === 1`、`N === 1` 或任何等价单流分支；租约无人争用、FIFO 恒空、handoff 队列为空、无抄写/重命名/注入。
  4. 比较两次预算余额、todo/relay、屏幕输出；差异仅允许“多一层子 scope”及其收据，用户不可见差别为零。
  5. 把结果交给扮演用户的 actor，请他判断：“机制和单流旧行为是否一致？”
- expected: N=1 是状态退化，不是代码分支。
- rubric: 100 = 行为一致、无分支、结构差异解释清楚；90 = 结果一致但一份日志标签不同；85 = 预算/todo/relay/UI 一致且无分支；84 = 没有全文搜索等价分支证据；75 = 出现仅单流可用的特判；0 = N=1 失败。未跑旧路径扣 5；未跑 fission 单元素扣 5；未搜分支扣 5。hard fail：用 length 分支实现恒等。双侧 WTP，final = min。
