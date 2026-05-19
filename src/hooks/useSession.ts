// One useSession() per tab. Manages WS lifecycle (with auto-reconnect),
// PTY data callbacks, and the live artifacts list. Each tab persists its
// server-side session id in localStorage so that page reloads — and
// transient WS drops — reattach to the same PTY instead of starting fresh.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ArtifactFile, ClientMessage, ServerMessage } from '../types.ts';

const SESSION_KEY_PREFIX = 'ticket-web:tab:';
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const;

export interface SessionApi {
  sessionId: string | null;
  /** Absolute path of this session's artifacts directory on the server's
   *  filesystem. Used by the UI for the "copy absolute path" button. */
  artifactsDir: string | null;
  artifacts: ArtifactFile[];
  connected: boolean;
  onPtyData: (cb: (data: string) => void) => () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

function readStoredSession(tabId: string): string | null {
  try {
    return localStorage.getItem(SESSION_KEY_PREFIX + tabId);
  } catch {
    return null;
  }
}

function writeStoredSession(tabId: string, sessionId: string | null) {
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY_PREFIX + tabId, sessionId);
    else localStorage.removeItem(SESSION_KEY_PREFIX + tabId);
  } catch {
    /* ignore quota / disabled storage */
  }
}

function wsUrlForSession(sessionId: string | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const backendPort = import.meta.env.VITE_BACKEND_PORT ?? '7681';
  // Talk to the backend directly in dev (bypass Vite's WS proxy, which
  // adds noticeable per-keystroke latency).
  const host = import.meta.env.DEV
    ? `${window.location.hostname}:${backendPort}`
    : window.location.host;
  const qs = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  return `${proto}://${host}/ws${qs}`;
}

export function useSession(tabId: string, active: boolean): SessionApi {
  const wsRef = useRef<WebSocket | null>(null);
  /** Queue of stringified messages pending an OPEN socket. Drained on
   *  ws.onopen so that early sends (initial resize fired during xterm
   *  layout) never get silently dropped. */
  const sendQueueRef = useRef<string[]>([]);
  const ptyListenersRef = useRef<Set<(data: string) => void>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const closedByUserRef = useRef(false);

  const [sessionId, setSessionId] = useState<string | null>(() => readStoredSession(tabId));
  const [artifactsDir, setArtifactsDir] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [connected, setConnected] = useState(false);

  const sendRaw = useCallback((payload: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(payload);
    } else {
      // Cap the queue so a truly dead connection doesn't grow unbounded.
      if (sendQueueRef.current.length < 1024) sendQueueRef.current.push(payload);
    }
  }, []);

  useEffect(() => {
    if (!active) return;

    closedByUserRef.current = false;

    const connect = () => {
      const id = readStoredSession(tabId);
      const ws = new WebSocket(wsUrlForSession(id));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttemptsRef.current = 0;
        // Drain the pre-open queue. We intentionally don't replay these
        // through sendRaw to avoid re-queueing in pathological cases.
        const q = sendQueueRef.current;
        sendQueueRef.current = [];
        for (const m of q) {
          try {
            ws.send(m);
          } catch {
            /* ignore */
          }
        }
      };

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.ch) {
          case 'hello':
            setSessionId(msg.sessionId);
            setArtifactsDir(msg.artifactsDir);
            writeStoredSession(tabId, msg.sessionId);
            break;
          case 'pty':
            for (const cb of ptyListenersRef.current) cb(msg.data);
            break;
          case 'artifacts-list':
            setArtifacts(sortFiles(msg.files));
            break;
          case 'artifacts':
            if (msg.event === 'unlink') {
              setArtifacts((prev) => prev.filter((f) => f.path !== msg.path));
            } else {
              setArtifacts((prev) => mergeFile(prev, msg.file));
            }
            break;
          case 'pty-exit':
            setConnected(false);
            // Drop the persisted session — it's gone server-side. A fresh
            // connect will spin up a new one.
            writeStoredSession(tabId, null);
            setSessionId(null);
            break;
          case 'error':
            console.error('[server]', msg.message);
            break;
        }
      };

      ws.onclose = (ev) => {
        setConnected(false);
        wsRef.current = null;
        if (closedByUserRef.current) return;
        // Code 4000 means the server kicked us off because a newer
        // connection replaced us — don't fight it.
        if (ev.code === 4000) return;
        const attempt = reconnectAttemptsRef.current++;
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Let onclose handle reconnection.
      };
    };

    connect();

    return () => {
      closedByUserRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      ptyListenersRef.current.clear();
      sendQueueRef.current = [];
    };
  }, [active, tabId]);

  const sendInput = useCallback(
    (data: string) => {
      const msg: ClientMessage = { ch: 'pty', op: 'input', data };
      sendRaw(JSON.stringify(msg));
    },
    [sendRaw]
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const msg: ClientMessage = { ch: 'pty', op: 'resize', cols, rows };
      sendRaw(JSON.stringify(msg));
    },
    [sendRaw]
  );

  const onPtyData = useCallback((cb: (data: string) => void) => {
    ptyListenersRef.current.add(cb);
    return () => {
      ptyListenersRef.current.delete(cb);
    };
  }, []);

  return { sessionId, artifactsDir, artifacts, connected, onPtyData, sendInput, sendResize };
}

function mergeFile(prev: ArtifactFile[], next: ArtifactFile): ArtifactFile[] {
  const without = prev.filter((f) => f.path !== next.path);
  return sortFiles([next, ...without]);
}

function sortFiles(files: ArtifactFile[]): ArtifactFile[] {
  return [...files].sort((a, b) => b.mtime - a.mtime);
}
