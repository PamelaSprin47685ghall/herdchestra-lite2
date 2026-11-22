---
name: host-omp-split
description: Use when splitting HerdchestraLite2 into a host-agnostic core package and the host-omp plugin package. Records the as-built layout, the single HostBridge seam, resource and install invariants, and the slice history.
---

# Host-OMP 拆分

## 零、现状（as built，以此为准）

两包，单向依赖：

| | 根包 `herdchestra-lite2` | `host-omp/` = `herdchestra-host-omp` |
|---|---|---|
| 角色 | 宿主无关核心 | 最终插件入口 |
| `omp.extensions` / `pi.extensions` | 无 | `["./src/main.mjs"]` |
| `exports` | `"."` → `./src/index.mjs` | `"."` → `./src/main.mjs` |
| `files` | `src/ resources/ skills/ README.md` | `src/ README.md` |
| 依赖 | 零运行时依赖 | `{"herdchestra-lite2": "link:.."}` |

`link:..` 不是 `file:..`：`file:` 被 bun 展开成整仓副本（实测 24MB，且副本里递归含 `host-omp/`），改核心不重装就测到旧代码；`link:` 是符号链接，`import.meta.resolve("herdchestra-lite2")` 落在仓库根的 `src/index.mjs`。

`host-omp/src/` 实际只有三层：

```
host-omp/src/main.mjs                  activate(pi, env)
host-omp/src/activation/               组合根：ports/hooks/tools/commands/tickets/capture/diagnosis
host-omp/src/host/                     28 个 omp 接缝文件 + host/domain/
  ├─ host-tickets.mjs                  宿主票据：steer/prompt/activateTools/restoreScopedModel
  ├─ fork-spawn-ticket.mjs             子会话创建、催收、冻结结果
  └─ policy.mjs / prompts.mjs          指向核心 barrel 的薄壳（不是 `export *` 影子）
```

**`src/station/registry.mjs` 留在核心**，`createStationRegistry` 接收注入的 `host` 包与票据束；`host-omp/` 下没有这个文件。核心 barrel 是 `src/index.mjs`（94 个显式具名导出，无 `export *`）。

`HostBridge` 的真实键取自 `host-omp/src/activation/index.mjs` 的 `createHostBag`（`Object.freeze`）：

```
forkWiring, attachBaseForkPorts, identityForAgent, agentIdOf,
conversationKeyOf, managerOf, branchOf, agentOf, selectStopStation,
ledgerFor, adoptLedger, sessionFor, setAgentMessages, contextHeaderOf,
activeTools, record, createEmptyCatalog, appendHistoryMessage,
preparseModelSpec, capabilities, modelOf, thinkingOf,
usage {entryUsage,totalInput,usageSnapshot}, pricing {charsToTokens}
```

`isReadOnly`、`adapters`、`sendSlashPrompt`、`stopAfterScopeReturn` **不是顶层键**：它们落在 `capabilities` 束里。设计稿里把它们列进桥的那张表作废。

## 一、为什么这样切

宿主与核心今天只差五条反向边（`station/registry.mjs`、`tools/tickets.mjs`、`tools/fork-spawn-ticket.mjs`、`scope/usage-ledger.mjs`、`station.mjs` 里的 `pi.getActiveTools`）。方向本来已是 host → core，7,039 行不必搬。所以拆分的全部工作是切断这五条边，再搬目录；不是重写。

`ctx` 在核心内部降为**不透明 token**：只传递、不 deref。三处直接 deref（`core/policy.mjs:53`、`tools/todo.mjs:36`、`station/handoff-state.mjs:195`）已消失；核心只剩 `station.mjs:22` 一条注释说明宿主契约面。

## 二、核心包不变式（硬）

`src/**` 四条零引用：零 `@oh-my-pi/*`、零 `../host/*`（任意深度）、零 `../activation/*`、零 `host-omp`。

两道锁：`eslint.config.mjs` 的 `no-restricted-imports` 管开发期；`tests/architecture/core-host-free.test.mjs` 管绕过 lint 的那次。反向同理：`host-omp/src/**` 不得用相对路径回逃 `../src/*`，只能用包名。

## 三、资源不变量

`src/prompts/index.mjs` 用 `new URL("../../resources/prompts/", import.meta.url)` 读盘，所以 `resources/` 永远与 `src/prompts/` 同包——不搬。

`skills/` 的运行时读者只有宿主 `skill://`（从插件包根发现），代码里零读取者。单一源留在核心；`sync-plugin` 安装时镜像到 `TARGET/skills/`。因为镜像产物不入仓，`host-omp/package.json` 的 `files` **不声明 `skills/`**——声明一个仓库里不存在的目录只会让 `npm pack` 缺件。

## 四、安装面

`scripts/sync-plugin.mjs` 双根：

- 核心 → `TARGET/node_modules/herdchestra-lite2/{src,resources,skills}`，并写入该目录的最小 `package.json`；
- host-omp → `TARGET/{src,skills,package.json}`。

`TARGET` 默认 `~/.omp/plugins/node_modules/herdchestra-host-omp`。修剪要下钻一层（否则搬走的文件留在旧目录）；指纹带根前缀（`src/relay/texts.mjs` 属核心根，`src/activation/tools.mjs` 属宿主根）。旧目录 `.../herdchestra-lite2` 必须删除：它仍声明 `omp.extensions`，留着会双载。

## 五、切片历史（先剪接缝，再搬包）

| 波 | 内容 | 结果 |
|---|---|---|
| W0 | 三份只读勘测 + 设计记录 | 反向边 5 条、`ctx` deref 3 处、资源不变量 1 条 |
| W1 | 宿主票据与 spawn 迁入 `src/host/`，行为零改动 | 1060 pass |
| W1.5 | 过切修正：纯工单回 `src/tools/tickets.mjs`，宿主票据留 `host-tickets.mjs` | 归零 |
| W2 | 注入接缝：registry 宿主包、station 能力、usage-ledger、三处 ctx deref | 1060 pass，核心 host import 归零 |
| W3 | 包搬移、入口、barrel、测试、eslint、棘轮、脚本、CI | 1064 pass / 11-11 relay |
| W3.5 | `file:` → `link:`，补实时源码棘轮 | 1066 pass |

先剪接缝再搬包，是为了避免两包互引：搬包阶段树仍然可测。

## 六、已拒绝

- 给核心加 `./scope`、`./station` 等子路径导出：等于把 9 个内部 barrel 升成包契约。
- 保留 `station/registry.mjs` 的 eslint 例外：例外就是边界不存在的证据。
- 在代码里弥合资源路径：会让两个包在运行时互相猜测布局。
- 用 `file:..` 换开发期方便：它会静默复制整仓，形成假绿。

## 七、验收

- `bunx eslint .` 退出码 0；`bun test tests` 1066 pass / 0 fail；`bun run smoke:relay` 11/11。
- 核心对 `@oh-my-pi/*`、`../host/*`、`../activation/*`、`host-omp` 的 import 为 0（lint + 棘轮各证一次）。
- 从安装目录 `import("./src/main.mjs")` 得到 `activate: function`；`bun scripts/smoke-omp.mjs` 除原生 addon 版本外全过。
- `files` 的每一项在仓库里存在（棘轮新增）。

## 八、残留

- omp 是否从插件包根以外发现 `skills/`：未验，按保守镜像处理；镜像只在安装时产生。
- `host-omp/bun.lock` 被忽略：当前唯一依赖是 `link:..`，无可钉版本；将来加入真实 npm 依赖时必须入仓。
- 宿主 commit 钉死（`57771ae…`），两包必须同版本发布，否则接缝可能在旧 commit 上不成立。
- `bun scripts/smoke-omp.mjs` 唯一失败项是本机原生 addon 版本（19.0.0 vs 19.1.0），需 `bun run build:native`，与本次改动无关。

## 九、取代

`.agent/skills/station-refactor/{station,ports,wiring}.md` 与 `STATUS.md` 中关于「`src/station/registry.mjs` 是唯一 station→host 桥」、文件归属、棘轮扫描根的描述均已过时，以本记录与 `contract.md` 为准；那三份保留作 Phase 1–4 的历史与不变量来源。
