// Backend: Express HTTP + WebSocket + PTY + chokidar artifacts watcher.
// One WS connection ↔ one terminal session ↔ one artifacts directory.

import { createServer } from 'node:http';
import { mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar, { type FSWatcher } from 'chokidar';
import * as pty from 'node-pty';

import type { ServerMessage, ClientMessage, ArtifactFile } from '../shared/protocol.ts';
import { ARTIFACTS_SYSTEM_PROMPT } from './system-prompt.ts';

const PORT = Number(process.env.SERVER_PORT ?? 7681);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();
const SESSIONS_ROOT = path.join(os.tmpdir(), 'ticket-web', 'sessions');

const app = express();

// Serve artifact file contents. Path-traversal-safe.
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
  res.sendFile(resolved);
});

// Health / debug.
app.get('/api/sessions', async (_req, res) => {
  await mkdir(SESSIONS_ROOT, { recursive: true });
  const entries = await readdir(SESSIONS_ROOT);
  res.json({ sessions: entries });
});

const httpServer = createServer(app);
// perMessageDeflate adds latency and CPU for tiny per-keystroke frames.
// PTY traffic is small and not very compressible — keep it off.
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
}

const sessions = new Map<WebSocket, SessionState>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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

async function startSession(ws: WebSocket): Promise<SessionState> {
  const id = randomUUID();
  const sessionDir = path.join(SESSIONS_ROOT, id);
  const artifactsDir = path.join(sessionDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const ptyProc = pty.spawn(
    CLAUDE_BIN,
    ['--append-system-prompt', ARTIFACTS_SYSTEM_PROMPT, '--add-dir', artifactsDir],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_ARTIFACTS_DIR: artifactsDir,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      } as Record<string, string>,
    }
  );

  ptyProc.onData((data) => send(ws, { ch: 'pty', data }));
  ptyProc.onExit(({ exitCode, signal }) =>
    send(ws, { ch: 'pty-exit', code: exitCode, signal: signal ?? null })
  );

  // Watch the artifacts directory. awaitWriteFinish prevents firing on
  // partially-written files when Claude is streaming a large artifact.
  const watcher = chokidar.watch(artifactsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

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
      send(ws, { ch: 'artifacts', event, file });
    } catch {
      // raced with delete; ignore
    }
  }

  watcher.on('add', (p) => emitFile('add', p));
  watcher.on('change', (p) => emitFile('change', p));
  watcher.on('unlink', (p) =>
    send(ws, { ch: 'artifacts', event: 'unlink', path: path.relative(artifactsDir, p) })
  );

  return { id, artifactsDir, ptyProc, watcher };
}

wss.on('connection', async (ws, req) => {
  // Disable Nagle so each keystroke ships immediately instead of waiting
  // for either the ACK or the 40ms timer.
  const sock = req.socket as { setNoDelay?: (b: boolean) => void } | undefined;
  sock?.setNoDelay?.(true);

  let state: SessionState;
  try {
    state = await startSession(ws);
  } catch (err) {
    send(ws, { ch: 'error', message: `failed to start session: ${(err as Error).message}` });
    ws.close();
    return;
  }
  sessions.set(ws, state);
  send(ws, { ch: 'hello', sessionId: state.id, artifactsDir: state.artifactsDir });
  // Send initial (empty-ish) artifact listing so the client can render.
  send(ws, { ch: 'artifacts-list', files: await listArtifacts(state.artifactsDir) });

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    const s = sessions.get(ws);
    if (!s) return;
    if (msg.ch === 'pty' && msg.op === 'input') {
      s.ptyProc.write(msg.data);
    } else if (msg.ch === 'pty' && msg.op === 'resize') {
      try {
        s.ptyProc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {
        /* pty may have exited */
      }
    } else if (msg.ch === 'artifacts' && msg.op === 'list') {
      send(ws, { ch: 'artifacts-list', files: await listArtifacts(s.artifactsDir) });
    }
  });

  ws.on('close', async () => {
    const s = sessions.get(ws);
    if (!s) return;
    sessions.delete(ws);
    try {
      s.ptyProc.kill();
    } catch {
      /* already dead */
    }
    await s.watcher.close();
    // Keep the artifacts dir on disk so the user can recover; a separate
    // GC sweep handles cleanup.
  });
});

// Periodic GC: drop session dirs older than 24h with no live WS.
async function gc() {
  try {
    const entries = await readdir(SESSIONS_ROOT).catch(() => [] as string[]);
    const liveIds = new Set([...sessions.values()].map((s) => s.id));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const id of entries) {
      if (liveIds.has(id)) continue;
      const dir = path.join(SESSIONS_ROOT, id);
      const st = await stat(dir).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await import('node:fs/promises').then((fs) =>
          fs.rm(dir, { recursive: true, force: true })
        );
      }
    }
  } catch {
    /* best effort */
  }
}
setInterval(gc, 60 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`[ticket.web] http://localhost:${PORT}`);
  console.log(`[ticket.web] sessions: ${SESSIONS_ROOT}`);
  console.log(`[ticket.web] project:  ${PROJECT_DIR}`);
  console.log(`[ticket.web] claude:   ${CLAUDE_BIN}`);
});
