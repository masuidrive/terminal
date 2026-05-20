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
import { stat, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import * as pty from 'node-pty';

import type { ServerMessage, ClientMessage, ArtifactFile, AgentKind } from '../shared/protocol.ts';
import { buildSystemPrompt } from './system-prompt.ts';

const BASE_PORT = Number(process.env.SERVER_PORT ?? 4567);
// When the user did not pin a port (no --port, no SERVER_PORT), the bin
// sets PORT_AUTO so a busy port rolls forward to the next free one. A
// pinned port that is busy is a hard error instead.
const PORT_AUTO = process.env.PORT_AUTO === '1';
const MAX_PORT_TRIES = 20;
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();
const YOLO = process.env.YOLO === '1';
const DEBUG = process.env.DEBUG === '1';
// localhost-only by default; the `--lan` flag binds all interfaces so the
// UI is reachable from a phone / other device on the same network.
const LAN = process.env.LAN === '1';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

// Whether an executable is resolvable — either an absolute path or a bare
// name found on PATH. Used to decide which agents the picker offers.
function hasBin(bin: string): boolean {
  if (bin.includes(path.sep)) {
    try { accessSync(bin, fsConstants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, bin), fsConstants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

const AVAILABLE_AGENTS: AgentKind[] = [];
if (hasBin(CLAUDE_BIN)) AVAILABLE_AGENTS.push('claude');
if (hasBin(CODEX_BIN)) AVAILABLE_AGENTS.push('codex');

// Binary + argv for a given agent. Both get the artifacts brief: claude
// via --append-system-prompt, codex via `-c developer_instructions=`
// (codex appends that to its model-visible prompt). claude additionally
// gets --add-dir so it may write outside the project without prompting.
function agentCommand(agent: AgentKind, artifactsDir: string): { bin: string; args: string[] } {
  if (agent === 'codex') {
    const args = ['-c', `developer_instructions=${buildSystemPrompt()}`];
    if (YOLO) args.push('--dangerously-bypass-approvals-and-sandbox');
    return { bin: CODEX_BIN, args };
  }
  const args = [
    '--append-system-prompt', buildSystemPrompt(),
    '--add-dir', artifactsDir,
  ];
  if (YOLO) args.push('--dangerously-skip-permissions');
  return { bin: CLAUDE_BIN, args };
}
// One artifacts directory shared by every session, so claude in one tab
// and codex in another (and successive sessions) all see the same files.
const ARTIFACTS_DIR = path.join(os.tmpdir(), 'ticket-web', 'artifacts');
const RECENT_BUFFER_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30 * 1000;
// Sessions live until either the server shuts down, the client explicitly
// destroys them (DELETE /api/sessions/:id), or claude itself exits. There
// is no idle GC — closing or reloading the browser leaves the PTY running.

const app = express();

// Per-request access log, only under --debug.
if (DEBUG) {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.url}`);
    next();
  });
}

// The :sid segment is vestigial — artifacts are shared, not per-session —
// but kept so existing client URLs (/artifacts/<sid>/<path>) still resolve.
app.get('/artifacts/:sid/*splat', async (req, res) => {
  const splat = (req.params as Record<string, string | string[]>).splat;
  const rel = Array.isArray(splat) ? splat.join('/') : (splat ?? '');
  const base = ARTIFACTS_DIR;
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
  res.json({ projectDir: PROJECT_DIR, agents: AVAILABLE_AGENTS });
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
    if (state.ws && state.ws.readyState === state.ws.OPEN) {
      try { state.ws.close(4001, 'session destroyed'); } catch { /* ignore */ }
    }
    sessions.delete(state.id);
  }
  res.status(204).end();
});

// Serve the built client. In dev this directory doesn't exist (vite serves
// the client and proxies /api + /ws + /artifacts here instead); in a
// production / npx run `prepare` has built it and the server is the only
// process, so it serves the SPA on the same origin as the API.
const CLIENT_DIR = path.join(import.meta.dirname, '..', 'dist');
if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
}

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
  let combined = state.recent + data;
  if (combined.length > RECENT_BUFFER_BYTES) {
    combined = combined.slice(combined.length - RECENT_BUFFER_BYTES);
    // Resync to the start of a line: an escape sequence never spans '\n',
    // so starting the buffer just after one guarantees a later replay
    // never begins mid-sequence (which would garble the output).
    const nl = combined.indexOf('\n');
    if (nl !== -1) combined = combined.slice(nl + 1);
  }
  state.recent = combined;
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

// One watcher on the shared artifacts directory, broadcasting changes to
// every connected session.
mkdirSync(ARTIFACTS_DIR, { recursive: true });

function broadcast(msg: ServerMessage) {
  for (const s of sessions.values()) send(s, msg);
}

const artifactsWatcher = chokidar.watch(ARTIFACTS_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
});

async function emitArtifact(event: 'add' | 'change', full: string) {
  try {
    const st = await stat(full);
    if (!st.isFile()) return;
    broadcast({
      ch: 'artifacts',
      event,
      file: {
        path: path.relative(ARTIFACTS_DIR, full),
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(full).slice(1).toLowerCase(),
      },
    });
  } catch {
    // raced with delete
  }
}
artifactsWatcher.on('add', (p) => emitArtifact('add', p));
artifactsWatcher.on('change', (p) => emitArtifact('change', p));
artifactsWatcher.on('unlink', (p) =>
  broadcast({ ch: 'artifacts', event: 'unlink', path: path.relative(ARTIFACTS_DIR, p) })
);

async function createSession(agent: AgentKind): Promise<SessionState> {
  const id = randomUUID();
  const cols = 120;
  const rows = 32;
  const { bin, args } = agentCommand(agent, ARTIFACTS_DIR);
  const ptyProc = pty.spawn(
    bin,
    args,
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_ARTIFACTS_DIR: ARTIFACTS_DIR,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      } as Record<string, string>,
    }
  );

  const state: SessionState = {
    id,
    artifactsDir: ARTIFACTS_DIR,
    ptyProc,
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
    sessions.delete(state.id);
  });

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
    // PTY screen state. Clear the screen and scrollback first (CSI 3J
    // erases xterm's scrollback) so a reconnect doesn't stack the
    // replayed TUI redraw frames on top of stale buffer content.
    send(state, { ch: 'pty', data: '\x1b[3J\x1b[2J\x1b[H' + state.recent });
  }
  send(state, { ch: 'artifacts-list', files: await listArtifacts(state.artifactsDir) });
}

wss.on('connection', async (ws, req) => {
  // Disable Nagle so each keystroke ships immediately.
  const sock = req.socket as { setNoDelay?: (b: boolean) => void } | undefined;
  sock?.setNoDelay?.(true);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const requestedId = url.searchParams.get('session');
  const agent: AgentKind = url.searchParams.get('agent') === 'codex' ? 'codex' : 'claude';

  let state: SessionState | undefined =
    requestedId ? sessions.get(requestedId) : undefined;
  if (!state) {
    try {
      state = await createSession(agent);
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
    // Detach only — keep the PTY alive for reattach.
    if (state && state.ws === ws) {
      state.ws = null;
    }
  });
});

// When the server shuts down (SIGINT / SIGTERM), tear down every live
// session so claude doesn't leak as an orphan process group.
async function shutdown() {
  for (const state of sessions.values()) {
    try { state.ptyProc.kill(); } catch { /* ignore */ }
  }
  artifactsWatcher.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Non-internal IPv4 addresses, so the URL printed at startup is reachable
// from a phone / other device on the same LAN.
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// The error handler armed for the current listen attempt; cleared once a
// bind succeeds so a later runtime error can't hit the retry/exit logic.
let pendingListenError: ((err: NodeJS.ErrnoException) => void) | null = null;

function startListening(port: number, triesLeft: number): void {
  const onError = (err: NodeJS.ErrnoException) => {
    pendingListenError = null;
    if (err.code !== 'EADDRINUSE') {
      console.error(err);
      process.exit(1);
    }
    if (!PORT_AUTO) {
      console.error(`\n  Port ${port} is already in use.\n`);
      process.exit(1);
    }
    if (triesLeft <= 0) {
      console.error(`\n  No free port found near ${BASE_PORT}.\n`);
      process.exit(1);
    }
    startListening(port + 1, triesLeft - 1);
  };
  // A failed listen() emits EADDRINUSE on httpServer, but ws re-emits it on
  // the WebSocketServer — so the catchable handler must live on wss.
  pendingListenError = onError;
  wss.once('error', onError);
  // No success callback here: a callback passed to listen() is registered
  // as a once('listening') handler that survives a failed attempt and
  // would then also fire on the eventual successful bind. The single
  // handler below is armed once instead.
  httpServer.listen(port, HOST);
}

httpServer.once('listening', () => {
  if (pendingListenError) {
    wss.removeListener('error', pendingListenError);
    pendingListenError = null;
  }
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : BASE_PORT;
  const urls = [`http://localhost:${port}/`];
  if (LAN) {
    for (const ip of lanAddresses()) urls.push(`http://${ip}:${port}/`);
  }
  console.log('\n  terminal running at:');
  for (const u of urls) console.log(`    ${u}`);
  console.log('');
  if (AVAILABLE_AGENTS.length === 0) {
    console.error('  Warning: neither claude nor codex was found on PATH.\n');
  }
  if (DEBUG) {
    console.log(`[debug] artifacts: ${ARTIFACTS_DIR}`);
    console.log(`[debug] project:   ${PROJECT_DIR}`);
    console.log(`[debug] agents:    [${AVAILABLE_AGENTS.join(', ')}] (claude=${CLAUDE_BIN}, codex=${CODEX_BIN})`);
    console.log(`[debug] mode:      ${YOLO ? 'YOLO' : 'normal'}, ${LAN ? 'LAN' : 'localhost-only'}`);
  }
});

startListening(BASE_PORT, MAX_PORT_TRIES);
