# OMP ↔ DeerFlow 同层协议契约与视觉映射艺术规范

本文件隶属于 [SKILL.md](./SKILL.md)，定义 `host-omp-ui` 的完整 HTTP/WS 同层线协议与“官方 omp 能力 ↔ DeerFlow UI 组件库”的精确视觉映射，供后端 Station/Server、前端 SPA 与契约测试共同遵循。

---

## 一、同层 HTTP 端点契约

管理器是**全机单例**：默认绑定 `127.0.0.1:37421`（`OMP_UI_PORT` 可覆盖），不因占用而回退随机端口。端口被非本产品占用时健康探测必须失败并给出明确诊断；后续 `omp` 以受鉴权的实例连接注册，不再各自监听端口。管理器由首个启动的 `omp` 建立，最后一个实例注销后释放端口。token 持久化在用户私有运行目录（权限 `0600`），所有实例与浏览器共用；`/api/health` 与 `/api/manager/identity` 免鉴权，只暴露管理器存在与产品身份，不泄露会话数据。除标注“免鉴权”外，所有 `/api/*` 与 `/ws` 均校验 `Authorization: Bearer <token>` 或 query `?token=<token>`，未通过返回 `401 { ok: false, error: "unauthorized" }`。浏览器来源应限制为同源 loopback。

| 方法与路径 | 鉴权 | 响应契约 |
|---|---|---|
| `GET /` | 免鉴权 | 返回 `web/dist/index.html`（`text/html; charset=utf-8`）；静态产物缺失时返回清晰提示页而非崩溃 |
| `GET /dist/*` | 免鉴权 | 返回 `web/dist/*`（`app.css`、`main.js`、chunks）；缺失时回退到静态根同名文件，带路径穿越防护与正确 MIME |
| `GET /assets/*` | 免鉴权 | 返回 `web/dist/assets/*` 静态字体/图片等（带路径穿越防护与正确 MIME） |
| `GET /api/health` | 免鉴权 | 管理器存活探测，不泄露会话数据 |
| `GET /api/manager/identity` | 免鉴权 | `200 { name: "herd-omp-ui-manager" }`：只用于识别固定端口上的本产品管理器，不是鉴权凭证 |
| `GET /api/bootstrap` | 需 token | `200 { instances }`：实例注册摘要；会话正文只由浏览器选中实例后的权威 `snapshot` 提供，bootstrap 不冒充 snapshot |
| `GET /api/instances` | 需 token | 当前注册实例数组（`instanceId`、pid、session、cwd、sessionDir 等活动摘要） |
| `GET /api/sessions` | 需 token | 全机会话摘要，包括身份、原工作目录与活动实例；只读扫描 JSONL 头，不调用 `SessionManager.open`，不占用会话所有权，也不是历史只读预览 |
| `WS /ws?token=...` | 需 token | 升级为全双工 JSON 帧通道；按客户端选择的实例提供 `snapshot` 和后续事件；闲置会话通过 `manager.open_session` 唤醒 |
| `WS /agent?token=...` | 需 token + 同源 Origin | 实例代理注册、会话更新与帧转发；注册必须携带可信 `instanceId`、pid、session 与 sessionDir |

---

## 二、同层 WebSocket 帧契约

所有帧均为 JSON 对象：`{ type: string, seq?: number, ts: number, payload: object }`。

### 2.1 下行帧（Server → Web）

| `type` | `payload` 精确结构 | 语义 |
|---|---|---|
| `snapshot` | `{ session: { id, file, title, cwd }, messages: UiMessage[], streaming: StreamingState \| null, artifacts: UiArtifact[], todos: TodoPhase[], queue: { steering: string[], followUp: string[] }, usage: UsageState, meta: MetaState, draft: DraftState, interactions: InteractionRequest[], widgets: WidgetEntry[], surface: SurfaceSnapshot }` | 连接建立或重连/切会话时一次性同步全量真相 |
| `manager.instances` | `{ instances: Array<{ instanceId, pid, session, cwd, sessionDir }> }` | 全机活跃实例列表；新浏览器据此建立入口 |
| `manager.sessions` | `{ sessions: Array<{ id, path, cwd, title, modified, origin }> }` | 管理器聚合的全机历史目录权威来源，不随任何实例 snapshot 收缩 |
| `transcript.delta` | 判别联合 `kind`:<br>• `"message_start"` `{ message }` <br>• `"text_delta"` `{ messageId, contentIndex, delta }` <br>• `"thinking_delta"` `{ messageId, contentIndex, delta }` <br>• `"toolcall_delta"` `{ messageId, contentIndex, toolCallId, toolName?, argsDelta?, args? }` <br>• `"message_end"` `{ message }` <br>• `"tool_execution_start"` `{ toolCallId, toolName, args }` <br>• `"tool_execution_update"` `{ toolCallId, toolName, partialResult }` <br>• `"tool_execution_end"` `{ toolCallId, toolName, result, isError, artifact? }` <br>• `"agent_end"` `{ messages, settled }` | 对话与工具流式增量；`agent_end` 仅用于结束态与一致性校正，不重复追加已落盘消息 |
| `todo.update` | `{ phases: Array<{ name: string, tasks: Array<{ content: string, status: "pending" \| "in_progress" \| "completed" \| "blocked" \| "abandoned" }> }> }` | Todo 清单更新 |
| `usage.update` | `{ tokens: { input, output, cacheRead, cacheWrite, total }, cost: { total }, context: { tokens, contextWindow, percent } \| null }` | Token、费用与上下文窗口占用更新 |
| `meta.update` | `{ model?: ModelRef, thinkingLevel?: string, thinkingLevels?: string[], modes?: SessionModesState, title?: string, status?: Record<string, string>, working?: string \| null, busy?: boolean }` | 头部与底栏状态增量更新 |
| `draft.sync` | `{ rev: number, origin: "tui" \| "web", text: string, cursor: { line: number, col: number }, images: ImageSummary[], texts: TextAttachmentSummary[], composer: ComposerFlags }` | TUI ↔ Web 输入条草稿同步 |
| `interaction.open` | `InteractionRequest`: `{ requestId, kind: "formDialog" \| "askDialog" \| "approve" \| "select" \| "confirm" \| "input" \| "editor" \| "plan_review", createdAt, title?, message?, ...kindPayload }` | 弹出停靠在输入框上方的互动卡片 |
| `interaction.close` | `{ requestId: string, resolvedBy: "tui" \| "web" \| "abort" \| "timeout" }` | 任一端完成或取消后立刻收起互动卡片 |
| `toast` | `{ level: "info" \| "success" \| "warning" \| "error", message: string, source?: string }` | `ctx.ui.notify` 与 `notice` 轻量通知 |
| `widget.update` | `{ key: string, placement: "aboveEditor" \| "belowEditor", lines: string[] \| null }` | `ctx.ui.setWidget` 字符串数组镜像（`null` 表示移除） |
| `surface.frame` | `{ sf: string, s: number, ops: TspOp[], overlays: OverlaySummary[], fallbackAnsi?: string[] }` | `Reconciler` 产出的 `TspOp[]` 与活跃 `overlayStack` 摘要 |
| `session.switched` | `{ reason: "new" \| "switch" \| "branch" \| "clear", sessionId: string, snapshot }` | 会话切换/清空/分支重置全量刷新 |

### 2.2 上行命令（Web → Server）

状态变更命令携带请求标识，并接收关联的 `command.result { requestId, ok, code?, value? }`；失败向发起者可见，不将无回执的操作视为成功。模型、思考档位和模式以宿主回读的实际状态更新 `meta.update`。管理器用 `manager.select` 选择活跃实例，用 `manager.open_session` 复用实例或启动闲置历史会话；新实例注册并发来快照后才切换视图，旧实例的帧不得串入。交互请求自身的 `requestId` 与命令关联标识应区分。

| `type` | `payload` 精确结构 | 服务端动作 |
|---|---|---|
| `manager.select` | `{ instanceId, requestId }` | 切换浏览器到指定活跃实例；先清空旧视图，权威 `snapshot` 到达后再放行增量 |
| `manager.open_session` | `{ sessionId, requestId }` | 复用持有该会话的实例；否则在可信原 cwd 启动真实 `omp --resume`，注册完成才回执成功 |
| `manager.new_session` | `{ cwd, requestId }` | 在已注册实例的可信 cwd 启动不带 `--resume` 的真实 `omp`，注册完成才成功；不复用或覆盖已有会话 |
| `composer.draft` | `{ rev: number, text: string, cursor?: { line: number, col: number } }` | 经 `draft.mjs` 仲裁防回环后同步写入 `BridgeEditor` |
| `composer.submit` | `{ text: string, mode?: "default" \| "steer" \| "followUp" }` | `"default"` 走 `BridgeEditor.submit()`（等价 TUI Enter，支持 slash commands/队列/`!`/`$`/`/btw`）；`"steer"`/`"followUp"` 在流式时通过 `pi.sendUserMessage(text, { deliverAs })` 精确投递 |
| `session.abort` | `{}` | 调用 `ctx.abort()` 立即中止当前流式生成 |
| `session.set_model` | `{ provider: string, modelId: string }` | 经 `ctx.models.resolve` + `pi.setModel` 切换模型并广播 `meta.update` |
| `session.set_thinking` | `{ level: string }` | 调用 `pi.setThinkingLevel(level)` 并广播 `meta.update` |
| `session.set_mode` | `{ mode: "plan" \| "vibe" \| "goal" \| "loop", action: string, objective?: string, tokenBudget?: number, prompt?: string }` | 调用 `ctx.sessionModes.set(payload)` 并广播 `meta.update` |
| `interaction.respond` | `{ requestId: string, cancelled?: boolean, value?: unknown, data?: Record<string, string \| number \| string[]>, answers?: unknown[], choice?: string, input?: Record<string, unknown> }` | 校验 `requestId` 归属当前活跃竞速后 resolve Web 分支，触发 `AbortController` 关闭 TUI 弹窗 |
| `surface.event` | `{ ev: string, sf: string, id: string, [key: string]: unknown }` | 通过 `Reconciler.target(id)` 路由至目标组件 `handleNativeEvent` |
| `surface.keys` | `{ data: string }` | 透传安全受限的终端键序列至 `tui.injectDebugInput(data)` |

---

## 三、完整视觉映射艺术表（复用 DeerFlow UI 体系）

全部视觉元件直接复用 `../deer-flow/frontend/src/components/ui/*`、`ai-elements/*` 与 `src/styles/globals.css` 语义色变量。

### 3.1 页面框架与分组规则

- **整体骨架**：`ui/sidebar`（左侧会话栏：活实例置顶 + 全机历史会话列表）+ 居中阅读画布（`ai-elements/conversation` `max-w-3xl`）+ 底部悬浮交互与输入区（`DockInteractionCard` → `TodoList`/`Queue` → `ComposerBar`）+ 右侧按需展开抽屉（`ArtifactDrawer` 与 `SurfaceMirrorPanel`，Tab 切换）。
- **消息分组艺术**：
  - **User 组**：`ai-elements/message`（`from="user"`），右对齐圆角气泡，支持图片预览与 `@file` 芯片。
  - **中间执行过程组（Processing Group）**：同一轮内连续的 `thinking` + `toolCall`/`toolResult` 自动聚合进一个 `ai-elements/chain-of-thought`（`ChainOfThought`），运行中展开显示脉动步骤，最终回复生成后自动折叠为精炼摘要行（如“已执行 4 步 · 6.2s”），点击随时展开。
  - **Thinking 块**：`ai-elements/reasoning`（`Reasoning` + `ReasoningTrigger` + `ReasoningContent` + `Shimmer`），思考中自动展开，正文开始或结束自动收起。
  - **Assistant 最终回复**：`ai-elements/message`（`from="assistant"`）+ `ai-elements/streamdown`（Markdown、GFM 表格、LaTeX、高亮代码块、安全外链），底部悬浮一键复制按钮。
  - **特殊系统/会话条目**：
    - `bashExecution` / `pythonExecution`（独立 `!`/`$` 执行）：独立卡片，上部 `CodeBlock` 命令，下部 `ui/terminal` 风格安全 ANSI 输出，带 `excludedFromContext` 微标。
    - `compactionSummary` / `branchSummary`：居中细分割线 + 可折叠摘要胶囊（`ui/collapsible`）。
    - `custom` 消息：中性圆角微卡片，保留 `customType` badge。

### 3.2 工具卡片艺术映射

| omp 工具 | DeerFlow 原语与视觉设计 | Artifact 联动 |
|---|---|---|
| `read` | `ChainOfThoughtStep` + `FileText` 图标 + 路径/行号徽标；展开 `CodeBlock` 按后缀高亮 | 点击路径在右侧 Artifact 抽屉打开完整读取预览 |
| `write` | `ChainOfThoughtStep` + `FilePlus` 图标 + 路径与行数徽标；展开 `CodeBlock` | 自动登记至 `artifacts`，点击在右侧抽屉查看全文 |
| `edit` | `ChainOfThoughtStep` + `FileDiff` 图标 + 路径徽标；展开呈现红绿行级 Diff（`- old_string` 红底、`+ new_string` 绿底，带行号） | 自动登记至 `artifacts`，点击在右侧 Diff 抽屉大屏对比 |
| `bash` | `ChainOfThoughtStep` + `Terminal` 图标 + `args.description` 或首行命令；展开上部 `CodeBlock(bash)` + 下部安全 ANSI 彩色流式输出区与退出码徽标 | — |
| `eval` | `ChainOfThoughtStep` + `Code2` 图标 + `py/js` 徽标与 `title`；展开 `CodeBlock` + 控制台输出 + 内联图片 | 若产出图像则登记至 `artifacts` |
| `grep` / `glob` / `find` | `ChainOfThoughtStep` + `Search` 图标 + `pattern`/路径徽标；展开为紧凑文件命中列表 | — |
| `web_search` | `ChainOfThoughtStep` + `Globe` 图标 + 查询词；展开为安全外链卡片列表 | — |
| `todo` | 时间线极简一行提示；完整分组清单同步渲染在底部 `ai-elements/queue` 折叠面板（`in_progress` 主色脉动、`blocked` 警示红、`completed` 划线） | — |
| `task` | 复用 `ai-elements/task`（`Task` / `TaskTrigger` / `TaskContent`）独立子任务卡：展示名称、状态、目标简报、流式更新与最终结论 | — |
| `ask` | 等待态在底部 `DockInteractionCard` 展示原生结构化表单；回答后时间线展示 `FormCard` KV 摘要表 | — |
| 其他 / MCP / 扩展工具 | 通用 `ToolCallDetails`（`ui/collapsible`）：优先以 `args.description` 为标题，展开展示格式化 JSON Input / Result（可复制，失败标红） | — |

### 3.3 人机交互停靠卡片（`DockInteractionCard`）

| `kind` | 控件组成与约束 |
|---|---|
| `formDialog`（`ask` 工具） | 消费 `station/domain/html-form.mjs` 解析出的 AST（`<fieldset>`/`<legend>`、段落说明、`text`/`textarea`/`number`/`date`/`email`/`url`/`radio`/`checkbox`/`select`）；**严格遵守 omp 表单契约**：(1) 绝不使用 `innerHTML`；(2) 多于 1 项且无同名 `Other` 选项的 radio/checkbox 组自动附加“其他”自由输入项；(3) 提交前校验 `required`（纯空白算空）、`min`/`max`、`minlength`/`maxlength`、`email`/`url`、`pattern`（全串锚定），不合法行内标红阻止提交。 |
| `approve`（工具审批） | 展示 `toolName`、`reason`、命令/路径详情与高亮风险提示；按钮：**允许本次 (`once`) / 本会话允许 (`session`) / 拒绝 (`deny`)**，支持 `grants` 列表与“跨会话记住” `ui/switch` 开关及可选拒绝原因。 |
| `plan_review` | 计划标题 + 可滚动 Markdown 计划书预览 + 可选 `tiers` 模型档位 `ui/select` + 按钮组（**Execute / Compact / Keep / Refine / Save**）；点击 Refine 展开必填反馈 `ui/textarea`。 |
| `select` | 选项列表（展示 `label` 与 `optionDetails.description`、`initialIndex` 默认高亮；支持 `selectionMarker: "checkbox"` 多选确认与单选即点即选）。 |
| `confirm` | 标题 + 提示文本 + 确认/取消主次按钮（支持 Enter/Esc）。 |
| `input` | 标题 + `placeholder` + `ui/input`；`secret: true` 自动使用 `type="password"` 且屏蔽日志。 |
| `editor` | 标题 + 等宽多行 `ui/textarea` + `Ctrl/Cmd+Enter` 提交。 |
| `askDialog` | 多问题结构化卡片，标出 `recommended` 项，支持单选/多选 + 自动“其他”自由输入。 |

### 3.4 右侧 Artifact/Diff 抽屉与兜底 TUI Surface 视窗

- **Artifact / Diff 抽屉**：当用户点击 `read`/`write`/`edit` 工具卡片或顶部 Artifact 按钮时，右侧滑出面板展示代码高亮全文或红绿大屏 Diff，支持切换同会话全部已记录文件工件与一键复制。
- **兜底 TUI Surface / Overlay 视窗**：
  - 订阅 `surface.frame` 并用 `web/src/state/tsp-doc.ts` 归约 `TspOp[]`（必须正确处理 `settle` 清理已退休节点）。
  - 检测到 `overlays` 非空且不属于上述已由 `DockInteractionCard` 接管的语义弹窗（例如 `/settings`、`/tree`、`custom()` 扩展组件）时，自动提示可展开的 TUI Overlay 互动视窗：
    - 结构化 `TspKind` 节点（`col`/`row`/`card`/`text`/`md`/`list`/`item`/`button`/`input`/`table`/`kv`/`badge`/`tabs`/`progress`）直接映射为 DeerFlow `ui/*` 元件，点击回发 `surface.event`；
    - 无 `describe()` 的 `rows` 节点以 `ui/terminal` 质感暗底等宽画布渲染安全 ANSI spans，并附带快捷按键栏（`Esc`、`↑`、`↓`、`Tab`、`Enter`、`Ctrl+O`）及聚焦键盘直通发送 `surface.keys`。
