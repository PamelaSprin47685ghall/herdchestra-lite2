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
| `src/host/branch-session.mjs` | child session creation, over the shared SessionManager |

Skills are not a host asset. The core carries them under `resources/skills/` and inlines every body into the managed system prompt.

Everything else — stations, pure tickets, the scope ledger, relay, prompts,
and the prompt documents under `resources/` — belongs to the core package and
is imported by name:

```js
import { createEngine } from "herdchestra-lite2";
```

That is the whole dependency: the core hands back one engine (stations, tool
catalog, scope read model, text renderer, ports, fork wiring) and takes the
host's facts plus its async verbs.

The core never imports this package. `tests/architecture/core-host-free.test.mjs`
and the `no-restricted-imports` rule in `eslint.config.mjs` enforce both
directions: core may not name a host module, and this package may not reach the
core by relative path.

## Install

Two modes, and `sync:plugin` refuses to blur them:

```
omp plugins link host-omp      # dev: this directory is the install
omp plugins install <git-url>  # host-owned copy
bun run sync:plugin            # report the install shape; writes only for --vendor
bun scripts/sync-plugin.mjs --check
```

A linked install is a symlink at this directory, so the source is live and the
sync writes nothing. A host-owned `omp plugins install` is classified as an
installed copy and is also left alone. Only an explicit `--vendor` run fills a
real directory: this package at the target root, and the core under `node_modules/herdchestra-lite2`. Restart the session afterward;
modules load at process start.
