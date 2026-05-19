// WebSocket message contract shared between client and server.
// One WS connection per terminal session. The session id is assigned by the
// server in the `hello` message after the socket opens.

export interface ArtifactFile {
  path: string;       // relative to the session's artifacts dir
  size: number;
  mtime: number;      // ms since epoch
  ext: string;        // lowercase, no leading dot
}

// Server → Client ---------------------------------------------------------

export type ServerMessage =
  | { ch: 'hello'; sessionId: string; artifactsDir: string }
  | { ch: 'pty'; data: string }
  | { ch: 'pty-exit'; code: number | null; signal: number | null }
  | { ch: 'artifacts'; event: 'add' | 'change'; file: ArtifactFile }
  | { ch: 'artifacts'; event: 'unlink'; path: string }
  | { ch: 'artifacts-list'; files: ArtifactFile[] }
  | { ch: 'error'; message: string };

// Client → Server ---------------------------------------------------------

export type ClientMessage =
  | { ch: 'pty'; op: 'input'; data: string }
  | { ch: 'pty'; op: 'resize'; cols: number; rows: number }
  | { ch: 'artifacts'; op: 'list' };
