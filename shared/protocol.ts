// WebSocket message contract shared between client and server.
// One WS connection per terminal session. The session id is assigned by the
// server in the `hello` message after the socket opens.

// Which CLI agent a session runs. Chosen client-side via the startup
// modal and passed to the server as a `?agent=` query param on /ws.
export type AgentKind = 'claude' | 'codex';

export interface ArtifactFile {
  path: string;       // relative to the session's artifacts dir
  size: number;
  mtime: number;      // ms since epoch
  ext: string;        // lowercase, no leading dot
}

// One row of the server's authoritative session list. The client renders
// the tab strip directly from this — there's no separate client-side
// "tab" concept anymore, so every device looking at the same server
// sees the same tabs in the same order.
export interface SessionSummary {
  id: string;
  agent: AgentKind;
  attached: boolean;   // some viewer currently has a WS open
  idleMs: number;      // ms since last PTY activity
  createdAt: number;   // ms since epoch — also the tab-strip sort key
  preview: string;     // last non-empty stripped-ANSI line of recent output
}

// Server → Client ---------------------------------------------------------

export type ServerMessage =
  | { ch: 'hello'; sessionId: string; artifactsDir: string }
  | { ch: 'pty'; data: string }
  | { ch: 'pty-exit'; code: number | null; signal: number | null }
  | { ch: 'artifacts'; event: 'add' | 'change'; file: ArtifactFile }
  | { ch: 'artifacts'; event: 'unlink'; path: string }
  | { ch: 'artifacts-list'; files: ArtifactFile[] }
  // Authoritative session list. Sent on each WS open and rebroadcast
  // to every connected client whenever the server creates or removes
  // a session, so every viewer's tab strip stays in sync.
  | { ch: 'sessions'; sessions: SessionSummary[] }
  | { ch: 'error'; message: string };

// Client → Server ---------------------------------------------------------

export type ClientMessage =
  | { ch: 'pty'; op: 'input'; data: string }
  | { ch: 'pty'; op: 'resize'; cols: number; rows: number }
  | { ch: 'artifacts'; op: 'list' };
