# 接口清单：核心包 → host-omp → omp

As built。路径按拆分后的真实位置写；设计稿里对不上的地方以本文件为准。

## 核心包 `herdchestra-lite2` 的公开面（`src/index.mjs`）

单一 barrel，94 个显式具名导出，无 `export *`（与现有 9 个 `index.mjs` 同一句式）。

| 目标模块 | 符号 | 宿主消费点 |
|---|---|---|
| `scope/forkjoin.mjs` | `forkOf`、`RUNNING`、`READY`、`emptyTotals`、`markReady`、`takeReady` | `host/fork-registry.mjs`、`host/child-display.mjs` |
| `scope/clock.mjs` | `createClockOn`、`createClockOff` | `activation/ports.mjs` |
| `scope/scope-id.mjs` | `scopeTitle`、`publicScopeId` | `host/activation-binding.mjs`、`host/child-display.mjs` |
| `scope/targets.mjs` | `normalizeTargets`、`validTargets` | `host/fork-registry.mjs` |
| `station/registry.mjs`（**在核心**） | `createStationRegistry` | `activation/index.mjs` |
| `station/domain/fork-ledger.mjs` | `selectForkLedger` | `host/fork-identity.mjs`、`host/fork-wiring.mjs` |
| `station/station.mjs` | `SessionStation` | 仅契约（测试替身必须是真类） |
| `tools/tickets.mjs` | `forkTicket`、`joinTicket`、`returnTicket`、`scopeContextTicket`、`panhandleTicket` | `activation/tools.mjs` |
| `tools/descriptions.mjs` | `FORK_DESCRIPTION`、`forkParameters`、`JOIN_*`、`RETURN_*`、`PANHANDLE_*`、`SCOPE_CONTEXT_*`、`AMEND_*`、`PIN_*` | `activation/tools.mjs` |
| `tools/index.mjs` | `TODO_DESCRIPTION`、`TODO_PARAMETERS`、`todoTicket` | `activation/tools.mjs` |
| `prompts/inject.mjs` | `rewriteVibeModeContext`、`persistentOperatingSkill`、`injectSystemPrompt` | `host/prompts.mjs`（薄壳转出） |
| `core/policy.mjs` | `MAIN_AGENT`、`READ_ONLY_SUBAGENT`、`READ_WRITE_SUBAGENT`、`sessionInitFor`、`agentPolicy` | `host/policy.mjs`（薄壳转出） |
| `core/ports/resolve.mjs` | `resolvePorts` | `activation/ports.mjs` |
| `relay/policy.mjs` | `relayImplementations` | `activation/ports.mjs` |
| `features/{amend,herd,pin}/index.mjs` | `createAmendOn/Off`、`createHerdOn/Off`、`createPinOn/Off` | `activation/ports.mjs` |
| `transcript/branch-writes.mjs` | `appendAt` | `host/branch-manager.mjs` |
| `transcript/replay.mjs` | `renderChildRecord` | 宿主渲染与测试 |
| `prompts/index.mjs` | `loadDoc`、`preloadDocs` | `host-omp/src/main.mjs` |

不进 barrel：`createTestStation`（只存在于 `tests/helpers/station-ports.mjs`）。

## `HostBridge`（host-omp 构造，核心消费）

真实来源：`host-omp/src/activation/index.mjs` 的 `createHostBag(pi)`，返回 `Object.freeze` 的普通对象。

```js
{
  forkWiring() -> wiring,
  attachBaseForkPorts(...),             // 端口装配
  identityForAgent(agent) -> id,
  agentIdOf(ctx) -> string,
  conversationKeyOf(manager) -> string,
  managerOf(ctx) -> sessionManager | null,
  branchOf(ctx) -> entries[],           // 吸收 policy.mjs:53、todo.mjs:36
  agentOf(ctx) -> agent | null,
  selectStopStation(...) -> station | null,
  ledgerFor(registry, key) -> ledger | null,
  adoptLedger(registry, key, ledger) -> void,
  sessionFor(ctx) -> session | null,
  setAgentMessages(ctx, tree) -> void,
  contextHeaderOf(ctx) -> string,
  activeTools() -> string[],            // 吸收 pi.getActiveTools
  record(domain, error, detail) -> void,
  createEmptyCatalog() -> object,
  appendHistoryMessage(...) -> void,
  preparseModelSpec(spec) -> parsed,
  capabilities: { … },                  // 见下
  modelOf(ctx) -> model,
  thinkingOf(ctx) -> string,
  usage: { entryUsage, totalInput, usageSnapshot },
  pricing: { charsToTokens },
}
```

`capabilities` 束里是那组被设计稿误列进桥顶层的入口：`isReadOnly`、`adapters`（`modelFrom`/`thinkingFrom`）、`sendSlashPrompt`、`stopAfterScopeReturn`。

禁止：核心持有 `pi`、核心 import 任何 bridge 实现、bridge 键按宿主版本分支。

## 工单能力束 `registry.tickets`

```js
{ steer, canSteer, prompt, canPrompt, restoreScopedModel, activateTools }
```

由 `activation/tickets.mjs` 的 `buildTickets(pi)` 构造；实现在 `host-omp/src/host/host-tickets.mjs`。核心只持有形状，不 import 实现。

## 端口表（`core/ports/registry.mjs`，不变）

10 个名字：`relay(none|ledger|handoff)`、`clock`、`chineseReminder`、`vibeCompat`、`herd`、`pin`、`amend`、`modelSwitch`、`status`、`observer`。核心只留名字与裁决；`chineseReminder`、`status`、`observer` 的实现本就在宿主侧。

`NAMED_SWITCHES` 仍只有 `relay`；`PORTS.scope` 仍为 `undefined`。

## 宿主侧文件归属（`host-omp/src/`）

| 文件 | 职责 |
|---|---|
| `main.mjs` | `activate(pi, env)`：渲染器 → 捕获 → 定价 → `wireExtension` → 状态栏 |
| `activation/index.mjs` | 组合根 + `createHostBag`；`resolveWiringPorts` 失败即抛，无降级 |
| `activation/hooks.mjs` | 9 个宿主事件 → 服务台 Gatekeeper；三处猴补；handoff 执行（`compact`/`continue`） |
| `activation/tools.mjs` | 6 个 `pi.registerTool` |
| `activation/commands.mjs` | `/herd-autopilot`、`/herd-diag` |
| `activation/tickets.mjs` | `buildTickets(pi)` → 能力束 |
| `host/host-tickets.mjs` | 四张宿主票据（steer/prompt/activateTools/restoreScopedModel） |
| `host/fork-spawn-ticket.mjs` | 子会话创建、催收、冻结结果 |
| `host/*`（其余） | 26 个 omp 接缝文件 + `host/domain/` |
| `host/policy.mjs`、`host/prompts.mjs` | 指向核心 barrel 的薄壳 |

核心侧对应：`src/station/registry.mjs` 留在核心，只做注入装配与会话路由。

## 边界检查（可执行）

```bash
# 核心不得出现宿主引用
grep -rn '@oh-my-pi/\|from "\.\./\(host\|activation\)/\|host-omp' src/
# 应无输出

# 宿主不得用相对路径回逃核心
grep -rn 'from "\.\./\(scope\|station\|tools\|prompts\|core\|relay\|features\|transcript\)/' host-omp/src/
# 应无输出

# 依赖必须是声明式链接，而不是整仓副本
grep -n '"herdchestra-lite2"' host-omp/package.json
# "link:.."
```

## 更正记录

- 设计稿曾把 `station/registry.mjs` 列进 `host-omp/src/`：错，它留在核心。
- 设计稿曾把宿主票据写成 `host-omp/src/tickets/`、spawn 写成 `host-omp/src/tools/`：实际都在 `host-omp/src/host/`。
- 设计稿的依赖写法是 `file:..`：实测会复制整仓（24MB）并让宿主编译旧核心；已改 `link:..`。
- `host-omp/package.json` 的 `files` 不含 `skills/`：技能在安装时从核心镜像到插件根，仓库内没有该目录。
