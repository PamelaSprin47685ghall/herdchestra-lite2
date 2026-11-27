---
name: omp-deerflow-bridge
description: Architecture, Ticket Station boundaries, TUI fence constraints, and DeerFlow UI reuse specification for the standalone host-omp-ui plugin. Load before writing or editing any host-omp-ui backend, fence, test, or web renderer code.
---

# OMP ↔ DeerFlow 同层前端桥设计记录

本技能是独立插件 `host-omp-ui`（包名 `herdchestra-host-omp-ui`）的单一架构真相源。核心原则：**不伪装 DeerFlow/LangGraph 后端、不改 `../oh-my-pi` 与 `../deer-flow/frontend` 源码，在 omp TUI 边界放篱笆收门票，直接复用 `../deer-flow/frontend` 的 UI 组件库与视觉体系自写同层渲染逻辑**，让官方 `omp` 同时在 TUI 与 Web 端完整运行。

- 同层 HTTP/WS 协议契约与视觉/交互映射规范见 [mapping-artistry.md](./mapping-artistry.md)。
- 真实 TUI + 浏览器端到端手工验收环见 [../manual-acceptance/SKILL.md](../manual-acceptance/SKILL.md) 与 [../manual-acceptance/web-tui.md](../manual-acceptance/web-tui.md)。

## 目标与非目标

**目标（用户侧）**：
仅安装 `host-omp-ui`（不依赖 `host-omp`）即可在固定端口打开本机 Web 管理器。Web 是用户入口，不是 TUI 的附属：它列出并管理本机所有运行中的 `omp` 实例，可查看任一实例的对话、切换模型与思考档位、提交输入、回答 `ask` / 工具审批 / Plan Review / `select` / `confirm` / `input` / `editor`（先答者胜、输家即时关闭），并在同一视图内与该实例的 TUI 实时同步。对话正文、Thinking、工具卡片、Artifact/Diff 抽屉、Todo、上下文用量与兜底 TUI Surface 视窗保持原设计。

会话列表覆盖全机所有历史会话，不限于当前进程的工作目录。打开没有活跃实例的会话时，管理器在该会话原始工作目录中用 `tmux` 启动真实 `omp --resume`；用户可随时 `tmux a` 进入同一会话，与手动启动等价。启动期间 Web 显示等待态，实例注册后接管视图。

固定端口由首个启动的 `omp` 建立管理器，最后一个已注册实例退出后释放；后续 `omp` 作为实例注册，不各自监听端口。**所有加载了本插件的 OMP 主会话都注册**，包括 TUI、RPC 与 print；仅 `ctx.agent.kind === "sub"` 的子代理不注册。注册帧公开 `mode` 与 `capabilities`（`canCompose`、`canUseTuiSurface`、`canAttachments`、`canSlashCommands`）：TUI 有完整编辑与 Surface；RPC/print 无 TUI 编辑器时仍可经宿主 `pi.sendUserMessage` 提交普通文本，但附件、斜杠命令与 TUI Surface 必须返回明确的不可用提示，不得伪装成功或污染 RPC stdout。TUI 篱笆、editor 安装、UI 装饰与 surface 捕获只在 `mode === "tui" && hasUI` 时执行。所有状态变更命令都有请求关联的回执，界面以宿主实际状态为准更新，而不是单向发送后等待副作用。

边界：未加载本插件的 OMP（如 `--no-extensions`、其他插件集启动的进程）不执行上述注册。当前管理器没有进程发现机制，也不把这些进程计入实例列表或首末实例生命周期；插件无法在不修改官方 OMP、不注入其 pty 的前提下控制其实时会话。Web 不会把它们标记为“未托管实例”，只能经只读 JSONL 扫描看到其会话历史；点击历史会在原 cwd 另起一个加载了插件的真实 `omp --resume`，不得声称操纵原进程。print 单次执行后自然退出，RPC 遵守其 stdin 生命周期。

**非目标**：
- 不伪装 LangGraph SDK 或 DeerFlow Gateway REST 后端，不起 Next.js 独立进程。
- 不接入 `host-omp` 的自定义 scope/fork 树或审计总线；`host-omp` 与 `host-omp-ui` 保持 100% 正交。
- 不修改 `../oh-my-pi` 或 `../deer-flow/frontend` 仓库内任何源码文件（仅可在 `../deer-flow/frontend` 执行一次性 `pnpm install` 供打包解析依赖）。
- 历史会话不再有“只读预览”这一独立模式；打开即确保真实实例，失败时显示可操作的错误，不用伪可编辑界面掩盖。
- 固定端口被非本产品占用时不静默回退随机端口；给出明确诊断和 `OMP_UI_PORT` 指引。

## 系统托盘

管理器存活期间（首个 `omp` 建立管理器到最后一个实例退出）在桌面托盘显示**一个**图标。左键点击用系统默认浏览器打开固定 Web 入口（`http://127.0.0.1:<port>/?token=...`）。托盘只在管理器 leader 中创建；leader 迁移时先销毁旧图标、再释放端口，接手者创建新图标，任何时刻最多一个。托盘是入口的便利层，不是状态源：图标缺失只影响点击入口，不影响 Web 服务。

托盘能力不可用、运行时依赖缺失、`create`/`destroy` 失败或默认浏览器打开失败时，只写诊断并继续服务，绝不抛到 `omp` 主进程。

跨平台实现收在 `host/system-tray.mjs` 的 adapter 内；`host/manager-tray.mjs` 只负责生命周期、打开 URL 与诊断，二者异步契约由 `tests/host-omp-ui/tray-contract.test.mjs` 锁定（`create`/`destroy` 必须可 `await`，启动中收到 `stop` 不得留下迟到图标）。

| 平台 | 实现 | 运行时依赖 |
|---|---|---|
| Linux | StatusNotifierItem 的 `Activate` | Python 3 + PyGObject + 托盘 watcher |
| macOS | `NSStatusBarButton` 的 action | 系统 `swift` |
| Windows | WinForms `NotifyIcon.MouseClick` | PowerShell |

**验证状态**：只有 Linux 做过本机实测；macOS 与 Windows 路径未实测，发布前必须逐平台验收图标可见与左键激活。不采用常见 npm 托盘库作为主路径，因为它们的点击通常挂在菜单项上，不能保证图标左键直接激活。

## 模块边界与 Ticket Station 分层

`host-omp-ui` 严格遵守 `AGENTS.md` 的 Ticket Station Method：**状态不变式与复杂轻计算归 Station 及其纯领域核，跨 `await` I/O 与外部协作归瘦 Ticket，宿主深路径细节隔离在 `host/`，组合根 `activation/` 严禁业务逻辑。**

```text
host-omp-ui/
  package.json                        # 独立插件 herdchestra-host-omp-ui，omp.extensions: ["./src/main.mjs"]
  # 构建入口：cd host-omp-ui && bun run build:web（= bun web/scripts/build.mjs），产物 web/dist/
  src/
    main.mjs                          # 唯一入口 activate(pi, env)（纯启动排序，零业务）
    station/
      ui-bridge-station.mjs           # 充血聚合根 UiBridgeStation（严禁 async/await；三段式 Compute→Commit→Dispatch）
      domain/                         # 14 个纯无状态领域核（零 I/O、零 @oh-my-pi/* 依赖）
                                      # 新增：history-window（分页窗口索引/切片）、artifact-hydration（toolCall 判定与分块 artifact 投影）、fence-lifecycle（篱笆启停纯决策）、snapshot-doc（快照纯投影）
        protocol-codec.mjs            # 同层 WS 上/下行帧与 HTTP payload 的 schema、校验、构造；token 提取与路径穿越校验
        transcript-model.mjs          # SessionEntry/AgentMessage/AssistantMessageEvent/tool_execution_* 归约、toolCall 配对与显示分组
        tool-artistry.mjs             # 工具卡片艺术映射（read/write/edit diff/bash/search/web/todo/task/ask/generic）、artifact 提取、ANSI strip 与行级 diff
        html-form-parser.mjs          # 安全 HTML <form> 解析（含 Other 自动选项规则）、表单约束强校验与 FormAnswer 构造
        interaction-race.mjs          # TUI ↔ Web 双路竞速账本（先答者胜、晚到幂等拒绝、关闭后不可再答）
        surface-fence.mjs             # TspOp[] 文档归约、overlay 摘要提取与 TspEvent 路由校验
        draft-arbiter.mjs             # 双向草稿仲裁（跨源回环检测、rev 推进）；Station 只提交
        history-page.mjs              # 历史分页窗口与回合起点对齐的纯决策
        meta-normalize.mjs            # meta 补丁归一化（model 字符串/对象、thinkingLevel/level 折叠）
        snapshot-fit.mjs              # 快照整形：按字符上限截断文本并收缩历史直到装满一帧
      # 注：双向草稿仲裁归 domain/draft-arbiter.mjs，ui-bridge-station.mjs 的 applyDraft 只提交状态；ANSI 解析归 tool-artistry.mjs 的 stripAnsi。
    host/
      tui-fence.mjs                   # TUI 篱笆：Composer.prototype.renderFrame/setEditor 捕获、Object.defineProperty 装饰 ctx.ui、BridgeEditor、Reconciler + overlayStack + injectDebugInput
      session-adapter.mjs             # omp 宿主会话、模型、上下文用量与模式适配；历史只读扫描，不打开会话争锁
      manager-client.mjs              # 实例注册/心跳/重连，将宿主状态与命令交由管理器路由
      client-command.mjs               # 宿主命令适配：interaction.respond 在 Plan Review 工单与普通交互桥之间选择，其余命令单跳入 Station；组合根以 getter 注入迟到绑定字段
      manager-tray.mjs                # 托盘生命周期、默认浏览器打开与诊断（异步 adapter 契约）
      system-tray.mjs                 # 跨平台托盘 adapter：Linux StatusNotifierItem / macOS NSStatusBar / Windows NotifyIcon
      launch-context.mjs              # 一次性 0600 启动凭据（port/token）与陈旧文件清理
      tmux-launch.mjs                 # tmux 启动结果判定：会话存活时不因后续命令失败误删凭据
      diagnostics.mjs                 # 宿主诊断记录
      tickets/                        # 工单协程，调用方直接 import；转发桶已删除
        host-tickets.mjs              # 宿主工单协程（提交、模型/模式切换、广播、计划评审等），每个方法至多跨一次 await，失败不外抛
        interaction-bridge.mjs        # Web ↔ TUI 对话桥：待决交互账本、双路竞速与幂等中止
        dialog-protocol.mjs           # 纯对话协议映射：TUI 位置参数 → Web typed payload，Web 答案 → 原生 TUI 结果
        fence-ticket.mjs              # TUI 篱笆安装与退出序列的异步执行
        delta-merger.mjs              # transcript 增量合并的定时调度（在 Station 之外）
    manager/                          # 全机管理器
      server.mjs                      # 固定端口 loopback、浏览器/实例 WS 路由、鉴权、静态托管与生命周期
      machine-catalog.mjs             # 只读扫描全机 JSONL 会话头，跨项目、续写链与自定义 session-dir
      session-service.mjs             # 按会话 id 单飞复用或启动真实 omp，等待注册而非 spawn 即成功
      domain/session-catalog.mjs      # 会话规范化和 tmux new/resume 启动计划（默认 socket、保活、安全 argv）
    activation/
      index.mjs                       # 纯机械组合根：实例化 Station/Adapter/Fence/实例连接，绑定事件与命令，退出时清理
      tickets.mjs                     # 工单能力工厂与统一命令回执（保留 clientId/requestId，状态以宿主回读为准）
      hooks.mjs                       # 机械事件转发：pi.on(...) → station.onXxx(...)
      commands.mjs                    # 注册 /web 命令打印访问 URL 与状态
  shared/                             # 同构纯 ESM（零 Node/DOM API），Node 侧与 Web 侧共用同一实现
    tool-view.mjs                     # 工具卡片投影、ANSI strip、行级 diff、REPL echo 的唯一实现
    transcript-groups.mjs             # isRealUser 与显示分组谓词
  web/                                # 同源 React 19 SPA（直接复用 ../../deer-flow/frontend/src/components/ui/*、ai-elements/*、styles/globals.css）
    package.json                      # 独立精简依赖（含 @tailwindcss/cli）；install:safe 把 node_modules 软链到 ${TMPDIR}，避开 /home 空间红线
    tsconfig.json                     # jsx: react-jsx，@/* → ../../../deer-flow/frontend/src/*
    scripts/build.mjs                 # Bun.build（自定义 onResolve：node:* external、@/ 先查 shims 再映射 deer-flow src、bare 包自 web/node_modules）+ Tailwind CLI → web/dist/
    src/index.html
    src/styles/app.css                # 整份复刻 globals.css（:root/.dark/@theme inline）+ 修正 @source 路径
    src/protocol/                     # types.ts、store.ts（纯 TS 归约，可在 bun test 毫秒级运行）、client.ts
    src/lib/safe-links.ts             # 外链仅允许 http(s)，拒绝控制字符/危险协议并强制 noopener noreferrer
    src/components/                   # AppShell、SessionSidebar、TopHeader、ConversationView、ToolStepCard、TodoDock、InteractionDock、ComposerDock、ArtifactDrawer、TuiSurfaceOverlay
    src/main.tsx
    shims/lib/utils.ts                # cn() 等
    shims/lib/ime.ts                  # IME 组合输入守护
    shims/core/clipboard.ts           # navigator.clipboard 封装
    shims/core/streamdown/preprocess.ts
    shims/core/streamdown/plugins.ts  # reasoningPlugins / streamdownPlugins
    shims/core/uploads.ts             # 仅 PromptInputFilePart 与 splitUnsupportedUploadFiles，不拉 fetcher/react-query
    dist/                             # app.css + main.js(+chunks) + index.html
```

### 强约束与禁止事项

1. **正交棘轮**：`host-omp` 与 `host-omp-ui` 严禁互相 `import`；根 `src/`（core）严禁 `import` 两者；`host-omp-ui/src/` 禁止相对路径引用根 `src/`。由 `eslint.config.mjs` 新增 lint block 与 `tests/architecture/host-omp-ui-boundary.test.mjs` 强制检验。
2. **Station 铁律**：`station/ui-bridge-station.mjs` 内严禁出现 `async` 或 `await`，严禁保存未完成工单台账；所有门卫方法先完成全部自身状态提交，再于尾位置调用注入的工单能力。
3. **扩展无隔离兜底**：omp 扩展运行在主进程内，未捕获异常会 teardown 整个 session。所有 `Bun.serve` 回调、WS handler、异步工单、定时器必须使用 `try/catch` 兜底并通过 `ctx.setInterval`/`ctx.setTimeout` 托管；`session_shutdown` 须注销当前实例并还原 patch。其他实例仍在时管理入口须保持或恢复，最后一个实例退出后释放端口。

## 核心运行时约束（源码反证已锁死）

| 约束点 | 源码事实与强制实现 |
|---|---|
| **强制 Eager 加载** | `startup-deferral.ts` 的 `canBindAfterStartup` 会延迟只注册 tool/hook/command 的扩展至首次用户输入。factory **必须**注册无害 `pi.registerMessageRenderer("herd-ui/noop", () => undefined)` 强制启动即加载。 |
| **捕获 live Composer/TUI** | `beginStartupComposer()` 在扩展加载前即已调用 `ui.setFrameProvider(this)`。**禁止**依赖 `TUI.prototype.setFrameProvider` 捕获；必须 patch `Composer.prototype.renderFrame` 与 `Composer.prototype.setEditor`（幂等 Symbol 保护），对已有实例立即生效。 |
| **穿透 `ctx.ui` Proxy** | `ctx.ui` 由 `trackUserWaits` 包成只带 `get` trap 的 `Proxy`，直接赋值无效；必须先校验 `desc.writable && desc.configurable` 再用 `Object.defineProperty` 写入共享 target。只拦截 `ctx.mode === "tui" && ctx.hasUI && ctx.agent?.kind !== "sub"`。 |
| **安全替换 Editor** | `ctx.ui.setEditorComponent` 只迁移文本、不迁移 `pendingImages`/`pendingTexts`。只在启动/`session_start` 且草稿为空、且无其他扩展抢占（`getEditorComponent() === undefined`）时安装继承自 `CustomEditor` 的 `BridgeEditor`；严禁覆盖 host 占用的 `onSubmit`/`onChange`。 |
| **不碰 `NativeBackend.start()`** | 绝不调用 `NativeBackend.start()`（会篡改进程级 `setNativeRendering`/nerd icon 影响本地 ANSI TUI）；仅动态 import `@oh-my-pi/pi-tui/native/reconcile` 构造独立 `Reconciler("s:web")` 消费 `composer.describeSurface(cx)` 与 `tui.overlayStack`。 |
| **深路径动态加载与降级** | `@oh-my-pi/pi-tui/{prompt/composer,prompt/custom-editor,native/reconcile,html-form/parse,html-form/data}` 均须动态 `import()`；任一加载失败时记录诊断并降级对应能力，绝不拖垮 omp 启动。 |
| **`ask` HTML 防 XSS** | 模型生成的 HTML 严禁直接注入浏览器 `innerHTML`；服务端用 `station/domain/html-form-parser.mjs`（优先复用 pi-tui 解析器，内建纯 JS 解析器兜底）转成结构化字段模型，Web 用 shadcn 表单控件渲染并在提交前强校验约束。 |
| **安全边界** | 管理器仅绑定 `127.0.0.1`，默认固定端口 `37421`（可用 `OMP_UI_PORT` 覆盖）；端口冲突明确报错，不回退。实例共享保存在用户私有目录中的 token（文件权限 `0600`）；除 `GET /`、`GET /dist/*`、`GET /assets/*`、`GET /api/health`、`GET /api/manager/identity` 外所有 `/api/*`、浏览器与实例 WS 均需鉴权。identity 只用于识别本产品管理器，不返回会话数据。 |

## 测试路径规划

| 测试文件 | 覆盖契约 |
|---|---|
| `tests/architecture/host-omp-ui-boundary.test.mjs` | 双插件独立 manifest、`host-omp` ↔ `host-omp-ui` 与 core 双向导入禁止、Station 禁止 `async`/`await`、domain 纯净、`activation/tickets.mjs` 的 `detach` catch-all |
| `tests/host-omp-ui/transcript-model.test.mjs` | `SessionEntry` 驼峰 role（`toolResult`/`bashExecution`/`compactionSummary`/`branchSummary`）归约、流式 delta 拼接、toolCall/toolResult 配对、`agent_end` 去重、显示分组 |
| `tests/host-omp-ui/tool-artistry.test.mjs` | `read`/`write`/`edit` diff/`bash`/`eval`/`search`/`web`/`todo`/`task`/`ask`/`generic` 艺术映射、artifact 去重、ANSI strip、行级 diff |
| `tests/host-omp-ui/html-form-parser.test.mjs` | HTML `<form>` 解析、fieldset/legend/radio/checkbox 自动 `Other` 规则、约束强校验、防 XSS、`FormAnswer` 映射 |
| `tests/host-omp-ui/interaction-and-station.test.mjs` | `UiBridgeStation` 同步不变式与三段式尾位置开单、`interaction-race` 先答者胜与幂等拒绝、双向草稿 `rev` 防回环、`TspOp[]` 文档归约、协议帧校验 |
| `tests/host-omp-ui/tui-fence.test.mjs` | 只带 `get` trap 的 Proxy `defineProperty` 穿透、`Composer.prototype.renderFrame`/`setEditor` 捕获、`BridgeEditor` 草稿同步、`dialog` 双路竞速与输家 abort、surface watcher 节流、事件路由 |
| `tests/host-omp-ui/manager-contract.test.mjs` | 固定端口不回退、loopback/鉴权/静态托管与路径穿越、多实例注册与路由、最后实例释放端口 |
| `tests/host-omp-ui/manager-snapshot-contract.test.mjs` | 会话选择屏障：权威 snapshot 先于缓冲增量、旧 generation 不覆盖、实例断线关联失败 |
| `tests/host-omp-ui/manager-session-contract.test.mjs` | 全机会话规范化、原 cwd 恢复、tmux argv 保活与特殊路径、活实例复用与单飞 |
| `tests/host-omp-ui/manager-new-session-contract.test.mjs` | Web 新建真实 omp：可信 cwd、不带 `--resume`、注册完成才成功、并发单飞 |
| `tests/host-omp-ui/machine-catalog-contract.test.mjs` | 只读 JSONL 扫描：header 非首行、续写链尾、mtime、缺 cwd、损坏诊断与自定义根目录 |
| `tests/host-omp-ui/manager-catalog-integration.test.mjs` | 汇总所有实例的 session-dir，列表与恢复使用同一目录集合，断线后保留 |
| `tests/host-omp-ui/manager-web-contract.test.mjs` / `manager-web-catalog-contract.test.mjs` | 命令 pending/result 关联、权威模型更新、会话切换隔离；全机目录不被实例快照覆盖 |
| `tests/host-omp-ui/command-contract.test.mjs` | 所有状态变更命令的成功/失败回执与宿主回读 `meta.update` |
| `tests/host-omp-ui/launch-context-contract.test.mjs` / `launch-context-cleanup-contract.test.mjs` | 一次性 0600 凭据、argv 不含 token、不安全权限/符号链接拒绝、TTL 清理 |
| `tests/host-omp-ui/tmux-launch-contract.test.mjs` | tmux 后续命令失败但会话存活时保留凭据、真正失败才清理并回错 |
| `tests/host-omp-ui/tray-contract.test.mjs` | 单图标、点击打开固定 URL、异步 create/destroy、迁移无重复与诊断不泄 token |
| `tests/host-omp-ui/safe-links-contract.test.mjs` | 外链仅 http(s)、拒绝控制字符/危险协议、`noopener noreferrer` |
| `tests/host-omp-ui/activation-wiring.test.mjs` | factory 强制 eager 且不启动端口、`/web` 命令、`session_start` 启动/装饰/装 editor、子代理跳过；TUI/RPC/print 主会话注册与 shutdown 注销、官方事件订阅、`plan_review_requested` 解决、`session_shutdown` 清理 |
| `tests/host-omp-ui/web-store.test.mjs` | `snapshot` 水合、`transcript.delta` 流式拼接、`draft.sync` rev 仲裁、`interaction.open/close`、`surface.frame` 归约与不同实例的会话隔离 |

## 已知残余与升级关注点

- 构建 Web 产物：`cd host-omp-ui && bun run build:web`（即 `bun web/scripts/build.mjs`），输出 `host-omp-ui/web/dist/` 并随插件 `files` 发布；复制安装不会现场构建。
- `../deer-flow/frontend/node_modules` 首次构建前需执行 `pnpm install --frozen-lockfile`；`host-omp-ui/web` 首次需 `bun run install:safe`（不修改上游源码与 lockfile）。
- 若 `Bun.build` 打包 `@streamdown/code` / `shiki` / `@streamdown/mermaid` 遇到 WASM 或动态加载兼容问题，`web/shims/streamdown.ts` 提供优雅降级路径（保留完整 Markdown/GFM/高亮代码体验）。
- 扩展自定义 `ctx.ui.custom()` 若未实现 `describe(cx)`，Web 通过右侧/停靠 TUI Surface 视窗以 `ui/terminal` ANSI 渲染 + `surface.keys` 透传完整交互。
