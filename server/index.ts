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
import { stat, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, accessSync, createWriteStream, readdirSync, rmSync, rmdirSync, constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import * as pty from 'node-pty';

import type {
  ServerMessage,
  ClientMessage,
  ArtifactFile,
  AgentKind,
  SessionSummary,
} from '../shared/protocol.ts';
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
// `-c` / --continue: resume the previous conversation. Applies to the
// first session of this server run only; new tabs after that start fresh.
const CONTINUE = process.env.CONTINUE === '1';
let continuePending = CONTINUE;
// localhost-only by default; the `--lan` flag binds all interfaces so the
// UI is reachable from a phone / other device on the same network.
const LAN = process.env.LAN === '1';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
// When exposed beyond localhost, require a passcode on every non-loopback
// request. The passcode lives in a session cookie (`tw-auth`); loopback
// requests skip auth entirely so localhost stays frictionless even when
// the server also listens on the LAN. A `--passcode <code>` (env
// `PASSCODE`) pins the value across restarts; otherwise we generate a
// fresh 4-char alphanumeric string each run — short enough to type on
// a phone (62^4 ≈ 14 M combinations is plenty against casual LAN
// scanning, especially with no rate-limit-defeating brute-force vector).
const PASSCODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function genPasscode(): string {
  const bytes = randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += PASSCODE_ALPHABET[bytes[i]! % PASSCODE_ALPHABET.length];
  return out;
}
const PASSCODE = process.env.PASSCODE && process.env.PASSCODE.length > 0
  ? process.env.PASSCODE
  : (LAN ? genPasscode() : '');
const AUTH_ENABLED = LAN && PASSCODE.length > 0;

// Treat loopback connections as trusted: even when the server is on
// `--lan`, hitting it from the same machine should be friction-free.
// node's req.socket.remoteAddress prefixes IPv4 over IPv6 with ::ffff:.
function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' ||
         remoteAddress === '::1' ||
         remoteAddress === '::ffff:127.0.0.1';
}

// Tiny no-deps cookie parser — we only ever read `tw-auth`, so the
// general-purpose `cookie-parser` package would be overkill.
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch { /* malformed; skip */ }
  }
  return out;
}

// Constant-time string compare so a wrong passcode can't be cheaply
// guessed character-by-character via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

// Agent for the first window, set by the `terminal claude|codex` positional.
// The client uses it to skip the picker for that one window. Ignored if the
// named agent isn't actually installed.
const initialAgentEnv = process.env.INITIAL_AGENT;
const INITIAL_AGENT: AgentKind | null =
  (initialAgentEnv === 'claude' || initialAgentEnv === 'codex') &&
  AVAILABLE_AGENTS.includes(initialAgentEnv)
    ? initialAgentEnv
    : null;

// Binary + argv for a given agent. Both get the artifacts brief: claude
// via --append-system-prompt, codex via `-c developer_instructions=`
// (codex appends that to its model-visible prompt). claude additionally
// gets --add-dir so it may write outside the project without prompting.
function agentCommand(
  agent: AgentKind,
  artifactsDir: string,
  cont: boolean,
): { bin: string; args: string[] } {
  if (agent === 'codex') {
    const args: string[] = [];
    if (cont) args.push('resume', '--last');
    args.push('-c', `developer_instructions=${buildSystemPrompt()}`);
    if (YOLO) args.push('--dangerously-bypass-approvals-and-sandbox');
    return { bin: CODEX_BIN, args };
  }
  const args: string[] = [];
  if (cont) args.push('--continue');
  args.push('--append-system-prompt', buildSystemPrompt(), '--add-dir', artifactsDir);
  if (YOLO) args.push('--dangerously-skip-permissions');
  return { bin: CLAUDE_BIN, args };
}
// One artifacts directory shared by every session in THIS server, so
// claude in one tab and codex in another (and successive sessions) all
// see the same files. We isolate each server instance under its own
// PID-named subdir so two concurrent `terminal` runs don't trample each
// other (and so shutting one down doesn't wipe the other's artifacts).
const TMP_ROOT = path.join(os.tmpdir(), 'ticket-web');
const INSTANCE_DIR = path.join(TMP_ROOT, String(process.pid));
const ARTIFACTS_DIR = path.join(INSTANCE_DIR, 'artifacts');
// Replay buffer: capped by lines AND bytes. The line cap controls how
// much history a device picking up the session can see — claude/codex
// sessions are mostly streamed text where line count maps well to
// "amount of conversation". The byte cap is a safety net for
// redraw-heavy TUI moments (file pickers, spinners) so a runaway
// terminal repaint can't blow memory.
const MAX_RECENT_LINES = 2048;
const MAX_RECENT_BYTES = 2 * 1024 * 1024;
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

// `Referrer-Policy: no-referrer` so a click on an external link from
// inside the app — including from a sandboxed HTML artifact — never
// leaks any URL path or query to the destination site.
app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Auth gate. When AUTH_ENABLED is on we require the `tw-auth` cookie to
// match PASSCODE for every request EXCEPT:
//   - Loopback callers (always trusted)
//   - The login page and login API
//   - /artifacts/* — these carry an unguessable per-session id in the URL
//     and need to be reachable from a `sandbox="allow-scripts"` iframe
//     (null origin, no cookies sent on sibling fetches).
function authGate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!AUTH_ENABLED) { next(); return; }
  if (isLoopback(req.socket.remoteAddress)) { next(); return; }
  const p = req.path;
  if (
    p === '/login' ||
    p === '/api/login' ||
    p.startsWith('/artifacts/')
  ) {
    next();
    return;
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  if (cookies['tw-auth'] && safeEqual(cookies['tw-auth'], PASSCODE)) {
    next();
    return;
  }
  // API calls get a structured 401; navigations get bounced to /login.
  if (p.startsWith('/api/')) {
    res.status(401).json({ error: 'unauthorized' });
  } else {
    res.redirect('/login');
  }
}
app.use(authGate);

// Login page (inline HTML — the SPA bundle isn't reachable yet because
// the auth middleware above would gate `index.html` first).
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>terminal — sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0a0a0c; color: #eaeaf0;
    display: grid; place-items: center;
  }
  form {
    background: #16161a; padding: 28px 28px 22px; border-radius: 12px;
    border: 1px solid #24242a; min-width: 280px; max-width: 360px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
  }
  h1 { margin: 0 0 18px; font-size: 18px; font-weight: 600; }
  input[type=password] {
    background: #0a0a0c; border: 1px solid #36363c; color: #eaeaf0;
    padding: 10px 12px; border-radius: 6px; width: 100%; box-sizing: border-box;
    font: 15px ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.05em;
  }
  input:focus { outline: none; border-color: #4a7fff; }
  button {
    margin-top: 12px; background: #4a7fff; color: white; border: 0;
    padding: 11px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
    cursor: pointer; width: 100%;
  }
  button:hover { background: #6394ff; }
  .err { color: #ff7a7a; margin-top: 10px; font-size: 13px; min-height: 1em; }
</style>
</head>
<body>
<form id="f" autocomplete="off">
  <h1>terminal</h1>
  <input type="password" id="p" placeholder="passcode" autofocus
         autocomplete="current-password" inputmode="text" spellcheck="false">
  <button type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f');
  const e = document.getElementById('e');
  const p = document.getElementById('p');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: p.value }),
    }).catch(() => null);
    if (r && r.ok) {
      location.href = '/';
    } else {
      e.textContent = 'wrong passcode';
      p.select();
    }
  });
</script>
</body>
</html>`;

app.get('/login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML);
});

app.post('/api/login', express.json({ limit: '1kb' }), (req, res) => {
  const body = req.body as { passcode?: unknown } | undefined;
  const supplied = typeof body?.passcode === 'string' ? body.passcode : '';
  if (!AUTH_ENABLED || !safeEqual(supplied, PASSCODE)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // Session cookie (no Max-Age): cleared when the browser session ends,
  // so a shared device doesn't keep authority around indefinitely.
  res.setHeader(
    'Set-Cookie',
    `tw-auth=${encodeURIComponent(PASSCODE)}; HttpOnly; SameSite=Strict; Path=/`,
  );
  res.status(204).end();
});

// The :sid segment is vestigial — artifacts are shared, not per-session —
// but kept so existing client URLs (/artifacts/<sid>/<path>) still resolve.
// The sid also acts as a capability token: knowing the (random UUID) sid
// implies you already authenticated and were handed it via the WS hello.
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
  res.json({
    projectDir: PROJECT_DIR,
    agents: AVAILABLE_AGENTS,
  });
});

// Cap a single upload so a (prefix-bearing) LAN visitor can't fill the
// host's /tmp by streaming an unbounded payload. 100 MB matches the
// drop-files-from-the-browser use case (large screenshots, video clips,
// PDFs) while staying well under typical free-space margins.
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

// Drop a file into the terminal pane → POST the raw bytes here with the
// filename in the query. The file lands in the shared artifacts dir,
// auto-renamed on collision; the response gives the absolute path so the
// client can paste it at the terminal cursor.
app.post('/api/artifacts/upload', async (req, res) => {
  // Fast-reject when Content-Length already exceeds the cap so we don't
  // touch disk for an upload we'd only have to delete. Some clients omit
  // the header — the per-chunk counter below catches those.
  const cl = Number(req.headers['content-length']);
  if (Number.isFinite(cl) && cl > UPLOAD_MAX_BYTES) {
    res.status(413).json({ error: 'file too large (max 100 MB)' });
    return;
  }
  let dest = '';
  let oversize = false;
  let received = 0;
  try {
    const raw = String(req.query.name ?? 'file');
    const safe = sanitizeName(raw);
    const finalName = await uniqueName(ARTIFACTS_DIR, safe);
    dest = path.join(ARTIFACTS_DIR, finalName);
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > UPLOAD_MAX_BYTES) {
        oversize = true;
        // Destroying the request rejects the pipeline below; cleanup is
        // handled in the catch.
        req.destroy();
      }
    });
    await pipeline(req, createWriteStream(dest));
    res.json({ name: finalName, path: dest });
  } catch (err) {
    if (dest) await rm(dest, { force: true }).catch(() => undefined);
    if (oversize) {
      res.status(413).json({ error: 'file too large (max 100 MB)' });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// Delete an artifact by its path relative to ARTIFACTS_DIR. Subdirs are
// allowed (artifacts can be nested) but the resolved target must stay
// inside ARTIFACTS_DIR — `../etc/passwd` and friends are rejected.
app.delete('/api/artifacts', async (req, res) => {
  const raw = String(req.query.name ?? '');
  if (!raw) {
    res.status(400).end();
    return;
  }
  const target = path.resolve(ARTIFACTS_DIR, raw);
  if (!target.startsWith(ARTIFACTS_DIR + path.sep)) {
    res.status(403).end();
    return;
  }
  try {
    await rm(target, { force: true });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Snapshot of a session for the tab strip. The server is the single
// source of truth — every connected client renders its tabs directly
// from this shape.
function serializeSession(s: SessionState): SessionSummary {
  return {
    id: s.id,
    agent: s.agent,
    attached: !!s.ws,
    idleMs: Date.now() - s.lastActivity,
    createdAt: s.createdAt,
    preview: previewOf(s),
  };
}

// Push the current session list to every connected viewer. Called on
// any change that would alter the tab strip: create, delete, agent
// exit. WS clients receiving this update their tabs in-place so a tab
// created on device A appears on device B without any polling.
function broadcastSessionList(): void {
  const payload = JSON.stringify({
    ch: 'sessions',
    sessions: [...sessions.values()].map(serializeSession),
  });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// Polling fallback — a client without an open WS (e.g. just landed on
// the page) bootstraps its tab list here, then keeps it in sync via
// the broadcast above once a WS is attached.
app.get('/api/sessions', (_req, res) => {
  res.json({
    sessions: [...sessions.values()].map(serializeSession),
  });
});

// Create a new session. Replaces the old "WS auto-spawns if no
// ?session=… matches" path: WS attaches only, this endpoint is the
// only way to bring a session into existence.
app.post('/api/sessions', express.json({ limit: '1kb' }), async (req, res) => {
  const body = req.body as { agent?: unknown } | undefined;
  const agent: AgentKind = body?.agent === 'codex' ? 'codex' : 'claude';
  if (!AVAILABLE_AGENTS.includes(agent)) {
    res.status(400).json({ error: `agent "${agent}" not available on this server` });
    return;
  }
  try {
    const state = await createSession(agent);
    sessions.set(state.id, state);
    broadcastSessionList();
    res.json(serializeSession(state));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Explicit teardown — called by the client when the user closes a tab.
// Idempotent; returns 204 whether or not the id was live.
app.delete('/api/sessions/:id', async (req, res) => {
  // Concatenated route path loses Express's literal-typed params, so id
  // is widened to string | string[]; coerce.
  const state = sessions.get(String(req.params.id));
  if (state) {
    try { state.ptyProc.kill(); } catch { /* ignore */ }
    if (state.ws && state.ws.readyState === state.ws.OPEN) {
      try { state.ws.close(4001, 'session destroyed'); } catch { /* ignore */ }
    }
    sessions.delete(state.id);
    broadcastSessionList();
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
  // Mirror the HTTP auth gate: loopback is trusted; otherwise the
  // request must carry a valid tw-auth cookie. Returning false here
  // makes ws reject the upgrade with a 401 before we ever take the
  // connection — the browser sees a clean failure instead of a
  // half-open socket.
  verifyClient: (info, cb) => {
    if (!AUTH_ENABLED) { cb(true); return; }
    if (isLoopback(info.req.socket.remoteAddress)) { cb(true); return; }
    const cookies = parseCookieHeader(info.req.headers.cookie);
    const ok = !!cookies['tw-auth'] && safeEqual(cookies['tw-auth'], PASSCODE);
    cb(ok, 401, 'unauthorized');
  },
});

interface SessionState {
  id: string;
  agent: AgentKind;
  artifactsDir: string;
  ptyProc: pty.IPty;
  ws: WebSocket | null;
  /** Recent PTY output, capped by line+byte limits, used to repaint
   *  xterm scrollback when a client reattaches — possibly on a
   *  different device than the one that started the session. */
  recent: string;
  lastActivity: number;
  createdAt: number;
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
  // Enforce the byte cap first (cheap, prevents runaway repaint
  // sessions from holding tens of MB before the line trim runs).
  if (combined.length > MAX_RECENT_BYTES) {
    combined = combined.slice(combined.length - MAX_RECENT_BYTES);
  }
  // Then enforce the line cap. We count '\n's and drop the leading
  // chunk past the cap, then resync to the next '\n' boundary — an
  // escape sequence never spans a newline, so starting just after one
  // guarantees the replay never begins mid-sequence.
  let nlCount = 0;
  for (let i = 0; i < combined.length; i++) if (combined.charCodeAt(i) === 10) nlCount++;
  if (nlCount > MAX_RECENT_LINES) {
    const drop = nlCount - MAX_RECENT_LINES;
    let dropped = 0;
    let i = 0;
    for (; i < combined.length && dropped < drop; i++) {
      if (combined.charCodeAt(i) === 10) dropped++;
    }
    combined = combined.slice(i);
  } else {
    // Whether or not we hit the line cap, make sure a trimmed buffer
    // starts cleanly: if the byte trim above split mid-line, advance
    // to the next newline.
    if (combined.length === MAX_RECENT_BYTES) {
      const nl = combined.indexOf('\n');
      if (nl !== -1) combined = combined.slice(nl + 1);
    }
  }
  state.recent = combined;
  state.lastActivity = Date.now();
}

// Strip any directory parts a browser might send (Windows paths arrive
// with backslashes) and any control characters; reject empty / dotfile
// edge cases.
// Best-effort ANSI / control stripping for the /api/sessions preview.
// Not a full xterm; just enough that the picker shows readable text.
function stripAnsiForPreview(s: string): string {
  return s
    // CSI: ESC [ <params> <letter>
    .replace(/\x1b\[[\d;?]*[a-zA-Z@]/g, '')
    // OSC: ESC ] <data> (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // Other single-char escapes
    .replace(/\x1b[\x40-\x5f]/g, '')
    // Bare carriage returns inside the buffer come from TUI repaints;
    // collapse to spaces so the preview reads forward.
    .replace(/\r/g, ' ')
    // Drop remaining C0 / DEL except newline & tab
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Compact one-line summary of the session's recent activity for the
// Resume picker. Last non-empty line, ANSI stripped, length capped.
function previewOf(state: SessionState): string {
  const plain = stripAnsiForPreview(state.recent);
  const lines = plain.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t.length > 0) {
      return t.length > 160 ? t.slice(0, 157) + '…' : t;
    }
  }
  return '';
}

function sanitizeName(raw: string): string {
  const n = (raw.split(/[/\\]/).pop() ?? '')
    .replace(/[ -]/g, '_')
    .trim();
  if (!n || n === '.' || n === '..') return 'file';
  return n;
}

// Find a non-colliding name in `dir`: foo.png, foo-1.png, foo-2.png, ...
async function uniqueName(dir: string, name: string): Promise<string> {
  if (!existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
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
//
// Before we (re)create our own instance dir, sweep TMP_ROOT for orphan
// instance dirs left behind by crashed runs (kill -9, power loss, etc).
// We only touch entries that are clearly ours: numeric PID names whose
// PID no longer points at a live process, plus the legacy `artifacts/`
// and `sessions/` layouts from older versions. Anything else is left
// alone in case a user has stuck something unrelated under that path.
function cleanupOrphanTmpDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(TMP_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(TMP_ROOT, name);
    if (name === 'artifacts' || name === 'sessions') {
      try { rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
      continue;
    }
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      // kill(pid, 0) throws ESRCH if the PID is gone — that's our cue
      // to remove the directory. If the PID has been recycled the
      // worst case is we keep an orphan dir longer than needed.
      process.kill(pid, 0);
      continue;
    } catch {
      /* dead — fall through to rm */
    }
    try { rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
cleanupOrphanTmpDirs();
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
  const cont = continuePending;
  const cols = 120;
  const rows = 32;
  const { bin, args } = agentCommand(agent, ARTIFACTS_DIR, cont);
  // Spawn first; only consume the one-shot --continue flag once we know
  // the agent actually started. If spawn throws (binary missing, ENOENT)
  // the flag remains armed for the user's retry.
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
  if (cont) continuePending = false;

  const state: SessionState = {
    id,
    agent,
    artifactsDir: ARTIFACTS_DIR,
    ptyProc,
    ws: null,
    recent: '',
    createdAt: Date.now(),
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
    broadcastSessionList();
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
  // Seed the tab strip from this attached WS — every WS gets the full
  // list on attach, and then receives broadcasts on each subsequent
  // change so the strip stays current.
  send(state, {
    ch: 'sessions',
    sessions: [...sessions.values()].map(serializeSession),
  });
  if (state.recent) {
    // Replay the recent buffer so the client's xterm picks up the current
    // PTY screen state. Clear the screen and scrollback first (CSI 3J
    // erases xterm's scrollback) so a reconnect doesn't stack the
    // replayed TUI redraw frames on top of stale buffer content.
    send(state, { ch: 'pty', data: '\x1b[3J\x1b[2J\x1b[H' + state.recent });
  }
  send(state, { ch: 'artifacts-list', files: await listArtifacts(state.artifactsDir) });
  // Mark this session as attached for everyone else's tab strip.
  broadcastSessionList();
}

wss.on('connection', async (ws, req) => {
  // Disable Nagle so each keystroke ships immediately.
  const sock = req.socket as { setNoDelay?: (b: boolean) => void } | undefined;
  sock?.setNoDelay?.(true);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const requestedId = url.searchParams.get('session');

  // WS now only ATTACHES — sessions must be created via POST /api/sessions
  // first. A missing or stale ?session=… is a hard error here, not a
  // silent fallback to a new claude session (which used to confuse the
  // multi-device handover flow).
  if (!requestedId) {
    ws.close(4003, 'missing session id');
    return;
  }
  const state = sessions.get(requestedId);
  if (!state) {
    ws.close(4002, 'session not found');
    return;
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
    // Detach only — keep the PTY alive for reattach. Broadcast so
    // other clients' tab strips see the "attached" badge clear.
    if (state.ws === ws) {
      state.ws = null;
      broadcastSessionList();
    }
  });
});

// When the server shuts down (SIGINT / SIGTERM), tear down every live
// session so claude doesn't leak as an orphan process group, and wipe
// THIS instance's dir — artifacts live under os.tmpdir() and are meant
// to be ephemeral (one tree per server lifetime). Concurrent instances
// keep their own PID-named subdirs untouched.
async function shutdown() {
  for (const state of sessions.values()) {
    try { state.ptyProc.kill(); } catch { /* ignore */ }
  }
  await artifactsWatcher.close().catch(() => undefined);
  await rm(INSTANCE_DIR, { recursive: true, force: true }).catch(() => undefined);
  // Best-effort: drop the empty parent if no concurrent instance still
  // owns a subdir under it. rmdirSync refuses non-empty dirs, which is
  // exactly the safety we want.
  try { rmdirSync(TMP_ROOT); } catch { /* not empty, or already gone */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Interface names that almost never represent a useful URL to print:
// Docker bridges (`docker0`, `br-<hash>`, `veth*`), VM hypervisors
// (`virbr*`, `vmnet*`, `vboxnet*`), and macOS-internal links (`awdl*`,
// `llw*`, `anpi*`, `ap1`, Internet-Sharing `bridge*`). Tailscale and
// WireGuard (`tailscale*`, `utun*`, `wg*`) are deliberately *not*
// filtered — those are typically the addresses the user wants.
const SKIP_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|awdl|llw|anpi|ap1|bridge\d)/;

// Non-internal IPv4 addresses, so the URL printed at startup is reachable
// from a phone / other device on the same LAN.
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(name)) continue;
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// Tailscale's MagicDNS hostname for this machine (e.g.
// `myhost.tailXXXX.ts.net`). Resolves on any device in the same tailnet
// with MagicDNS enabled, regardless of the IP changing. Returns null
// silently if tailscale isn't installed, isn't logged in, or doesn't
// answer within the timeout — printing the IP is always sufficient.
function tailscaleHostname(timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tailscale', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const done = (v: string | null) => {
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) { done(null); return; }
      try {
        const dns: unknown = JSON.parse(out)?.Self?.DNSName;
        // Strip the trailing dot the API returns on the FQDN.
        done(typeof dns === 'string' && dns ? dns.replace(/\.$/, '') : null);
      } catch {
        done(null);
      }
    });
  });
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
  const urls: { url: string; auth: boolean }[] = [
    { url: `http://localhost:${port}/`, auth: false },
  ];
  if (LAN) {
    for (const ip of lanAddresses()) {
      urls.push({ url: `http://${ip}:${port}/`, auth: AUTH_ENABLED });
    }
  }
  // Resolve the Tailscale MagicDNS name (best-effort, short timeout) so
  // the URL block can include the stable hostname alongside the raw IPs.
  // Everything that prints to the same block lives inside this .then so
  // the output stays in order — otherwise the warning/debug lines below
  // would race ahead of the URL list.
  const tsPromise = LAN ? tailscaleHostname() : Promise.resolve(null);
  tsPromise.then((tsName) => {
    if (tsName) urls.push({ url: `http://${tsName}:${port}/`, auth: AUTH_ENABLED });
    console.log('\n  terminal running at:');
    for (const u of urls) console.log(`    ${u.url}`);
    console.log('');
    if (AUTH_ENABLED) {
      console.log(`  passcode: ${PASSCODE}    (required for non-localhost URLs)`);
      if (!process.env.PASSCODE) {
        console.log('  (pin a stable one with --passcode <code>)');
      }
      console.log('');
    }
    console.log('  options:  [claude|codex]  -c  --lan  --yolo  --debug  --port <n>  --help');
    console.log('  port:     default 4567 — auto-increments to the next free port when --port is not set');
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
});

// Seed the first session if the launcher named one. Replaces the
// previous "client auto-picks initial agent on first fresh tab" flow:
// with server-side tabs, the bin's INITIAL_AGENT becomes "spawn this
// session at boot so the UI lands on it", regardless of which device
// connects first. Failures here are non-fatal — the UI will show an
// empty tab strip and the user can pick from the modal.
if (INITIAL_AGENT) {
  (async () => {
    try {
      const state = await createSession(INITIAL_AGENT);
      sessions.set(state.id, state);
    } catch (err) {
      console.error('[init] failed to spawn initial session:', (err as Error).message);
    }
  })();
}

startListening(BASE_PORT, MAX_PORT_TRIES);
