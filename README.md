# ticket.web

Personal web frontend for `claude` (Claude Code) CLI. xterm.js terminal on the
left, live artifacts pane on the right, tabs on top.

The backend spawns `claude` in a PTY per tab, watches a dedicated
artifacts directory, and streams everything over WebSocket. Claude is told
about the directory via `--append-system-prompt` and writes files there
whenever something is better viewed alongside the chat.

## Layout

```
┌─ [claude 1] [claude 2] [+] ─────────────────────────┐
│                          │                          │
│   xterm.js               │   Artifacts              │
│   (real claude TUI)      │   ┌──────┬─ rendered ─┐  │
│                          │   │ list │            │  │
│                          │   │      │            │  │
└──────────────────────────┴──────────────────────────┘
```

## Quick start

```bash
npm install
npm run dev                # normal: claude prompts for permissions
npm run dev -- --yolo      # YOLO: claude spawned with --dangerously-skip-permissions
YOLO=1 npm run dev         # same as above, env-var form
```

Open <http://localhost:5172> (the dev server binds to `0.0.0.0:5172` so you
can also hit it from another device on the LAN). Vite proxies WebSocket
and `/artifacts/*` to the Node backend on port 7681.

## Configuration

Backend env vars:

| Var               | Default                                | Purpose                                |
|-------------------|----------------------------------------|----------------------------------------|
| `SERVER_PORT`     | `7681`                                 | Backend HTTP+WS port                   |
| `CLAUDE_BIN`      | `claude`                               | Path to the `claude` binary            |
| `PROJECT_DIR`     | `process.cwd()`                        | Working directory passed to claude     |

Artifact storage: `$TMPDIR/ticket-web/sessions/<uuid>/artifacts/`. Old
session dirs are GC'd after 24h.

## Architecture notes

- **One PTY per tab.** Each tab opens its own WebSocket; the server spawns
  `claude --append-system-prompt <…> --add-dir <artifacts>` in a PTY.
- **Artifacts are files on disk.** No streaming JSON parsing. Claude writes
  to `$CLAUDE_ARTIFACTS_DIR`; chokidar watches the dir and emits add /
  change / unlink events to the client.
- **Renderers dispatch on extension.** Markdown → react-markdown; HTML →
  sandboxed iframe; SVG/images → native; Mermaid → mermaid.js render;
  JSON/CSV → table; everything else → code preview.
- **System prompt addition** lives in `server/system-prompt.ts` so it's
  easy to tweak.

## Why interactive `claude` instead of `claude -p`?

After 2026-06-15, programmatic usage (`claude -p`, Agent SDK, third-party
apps via Agent SDK) draws from a separate monthly Agent SDK credit billed
at API rates. Interactive Claude Code still runs against the normal
subscription limits. xterm.js + PTY keeps us on the interactive side, and
it gives us skills/plugins/MCP/hooks for free.

## ToS

This is meant for **personal use on your own machine**. Sharing one
subscription across multiple users via this UI would violate Anthropic's
subscription terms.
