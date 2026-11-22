# Station 勘测与 Phase 1 补丁

基线：当前工作区（含用户未提交的 permission→targets 与 scope_join interruptible 改动）。
`bun test tests` 861 pass / 0 fail；`bunx eslint .` clean；smoke 未跑。

## 1. SessionStation 类地图（src/station/station.mjs，906 行）

| 区域 | 行 | 说明 |
|---|---|---|
| imports | 27-138 | 直接 import 6 个 host 模块；见 §3.6 |
| constructor | 140-208 | state/restore/anchor/processed/dispatch/brackets/usage；注入 tickets/registry/pi |
| `forkForFlow` | 210-241 | 无调用者；`Object.create(this)` 视图；死代码候选 |
| usage | 243-251 | 转发 usage ledger |
| persistence/noteError | 253-269 | anchor.persist + diagnostics ring |
| `policy` | 271-293 | 缓存 agentPolicy；当前在 289 调 `syncTodo` |
| `syncTodo`/`ensureTools`/`todoReady`/`relayOn` | 295-368 | todo 授予与 relay 判定 |
| deliver/context helpers | 370-406 | steer/prompt/contextMessages/assistantForToolCall |
| dispatch admission | 408-437 | `prepareToolDispatch`、`admitToolDispatch` |
| branch clock | 439-476 | pause/resume/deadline |
| usage forwards | 478-499 | tokens/context/pricing |
| amend boundary | 501-525 | findAmendTarget/amendBoundary |
| message processing | 527-565 | processed ledger、amend scan |
| execute cores | 567-632 | 转发到 execute.mjs / fork-controls.mjs |
| ports | 634-652 | pin/amend/herd |
| model + directAmend | 654-672 | **654 与 670 重复定义 directAmend** |
| nudge/rebase | 674-697 | maybeNudge/maybeRebase |
| receipts | 699-749 | recordJoinReceipt/recordElderReport/settleReceiptFolds |
| `transformContext` | 751-800 | 过滤 amend→折叠 receipt→rewrite→rebase→usage |
| handoff | 802-832 | arm/capture/commit/advance/record |
| gatekeepers | 834-902 | 每个宿主事件一个同步入口 |

## 2. 关键发现（带精确片段）

### 2.1 directAmend 重复定义

`station.mjs:654-656` 与 `:670-672` 完全相同：

```js
	directAmend(toolCallId, params) {
		return directAmend(this, toolCallId, params);
	}
```

后一个覆盖前一个，行为偶然一致。ESLint 当前未启用 `no-dupe-class-members`，所以 861 个测试与 lint 都没发现。`execute.mjs:65` 的 `directAmend` 是真实实现，Station 的转发器保留一个即可。

### 2.2 fire-and-forget 缺 catch-all

`syncTodo` 在 `station.mjs:313`：

```js
		this.todoGrantKey = key;
		void this.tickets.activateTools(active, undefined, false);
```

`buildTickets()`（src/activation/tickets.mjs:21-22）返回 `activateToolsTicket(...)`，是 Promise；`nullTickets.activateTools`（src/station/registry.mjs:30-31）返回对象/undefined。Promise 没有 `.catch`，`void` 只丢弃返回值，不处理拒绝。`activateToolsTicket` 内部 catch 了 `setActiveTools`，但 ticket 自身若拒绝（例如 `pi` getter 抛错），就是未处理拒绝。

对照：`fork-wiring:496` 的 spawn 有 `.catch`；`sendSteerTicket`/`sendUserMessageTicket` 内部全 catch。标准存在，但 `activateTools` 没统一。

### 2.3 policy() 有开单副作用

`station.mjs:275-293`：

```js
	policy(ctx) {
		if (this.agentPolicy !== null) return this.agentPolicy;
		const policy = agentPolicy(ctx);
		if (policy === MAIN_AGENT) { ... return policy; }
		if (hasSessionInit(ctx)) {
			this.agentPolicy = policy;
			// INVARIANT: relay and `todo` are one decision. ...
			this.syncTodo(policy);
		}
		return policy;
	}
```

`policy` 是查询，却被 `onAssistantMessage`、`onMessageEnd`、`onToolCall`、`onSessionStop` 等多处调用；每次命中 `hasSessionInit` 且未缓存时都会触发 `syncTodo` 的 fire-and-forget 开单。真正需要授予 `todo` 的只有模型请求前：`prepareRequest`（gates.mjs:228）与 `onBeforeAgentStart`（gates.mjs:329）已经调用 `ensureTools`。因此 `policy` 可以只缓存裁决，授予动作留在 `ensureTools`/`syncTodo`。

### 2.4 onContext 的写状态

`transformContext` 在 `station.mjs:752-800`：

- `settleReceiptFolds(folded.collapsed)`（764）写 `state.receipts`；
- `maybeRebase(ctx, messages)`（779）调用宿主 `setAgentMessages`；
- `usage.noteSentContext(...)`（781）写 usage ledger（不写 `state`，只读 `state.epoch`）。

`transformContext` 内 **没有 ticket 开单**，所以不存在“工单同步前缀看到半更新”的路径。审计把它列为 S4 偏重；Phase 1 只做 Compute→Commit 整理，不制造行为变化：先算完 messages/collapsed/frontier，再统一提交 folds、rebase、usage。

### 2.5 admitToolDispatch 与 onToolCall 双入口

`admitToolDispatch`（station.mjs:417-437）在无 receipt 时调用 `onToolCall`（430）。同时 `activation/hooks.mjs:101` 把宿主 `tool_call` 事件直接绑到 `station.onToolCall`；`host/tool-dispatch.mjs:118-130` 又在 `beforeToolCall` 包装里调用 `admit`。同一工具调用可能两次进入 `onToolCall`，计费/控制处理是否重复取决于 `processed`/`dispatch` 的去重。Phase 4 处理：要么只保留一个入口，要么在 `admitToolDispatch` 用 toolCallId 去重。Phase 1 不改。

### 2.6 Station 直接 import host

`station.mjs:37-54` import 了 `host/fork-registry`、`host/policy`、`host/capture`、`host/adapter`、`host/diagnostics`、`host/pricing`。这是分层倒置：端口的依赖倒置没有落地。Phase 4 通过端口/注入收敛；Phase 1 不动，避免与用户改动冲突。

### 2.7 请求台账字段

`constructor` 建 `this.processed = createProcessedLedger()`、`this.dispatch = createDispatchTracker()`；另有 `pendingStation`（registry.mjs:41）、`modelSwitchInFlight`（models.mjs:61/86/104/111）。AGENTS.md §3 禁止“请求台账或在途工单表”。需要区分：

- `processed`：控制调用的幂等缓存，不是排队/重试表；但它确实按 toolCallId 保存处理结果。
- `dispatch`：按 toolCallId 记录 prepared/groups，用于同 beat 计费。
- `pendingStation`：session 切换时把 stop 路由到旧 station，是领域路由状态。
- `modelSwitchInFlight`：单个在途模型切换槽，不是表。

Phase 4 逐个决定：下沉为 ticket 局部状态、改成领域字段、或保留并写清非台账语义。不要盲删。

### 2.8 死代码与静默 no-op

- `forkForFlow`（210-241）全仓只有定义，无调用；`Object.create(this)` 视图重置 processed/dispatch/nudged。Phase 3 删除前查 git log，确认不是预留 API。
- `nullTickets`（registry.mjs:27-32）：`steer`/`prompt` 静默 no-op，`activateTools` 返回对象/undefined。Phase 3 改显式 fail-fast 或删除默认值。
- `directAmend` 重复见 §2.1。

### 2.9 onToolCall 路由

`gates.mjs:114-206` 约 90 行：pending handoff 阻断、`processControlsForTool`、todo 特判、CONTROL_TOOLS、ask/wait、`chargeBranch` 计费、persist。Phase 4 下沉为 Station 领域方法（`admitToolCall`），Gatekeeper 只翻译事件与返回 block 裁决。Phase 1 不动。

## 3. 组合根与测试构造

- 生产组合根：`src/activation/index.mjs:wireExtension` → `createStationRegistry(pi, buildTickets(pi), pricingCatalog, {...table, onStation: attachStation})`；`registry.stationFor(ctx)` 里 `new SessionStation(...)`（src/station/registry.mjs:102-112）。
- 端口表：`resolveWiringPorts(env)` → `resolvePorts`；表交给 registry；Station 通过 `this.registry?.ports?.()` 读取。
- 测试构造方式：
  - 直接 `new SessionStation(manager, pi, tickets, registry, pricingCatalog)`：`tests/fork-tool-deadline.test.mjs:45`、`tests/fork-wiring.test.mjs:575+`、`tests/model-facing-copy.test.mjs:131/172`、`tests/port-wiring.test.mjs:11/64/170`、`tests/relay-port.test.mjs:10`、`tests/silent-failure.test.mjs:47`。
  - `Object.create(SessionStation.prototype)` + 手工字段：`tests/fork-join-completion.test.mjs:38/66`、`tests/forkjoin-receipts.test.mjs:171`、`tests/join-obligation.test.mjs:44`、`tests/join-persist-confirmation.test.mjs:97`。
  - 走组合根 `activate(host.pi, {})`：`tests/todo-any-level.test.mjs:170` 的 `start()`。
- 结论：契约测试大多绕过组合根，端口未接线也能绿。Phase 2 必须把契约测试改成从组合根构建，否则“接线通过”没有证据。

## 4. Phase 1 最小补丁（精确 old/new）

### 4.1 ESLint 启用重复成员检查

文件 `eslint.config.mjs`：

old：

```js
		rules: {
			"no-restricted-syntax": [
```

new：

```js
		rules: {
			"no-dupe-class-members": "error",
			"no-restricted-syntax": [
```

这是重复 `directAmend` 的红色契约：加规则后 lint 必失败。

### 4.2 删除重复 directAmend

old：

```js
	reconcileActualModel(ctx, req, outcome) {
		return reconcileActualModel(this, ctx, req, outcome);
	}

	directAmend(toolCallId, params) {
		return directAmend(this, toolCallId, params);
	}

	// -- Nudge
```

new：

```js
	reconcileActualModel(ctx, req, outcome) {
		return reconcileActualModel(this, ctx, req, outcome);
	}

	// -- Nudge
```

保留 654 的第一个定义。

### 4.3 fire-and-forget 统一 catch-all

在 `noteError` 后加：

```js
	/**
	 * Detach a fire-and-forget ticket from this sync beat. A rejection is a
	 * station failure, not an unhandled promise: record it and keep the turn
	 * alive. A synchronous throw from the capability takes the same path.
	 */
	dispatchFireAndForget(domain, start) {
		try {
			const result = start();
			if (result && typeof result.catch === "function") {
				result.catch((error) => this.noteError(domain, error));
			}
			return result;
		} catch (error) {
			this.noteError(domain, error);
			return undefined;
		}
	}
```

`syncTodo`：

old：

```js
		this.todoGrantKey = key;
		void this.tickets.activateTools(active, undefined, false);
```

new：

```js
		this.todoGrantKey = key;
		this.dispatchFireAndForget("tickets", () =>
			this.tickets.activateTools(active, undefined, false));
```

### 4.4 policy 变纯查询

old：

```js
		if (hasSessionInit(ctx)) {
			this.agentPolicy = policy;
			// INVARIANT: relay and `todo` are one decision. The relay starts
			// here, so `todo` must be granted in the same breath.
			this.syncTodo(policy);
		}
		return policy;
```

new：

```js
		if (hasSessionInit(ctx)) {
			this.agentPolicy = policy;
		}
		return policy;
```

`ensureTools` 注释改为：

```js
	/**
	 * Re-assert the invariant before every model request. `policy(ctx)` is the
	 * verdict; this method is the only place that acts on it by granting
	 * `todo`. The host can install the session's tool set after the verdict
	 * lands, so one grant at verdict time is not enough. Never duplicate the
	 * verdict here.
	 */
```

### 4.5 onContext Compute→Commit

old：

```js
			const foldable = foldableReceipts(this.state.receipts);
			if (foldable.length > 0) {
				const folded = applyReceiptFolds(messages, this.state.receipts, { foldable });
				messages = folded.messages;
				if (folded.collapsed.length > 0) this.settleReceiptFolds(folded.collapsed);
			}
```

new：

```js
			const foldable = foldableReceipts(this.state.receipts);
			let collapsed = [];
			if (foldable.length > 0) {
				const folded = applyReceiptFolds(messages, this.state.receipts, { foldable });
				messages = folded.messages;
				collapsed = folded.collapsed;
			}
```

old：

```js
			this.maybeRebase(ctx, messages);
			if (key) {
				this.usage.noteSentContext({
```

new：

```js
			// Commit: the projection is complete. Write the folds it used,
			// then the host rebase and the usage snapshot. No ticket dispatch
			// follows, so no ticket can observe a half-written state.
			if (collapsed.length > 0) this.settleReceiptFolds(collapsed);
			this.maybeRebase(ctx, messages);
			if (key) {
				this.usage.noteSentContext({
```

## 5. Phase 1 测试契约（先写，不跑红）

新增 `tests/station-purity.test.mjs`：

```js
import { beforeEach, expect, test } from "bun:test";
import { reset as resetDiagnostics, snapshot as diagnosticsSnapshot } from "../src/host/diagnostics.mjs";
import { READ_WRITE_SUBAGENT } from "../src/host/policy.mjs";
import { SessionStation } from "../src/station/station.mjs";

function rwContext() {
	const branch = [{ type: "session_init", agent: "worker", readOnly: false, tools: ["read", "write"] }];
	return { sessionManager: { getSessionId: () => "s1", getBranch: () => branch } };
}

function stationWith(tickets, pi = { getActiveTools: () => ["read"] }) {
	return new SessionStation(
		{ getSessionId: () => "s1" },
		pi,
		tickets,
		{ ports: () => ({}) },
		null,
	);
}

beforeEach(() => resetDiagnostics());

test("policy() is a query and never dispatches the todo grant", () => {
	let calls = 0;
	const station = stationWith({
		activateTools: () => {
			calls += 1;
			return Promise.resolve();
		},
	});
	station.policy(rwContext());
	expect(calls).toBe(0);
	station.ensureTools(rwContext());
	expect(calls).toBe(1);
});

test("a rejecting activateTools ticket is recorded, not left unhandled", async () => {
	const station = stationWith({
		activateTools: () => Promise.reject(new Error("activation moved")),
	});
	station.syncTodo(READ_WRITE_SUBAGENT);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(diagnosticsSnapshot().some((entry) => entry.domain === "tickets")).toBe(true);
});
```

说明：`policy` 测试在修复前 `calls=1`，修复后 `calls=0`；拒绝测试在修复前 diagnostics 无 `tickets`（且可能触发未处理拒绝），修复后有记录。未跑红，按 tdd-crowdsource 的“不跑 Red”执行。

## 6. 与用户未提交改动的重叠

工作区 40 文件未提交，`station.mjs`、`gates.mjs`、`execute.mjs`、`tickets.mjs`、`fork-controls.mjs` 都在其中。主题是 permission→targets 与 scope_join interruptible。

- Phase 1 只改 `station.mjs` 的 289 / 313 / 654-672 / 752-800 与 `eslint.config.mjs`；不改 `gates.mjs`、`execute.mjs`、`tickets.mjs`。
- 用户改动集中在 `finalizeJoin`/`settleInterruptedJoin`/`execute.mjs:controlContext` 与 fork 参数校验；与 Phase 1 行段不重叠。
- 提交时用 `commit.draft` 只提交本切片写入的行，绝不把用户的改动一起提交。

## 7. 风险与待确认

- 移除 `policy` 内的 `syncTodo` 后，`todo` 只在 `prepareRequest`/`onBeforeAgentStart` 前授予。若宿主在未经过这两个钩子的情况下注入工具调用，RW 子代理可能暂时没有 `todo`，relay 关闭；这是安全侧降级，但需在 Phase 1 验证 `todo-any-level` 全绿。
- `dispatchFireAndForget` 只记录不重试；`todoGrantKey` 仍阻止在 active 集合未变时重试，行为与原实现一致。
- `onContext` 重排是行为保持整理；`settleReceiptFolds` 仍先于 `maybeRebase`。若 receipt 折叠测试失败，回退到原顺序并只保留 `collapsed` 变量。
- `no-dupe-class-members` 可能暴露其他重复成员；若有，逐个确认后删除，不批量 `replace_all`。
- 861 绿不等于接线正确；Phase 2 的契约测试改组合根才是“接线通过”的证据。
