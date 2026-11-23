# host-omp-ui web

This directory hosts the same-origin SPA that reuses DeerFlow's UI library
(`../deer-flow/frontend/src/components/ui` and `ai-elements`) without modifying
any DeerFlow file.

## Install

`/home` is tight on this machine, so `node_modules` is symlinked into `/tmp`:

```bash
cd host-omp-ui/web
bun run install:safe
```

`install:safe` creates `${TMPDIR:-/tmp}/omp-ui-web/node_modules`, symlinks
`node_modules` to it, and sets `BUN_INSTALL_CACHE_DIR` away from `/home`.
A fresh clone must run it once; `/tmp` is cleared on reboot.

## Build

From the plugin root, `build:web` writes `web/dist/`:

```bash
cd host-omp-ui
bun run build:web
```

`scripts/build.mjs` resolves `@/` against `../deer-flow/frontend/src`, shims six
DeerFlow core modules under `shims/`, bundles `src/main.tsx` with `Bun.build`,
compiles `src/styles/app.css` with Tailwind 4, and copies `src/index.html` to
`web/dist/`. The plugin serves the resulting SPA and its own authenticated WebSocket
protocol; it does not require the DeerFlow backend or a Next.js server.

## Run

Install or link `host-omp-ui` as an independent omp extension using omp's
plugin manager, then start an interactive omp session. Use `/web` to display
the local URL and its access token. `host-omp` is not required. The server
binds to loopback; treat the URL and token as credentials, because a connected
browser can control the session and answer prompts.

The Web manager uses one fixed local port for all running omp instances. It
lists machine-wide sessions and routes each browser to the selected instance.
Opening a historical session without a running instance starts a real omp in
tmux at the original working directory; `tmux a` can attach to it. A startup or
command failure is reported instead of presenting a read-only conversation.
The manager starts with the first omp and exits after the last instance leaves.
While it runs, a system-tray icon opens the Web UI in the default browser on a
left click; the icon lives exactly as long as the manager. Tray support uses
the desktop already present: Linux needs Python 3 with PyGObject and a
StatusNotifier watcher, macOS currently uses the Swift toolchain, and Windows
uses PowerShell with WinForms. If that runtime is missing, the failure is
recorded as a diagnostic and the Web UI itself still works. Linux is the only
platform exercised here; macOS and Windows tray behavior is implemented but
not yet verified on those systems.

Every omp main session that loads this plugin registers with the manager,
whether it runs in the TUI, over RPC, or in print mode. An RPC session has no
TUI, but can still receive plain text through the host; attachments, slash
commands and the TUI surface are unavailable there and the Web UI says so
instead of pretending the action worked. Print sessions are short-lived, so
they normally appear only while the run lasts. omp processes started with
`--no-extensions`, or otherwise without this plugin, cannot be controlled by
the plugin; they are not scanned or adopted.

Attachments can be sent from the composer, including with steer and follow-up
messages. The bridge validates supported image formats and file-size limits.

The TUI surface panel provides structured controls and a keyboard passthrough
for other screens. Some terminal-only rendering, cursor behavior and arbitrary
custom components may not have an identical Web presentation.

## Prerequisites (submodule + formal dependency)

DeerFlow is pinned as a Git submodule at the repository root:

```bash
git submodule update --init --recursive
```

`host-omp-ui/web/vendor/deer-flow-ui` is a thin package named
`@herd/deer-flow-ui`. Its explicit `exports` re-export only the DeerFlow UI
components this SPA uses, and `host-omp-ui/web/package.json` declares it as
`"@herd/deer-flow-ui": "file:./vendor/deer-flow-ui"`. The submodule commit
locks the upstream DeerFlow version; no DeerFlow source file is modified.

Then install and build:

```bash
cd host-omp-ui/web
bun install
bun run build
```

If the submodule is missing, `scripts/build.mjs` exits non-zero with:
`deer-flow submodule missing; run: git submodule update --init --recursive`.
