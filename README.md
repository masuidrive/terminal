# terminal

Run **Claude Code** or **OpenAI Codex** in your browser — a real terminal on
the left, a live artifacts pane on the right, tabs on top. Works on desktop
and is built to be usable from a phone.

The backend spawns the chosen CLI agent in a PTY per tab, watches a dedicated
artifacts directory, and streams everything over WebSocket.

```
┌─ [claude 1] [codex 2] [+] ──────────────┬────────────────────────┐
│                                         │  Artifacts             │
│   xterm.js  (real claude / codex TUI)   │  ┌──────┬─ rendered ─┐ │
│                                         │  │ list │            │ │
│   [ Esc ][ C-b ][ / ][ - ][ _ ][ ↑ ]    │  └──────┴────────────┘ │
└─────────────────────────────────────────┴────────────────────────┘
```

## Quick start

```bash
npx github:masuidrive/terminal
```

Run it from the project directory you want the agent to work in. It prints a
URL — open it in a browser:

```
  terminal running at:
    http://localhost:4567/
```

On first run `npx` clones the repo, installs dependencies (this compiles the
`node-pty` native module) and builds the client, so it takes a minute. Later
runs are cached and start instantly.

When a tab opens, a modal asks which agent to start — **Claude Code** or
**Codex**.

## Requirements

- Node.js **≥ 20.11**
- The CLI you want to use on your `PATH`: [`claude`](https://claude.com/claude-code)
  and/or [`codex`](https://developers.openai.com/codex/cli)
- A C toolchain for the `node-pty` native build on first install
  (`python3`, `make`, a C/C++ compiler)
- macOS or Linux (PTY-based; Windows is untested)

## Options

```bash
npx github:masuidrive/terminal --lan      # also reachable from other devices on the LAN
npx github:masuidrive/terminal --yolo     # spawn the agent without permission prompts
npx github:masuidrive/terminal --debug    # verbose logs + per-request access log
npx github:masuidrive/terminal --port 8080  # pin a port (errors if it is busy)
```

By default the server binds to `127.0.0.1` (localhost only). `--lan` binds all
interfaces so you can open it from a phone on the same network — the URL list
then includes the LAN / Tailscale addresses.

The default port is `4567`; if it is busy the server rolls forward to the next
free port. A port pinned with `--port` (or `SERVER_PORT`) is used as-is and
fails fast if it is already in use.

Environment variables:

| Var           | Default         | Purpose                            |
|---------------|-----------------|------------------------------------|
| `SERVER_PORT` | `4567`          | HTTP + WebSocket port              |
| `CLAUDE_BIN`  | `claude`        | Path to the `claude` binary        |
| `CODEX_BIN`   | `codex`         | Path to the `codex` binary         |
| `PROJECT_DIR` | `process.cwd()` | Working directory passed to agents |

## Artifacts

The artifacts pane renders files the agent writes to `$CLAUDE_ARTIFACTS_DIR`:

- Markdown (GFM + ```mermaid blocks), HTML (sandboxed iframe), SVG / images
- Mermaid diagrams, JSON / CSV tables, syntax-highlighted code

Claude Code is told about the directory via `--append-system-prompt`. Codex
is spawned plain, so artifacts only auto-populate for Claude sessions.

## Development

```bash
npm install
npm run dev                # Vite dev server + backend
npm run dev -- --yolo      # skip the agent's permission prompts
npm run dev -- --debug     # verbose backend logs
```

Open <http://localhost:5172>. Vite proxies `/ws`, `/api` and `/artifacts` to
the backend on `4567`; in dev the backend is always LAN-exposed.

## How it works

- **One PTY per tab.** Each tab opens its own WebSocket; the server spawns
  `claude` or `codex` in a PTY. Sessions outlive the socket — a dropped
  connection reattaches to the same PTY (with a connection-timeout guard and
  reconnect-on-wake so a slept phone recovers without a reload).
- **Artifacts are files on disk.** chokidar watches `$CLAUDE_ARTIFACTS_DIR`
  and streams add / change / unlink events to the client.
- **HTML artifacts** render in an iframe sandboxed with `allow-scripts` only
  (no `allow-same-origin`), so a generated page can't reach the app's origin.
- **Production is one process.** `prepare` builds the client; the server
  serves it and the API on a single port. Dev uses Vite instead.

## Why interactive agents instead of `-p` / SDK?

xterm.js + PTY keeps the agent on the **interactive** side — the normal
subscription, plus skills / plugins / MCP / hooks — instead of the separate
programmatic / Agent SDK billing.

## Note

Meant for **personal use on your own machine**. Sharing one subscription
across multiple users via this UI would violate the provider's terms.
