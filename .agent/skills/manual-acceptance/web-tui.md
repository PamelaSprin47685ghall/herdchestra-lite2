# Web + TUI 双端官方 OMP 手工验收流程

本文件隶属于 [SKILL.md](./SKILL.md)，定义无法被单元测试替代的真实终端 TUI + 真实浏览器联调验收闭环。

## 准备与安装

1. 确认 `../deer-flow/frontend/node_modules` 已安装（若缺失则在 `../deer-flow/frontend` 执行 `pnpm install --frozen-lockfile`，不改动其源码）；在 `host-omp-ui/web` 首次执行 `bun run install:safe`。
2. 构建同源 Web SPA 静态产物：`cd host-omp-ui && bun run build:web`（即 `bun web/scripts/build.mjs`），确认 `host-omp-ui/web/dist/index.html`、`app.css`、`main.js` 生成无报错；复制安装不会现场构建。
3. 将 `host-omp-ui` 链接到本机 omp 插件目录：`omp plugin link ./host-omp-ui`（先 `--dry-run` 核对），执行 `omp plugin list` 确认 `herdchestra-host-omp-ui` 与 `herdchestra-host-omp` 各自独立列出。

## 验收循环（逐项观察用户侧可见事实）

1. **正交性验证（只装 `host-omp` 零回归）**
   - 临时执行 `omp plugin disable herdchestra-host-omp-ui`，启动 `omp` 验证无 Web 端口监听、TUI 与 `host-omp` 全部能力照常运行；随后重新 `enable`。
2. **仅官方 omp + `host-omp-ui` 启动与 Eager 监听**
   - （可选临时 disable `herdchestra-host-omp`）直接启动官方 `omp` TUI。
   - **观察**：无需先发送第一条消息，启动完成即打印本机访问 URL（默认 `http://127.0.0.1:37421/?token=<token>`；若配置了 `OMP_UI_PORT` 则使用配置端口）；执行 `/web` 命令亦可再次查看状态与 URL。
3. **固定入口与全机会话管理**
   - 启动第一个 `omp` 后打开 `http://127.0.0.1:37421/?token=...`，确认无 401/404/500 与 Console 未捕获异常；无 token 访问 `/api/bootstrap` 返回 401。
   - 再启动一个 `omp`，确认固定端口仍由管理器持有、新实例出现在实例列表且不会自行监听第二个端口。关闭其中一个实例，入口与其余实例不受影响；全部关闭后端口释放。
   - 界面完整呈现 DeerFlow 视觉语言（左侧栏、居中对话画布、底部悬浮输入条、暗/亮主题一键切换无断层）；会话列表覆盖全机所有历史会话并显示各自工作目录，不限于当前进程的项目。
   - 点开一个没有活跃实例的历史会话：确认 Web 显示启动等待态，管理器在原始工作目录用 `tmux` 启动真实 `omp --resume`；实例注册后对话可继续输入，`tmux a` 能进入同一会话。重复点击不得拉起第二个进程。
   - 以 `omp --mode rpc --no-ui` 在隔离端口启动主会话：确认它出现在实例列表且 `mode` 为 `rpc`；普通文本可提交，附件、斜杠/`!`/`$` 命令与 TUI Surface 显示明确不可用，不得显示为可发送后静默失败。RPC 的 stdout 仍须逐行是合法 JSON。关闭其 stdin 后进程正常退出，最后一个实例退出后固定端口释放。
   - 未加载插件的 OMP（例如 `--no-extensions`）不作为已托管实例展示或控制；若产品展示其会话，只能标记“未托管/仅只读”，不得显示可输入 Composer。
   - 点击 Web 的“新建会话”：管理器在可信 cwd 用 `tmux` 启动不带 `--resume` 的真实 `omp`；注册完成后 Web 自动切到新实例，期间显示启动态，失败显示原因，不得复用或覆盖其他会话。
   - 管理器存活期间（首个实例建立到最后一个退出）桌面托盘应出现**一个**图标：左键用系统默认浏览器打开固定 Web 入口。启动第二个实例、或在 TUI 里切换会话，不得出现第二个图标。关闭 leader 实例、由其余实例接手后，图标仍只有一个且可点击；最后一个实例退出后图标消失，桌面无残留 helper 进程。
   - 在其余实例仍运行时强制结束 leader，观察接手过程：Web 短暂断线后自动重连，图标不重复、不残留。
   - 该机器的托盘运行时依赖若缺失（Linux 需要 Python 3 + PyGObject + 托盘 watcher），应看到明确诊断而非静默失败；Web 服务本身照常可用。macOS/Windows 的对应项须在该平台单独执行，不能以 Linux 结果代替。
4. **双端实时流式、Thinking、工具卡片与 Artifact/Diff 抽屉**
   - 发送触发多步工具调用的真实请求（如读取仓库文件、执行 `echo` bash 命令、临时编辑文件）：
     - Thinking 过程流式展开带微光，正文开始或结束自动收起。
     - Markdown 正文平滑流式输出，代码块高亮且可复制。
     - `read`、`bash`、`edit` 等工具以各自特化卡片收束在 `ChainOfThought` 时间线内；`bash` 展示命令与安全 ANSI 输出；点击 `edit`/`read` 卡片能在右侧抽屉查看高亮全文或红绿 Diff。
5. **输入条双向草稿、提交等价、斜杠命令与中止**
   - 在 TUI 输入框打字 → Web 输入框实时同步；在 Web 输入框输入中英文（含 IME 拼音组字）→ TUI 输入条同步且不拆字。
   - 在 Web 按 Enter 提交 → 走原生提交路径且消息只发一次；测试发送内置斜杠命令（如 `/compact` 或 `!echo hello`）与 TUI 行为一致。
   - 在流式生成中途点击 Web 停止按钮 → TUI 与模型立刻中止，无卡死；测试流式中发送 Steer/Follow-up 队列芯片同步。
6. **模型与思考档位切换**
   - 在 Web 输入栏切换模型或思考档位 → TUI 状态栏同步更新，Web 显示宿主回读的实际选择，下一轮对话实际生效；失败时 Web 显示对应错误而非静默无响应。
7. **`ask` HTML 表单双路竞速（核心！）**
   - 引导模型调用 `ask` 工具（含 radio/checkbox/text/number 与必填校验）：
     - TUI 弹出原生表单，同时 Web 输入框正上方停靠出现原生 shadcn 表单（验证非法/空必填字段被前端拦截提示）。
     - 在 Web 提交合法答案 → **TUI 表单瞬间干净关闭、整轮不被误中止**，模型准确收到答案并继续回复。
     - 再次触发 `ask` 并在 TUI 端提交 → Web 停靠表单瞬间自动收起。
8. **审批与 Plan Review 双路竞速**
   - 在非 yolo 审批模式或受限命令下触发工具审批：Web 停靠审批卡与 TUI 审批同步出现，任一端点击允许/拒绝，另一端即时关闭。
   - 若触发 Plan Review：Web 展示计划书与操作按钮，点击选择后 TUI 审核界面同步关闭并按所选档位继续。
9. **TUI Overlay 兜底显示与操作**
   - 在 TUI 打开原生 overlay（如 `/settings` 或快捷键选择面板）→ 打开 Web 右侧 TUI Surface 视窗可见对应结构化节点或安全 ANSI 画面，通过视窗按钮或键盘透传（方向键/`Esc`）可操作并关闭 TUI overlay。
10. **容错与退出清理**
    - 关闭浏览器或刷新页面 → TUI 全程不受影响；刷新后 Web 自动恢复完整对话与实时流。
    - 退出一个 `omp` → 其余实例仍可通过固定入口使用；最后一个实例退出后 Web 端口释放，进程无挂起、无报错退出。

## 调整触发条件

上述任一环节出现白屏、消息丢失或重复、XSS/裸 HTML 注入、TUI 弹窗未随 Web 回答关闭、Web 取消误杀或卡死、未捕获异常拖垮 omp 进程，必须定位根因修复后重新验证，绝不跳过。
