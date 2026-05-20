// Backend: Express HTTP + WebSocket + PTY + chokidar artifacts watcher.
//
// Sessions are keyed by id and live INDEPENDENT of any single WebSocket
// connection. Closing the WebSocket does not kill the PTY — the session
// keeps running, accumulating output in a recent-output ring buffer, until
// either (a) a new WS reattaches with ?session=<id> and replays the buffer,
// or (b) the idle GC sweep reaps it.
//
// Heartbeat: server pings every 30s; if no pong before next tick, the
// socket is terminated. The next client connect reattaches.

import { createServer } from 'node:http';
import { mkdir, stat, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar, { type FSWatcher } from 'chokidar';
import * as pty from 'node-pty';

import type { ServerMessage, ClientMessage, ArtifactFile } from '../shared/protocol.ts';
import { buildSystemPrompt } from './system-prompt.ts';

const PORT = Number(process.env.SERVER_PORT ?? 7681);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();
const YOLO = process.env.YOLO === '1';
const SESSIONS_ROOT = path.join(os.tmpdir(), 'ticket-web', 'sessions');
const RECENT_BUFFER_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30 * 1000;
// Sessions live until either the server shuts down, the client explicitly
// destroys them (DELETE /api/sessions/:id), or claude itself exits. There
// is no idle GC — closing or reloading the browser leaves the PTY running.

const app = express();

app.get('/artifacts/:sid/*splat', async (req, res) => {
  const sid = req.params.sid;
  const splat = (req.params as Record<string, string | string[]>).splat;
  const rel = Array.isArray(splat) ? splat.join('/') : (splat ?? '');
  const base = path.join(SESSIONS_ROOT, sid, 'artifacts');
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    res.status(403).end('forbidden');
    return;
  }
  if (!existsSync(resolved)) {
    res.status(404).end('not found');
    return;
  }
  // HTML artifacts render in a sandboxed iframe without `allow-same-origin`,
  // so their JS treats this endpoint as cross-origin. Allow sibling fetches
  // (./data.json, etc.) by opting into CORS for artifact responses.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(resolved);
});

app.get('/api/info', (_req, res) => {
  res.json({ projectDir: PROJECT_DIR });
});

app.get('/api/sessions', (_req, res) => {
  res.json({
    sessions: [...sessions.keys()],
    live: [...sessions.values()].map((s) => ({
      id: s.id,
      attached: !!s.ws,
      idleMs: Date.now() - s.lastActivity,
    })),
  });
});

// Explicit teardown — called by the client when the user closes a tab.
// Idempotent; returns 204 whether or not the id was live.
app.delete('/api/sessions/:id', async (req, res) => {
  const state = sessions.get(req.params.id);
  if (state) {
    try { state.ptyProc.kill(); } catch { /* ignore */ }
    await state.watcher.close().catch(() => undefined);
    if (state.ws && state.ws.readyState === state.ws.OPEN) {
      try { state.ws.close(4001, 'session destroyed'); } catch { /* ignore */ }
    }
    sessions.delete(state.id);
    await rm(path.join(SESSIONS_ROOT, state.id), { recursive: true, force: true })
      .catch(() => undefined);
  }
  res.status(204).end();
});

const httpServer = createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: false,
});

interface SessionState {
  id: string;
  artifactsDir: string;
  ptyProc: pty.IPty;
  watcher: FSWatcher;
  ws: WebSocket | null;
  /** Recent PTY output, capped to RECENT_BUFFER_BYTES, used to repaint
   *  xterm scrollback when a client reattaches. */
  recent: string;
  lastActivity: number;
  /** Last size requested by a client. Used to spawn replacement PTYs at
   *  the correct dimensions (currently unused — we spawn once and resize
   *  on first client message). */
  cols: number;
  rows: number;
}

const sessions = new Map<string, SessionState>();

function send(target: SessionState | WebSocket, msg: ServerMessage) {
  const ws = target instanceof WebSocket ? target : target.ws;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function appendRecent(state: SessionState, data: string) {
  const combined = state.recent + data;
  state.recent = combined.length > RECENT_BUFFER_BYTES
    ? combined.slice(combined.length - RECENT_BUFFER_BYTES)
    : combined;
  state.lastActivity = Date.now();
}

async function listArtifacts(dir: string): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = [];
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        const st = await stat(full);
        out.push({
          path: path.relative(dir, full),
          size: st.size,
          mtime: st.mtimeMs,
          ext: path.extname(ent.name).slice(1).toLowerCase(),
        });
      }
    }
  }
  if (existsSync(dir)) await walk(dir);
  return out;
}

async function createSession(): Promise<SessionState> {
  const id = randomUUID();
  const sessionDir = path.join(SESSIONS_ROOT, id);
  const artifactsDir = path.join(sessionDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const cols = 120;
  const rows = 32;
  const claudeArgs = [
    '--append-system-prompt', buildSystemPrompt(),
    '--add-dir', artifactsDir,
  ];
  if (YOLO) {
    // YOLO mode: claude was started with --yolo (or YOLO=1). Skip every
    // permission prompt.
    claudeArgs.push('--dangerously-skip-permissions');
  }
  const ptyProc = pty.spawn(
    CLAUDE_BIN,
    claudeArgs,
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_ARTIFACTS_DIR: artifactsDir,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      } as Record<string, string>,
    }
  );

  const state: SessionState = {
    id,
    artifactsDir,
    ptyProc,
    watcher: null as unknown as FSWatcher, // assigned below
    ws: null,
    recent: '',
    lastActivity: Date.now(),
    cols,
    rows,
  };

  ptyProc.onData((data) => {
    appendRecent(state, data);
    send(state, { ch: 'pty', data });
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    send(state, { ch: 'pty-exit', code: exitCode, signal: signal ?? null });
    state.watcher?.close().catch(() => undefined);
    sessions.delete(state.id);
  });

  const watcher = chokidar.watch(artifactsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  state.watcher = watcher;

  async function emitFile(event: 'add' | 'change', full: string) {
    try {
      const st = await stat(full);
      if (!st.isFile()) return;
      const file: ArtifactFile = {
        path: path.relative(artifactsDir, full),
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(full).slice(1).toLowerCase(),
      };
      send(state, { ch: 'artifacts', event, file });
    } catch {
      // raced with delete
    }
  }
  watcher.on('add', (p) => emitFile('add', p));
  watcher.on('change', (p) => emitFile('change', p));
  watcher.on('unlink', (p) =>
    send(state, { ch: 'artifacts', event: 'unlink', path: path.relative(artifactsDir, p) })
  );

  return state;
}

async function attachWs(state: SessionState, ws: WebSocket) {
  // Boot off any prior client (only one viewer per session at a time).
  if (state.ws && state.ws !== ws && state.ws.readyState === state.ws.OPEN) {
    try {
      state.ws.close(4000, 'replaced by newer connection');
    } catch {
      /* ignore */
    }
  }
  state.ws = ws;
  state.lastActivity = Date.now();

  send(state, { ch: 'hello', sessionId: state.id, artifactsDir: state.artifactsDir });
  if (state.recent) {
    // Replay the recent buffer so the client's xterm picks up the current
    // PTY screen state without needing a redraw from claude.
    send(state, { ch: 'pty', data: state.recent });
  }
  send(state, { ch: 'artifacts-list', files: await listArtifacts(state.artifactsDir) });
}

wss.on('connection', async (ws, req) => {
  // Disable Nagle so each keystroke ships immediately.
  const sock = req.socket as { setNoDelay?: (b: boolean) => void } | undefined;
  sock?.setNoDelay?.(true);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const requestedId = url.searchParams.get('session');

  let state: SessionState | undefined =
    requestedId ? sessions.get(requestedId) : undefined;
  if (!state) {
    try {
      state = await createSession();
      sessions.set(state.id, state);
    } catch (err) {
      ws.send(
        JSON.stringify({ ch: 'error', message: `failed to start session: ${(err as Error).message}` })
      );
      ws.close();
      return;
    }
  }
  await attachWs(state, ws);

  // Heartbeat. ws library exposes ping/pong frames; the browser handles
  // pong replies automatically.
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const hb = setInterval(() => {
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS);

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (!state) return;
    state.lastActivity = Date.now();
    if (msg.ch === 'pty' && msg.op === 'input') {
      state.ptyProc.write(msg.data);
    } else if (msg.ch === 'pty' && msg.op === 'resize') {
      const cols = Math.max(1, msg.cols);
      const rows = Math.max(1, msg.rows);
      state.cols = cols;
      state.rows = rows;
      try {
        state.ptyProc.resize(cols, rows);
      } catch {
        /* pty may have exited */
      }
    } else if (msg.ch === 'artifacts' && msg.op === 'list') {
      send(state, { ch: 'artifacts-list', files: await listArtifacts(state.artifactsDir) });
    }
  });

  ws.on('close', () => {
    clearInterval(hb);
    // Detach only — keep PTY and watcher alive for reattach.
    if (state && state.ws === ws) {
      state.ws = null;
    }
  });
});

// Stale on-disk session dirs from prior crashes — anything > 24h old and
// not in our live map. The live sessions themselves have no idle timeout.
setInterval(async () => {
  try {
    const entries = await readdir(SESSIONS_ROOT).catch(() => [] as string[]);
    const live = new Set(sessions.keys());
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const id of entries) {
      if (live.has(id)) continue;
      const dir = path.join(SESSIONS_ROOT, id);
      const st = await stat(dir).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } catch {
    /* best effort */
  }
}, 60 * 60 * 1000).unref();

// When the server shuts down (SIGINT / SIGTERM), tear down every live
// session so claude doesn't leak as an orphan process group.
async function shutdown() {
  for (const state of sessions.values()) {
    try { state.ptyProc.kill(); } catch { /* ignore */ }
    state.watcher.close().catch(() => undefined);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, () => {
  console.log(`[ticket.web] http://localhost:${PORT}`);
  console.log(`[ticket.web] sessions: ${SESSIONS_ROOT}`);
  console.log(`[ticket.web] project:  ${PROJECT_DIR}`);
  console.log(`[ticket.web] claude:   ${CLAUDE_BIN}`);
  console.log(`[ticket.web] mode:     ${YOLO ? '🐉 YOLO (--dangerously-skip-permissions)' : 'normal'}`);
});
