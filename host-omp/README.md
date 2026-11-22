# herdchestra-host-omp

The omp binding for [`herdchestra-lite2`](../README.md), and the plugin entry
point. omp loads this package; the core is its dependency.

```json
"dependencies": { "herdchestra-lite2": "link:.." }
```

## What lives here

| Path | Owns |
| --- | --- |
| `src/main.mjs` | `activate(pi, env)`: the only extension entry, declared in `omp.extensions` |
| `src/activation/` | the composition root: ports, hooks, tools, commands, capture |
| `src/host/` | every omp seam: capture, branch sessions, display, status, pricing, model adapters |
| `src/host/host-tickets.mjs` | the tickets whose body is a host call: steer, prompt, tool activation, scoped model switch |
| `src/host/fork-spawn-ticket.mjs` | child session creation |
| `skills/` | generated at install by `sync:plugin` — a mirror of the core's skills, where the host discovers them. Not shipped in `files`: the repository has no such directory. |

Everything else — stations, pure tickets, the scope ledger, relay, prompts,
and the prompt documents under `resources/` — belongs to the core package and
is imported by name:

```js
import { createStationRegistry, forkTicket, loadDoc } from "herdchestra-lite2";
```

The core never imports this package. `tests/architecture/core-host-free.test.mjs`
and the `no-restricted-imports` rule in `eslint.config.mjs` enforce both
directions: core may not name a host module, and this package may not reach the
core by relative path.

## Install

The sync script materializes both packages into the host's plugin directory:

```
bun run sync:plugin            # from the repository root
bun run sync:plugin --check    # report drift only
```

That copies this package to `~/.omp/plugins/node_modules/herdchestra-host-omp`
and the core to its `node_modules/herdchestra-lite2`. Restart the session
afterward; omp loads the installed copy, not the working tree.
