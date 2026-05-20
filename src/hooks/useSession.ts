// One useSession() per tab. Manages WS lifecycle (with auto-reconnect),
// PTY data callbacks, and the live artifacts list. Each tab persists its
// server-side session id in localStorage so that page reloads — and
// transient WS drops — reattach to the same PTY instead of starting fresh.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentKind, ArtifactFile, ClientMessage, ServerMessage } from '../types.ts';

const SESSION_KEY_PREFIX = 'ticket-web:tab:';
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const;
// Force-close a socket that never reaches OPEN within this window — a
// half-dead network can leave one stuck in CONNECTING indefinitely,
// which would otherwise stall the whole retry loop.
const OPEN_TIMEOUT_MS = 10_000;

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
  /** Whether the soft-keyboard Ctrl modifier is armed for the next key. */
  ctrlArmed: boolean;
  /** Toggle the armed Ctrl modifier. While armed, the next sendInput
   *  folds its leading character into an ASCII control code (regardless
   *  of whether it came from the toolbar or the OS keyboard), then
   *  disarms. */
  toggleCtrl: () => void;
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

function wsUrlForSession(sessionId: string | null, agent: AgentKind | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const backendPort = import.meta.env.VITE_BACKEND_PORT ?? '4567';
  // Talk to the backend directly in dev (bypass Vite's WS proxy, which
  // adds noticeable per-keystroke latency).
  const host = import.meta.env.DEV
    ? `${window.location.hostname}:${backendPort}`
    : window.location.host;
  // Reattach to an existing session by id; otherwise spawn a new one with
  // the chosen agent.
  let qs = '';
  if (sessionId) qs = `?session=${encodeURIComponent(sessionId)}`;
  else if (agent) qs = `?agent=${encodeURIComponent(agent)}`;
  return `${proto}://${host}/ws${qs}`;
}

export function useSession(
  tabId: string,
  active: boolean,
  agent: AgentKind | null,
): SessionApi {
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

  // Soft-keyboard Ctrl modifier. The ref is what sendInput consults — it
  // must stay readable from sendInput's stable closure, which Terminal
  // captures once when wiring xterm's onData. The state mirror exists
  // only to re-render the toolbar's armed highlight.
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);

  const toggleCtrl = useCallback(() => {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
  }, []);

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
    // A brand-new tab has neither a stored session nor an agent yet — wait
    // for the startup modal to pick one before opening a socket.
    if (!readStoredSession(tabId) && !agent) return;

    closedByUserRef.current = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;

    const clearOpenTimer = () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    };
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const connect = () => {
      clearReconnectTimer();
      clearOpenTimer();

      // Drop any prior socket and silence it, so a stale CONNECTING /
      // half-open socket can't fire late and interfere with this attempt.
      const prev = wsRef.current;
      if (prev) {
        prev.onopen = prev.onmessage = prev.onclose = prev.onerror = null;
        try { prev.close(); } catch { /* ignore */ }
      }

      const id = readStoredSession(tabId);
      const ws = new WebSocket(wsUrlForSession(id, agent));
      wsRef.current = ws;

      // Guard against a socket stuck in CONNECTING forever (neither onopen
      // nor onclose fires on a half-dead network): force a close so the
      // retry loop continues.
      openTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try { ws.close(); } catch { /* ignore */ }
        }
      }, OPEN_TIMEOUT_MS);

      ws.onopen = () => {
        clearOpenTimer();
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
        clearOpenTimer();
        // Ignore a superseded socket's late close (connect() nulls the
        // handlers, but guard anyway).
        if (wsRef.current !== ws) return;
        setConnected(false);
        wsRef.current = null;
        if (closedByUserRef.current) return;
        // Code 4000 means the server kicked us off because a newer
        // connection replaced us — don't fight it.
        if (ev.code === 4000) return;
        const attempt = reconnectAttemptsRef.current++;
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        clearReconnectTimer();
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Let onclose handle reconnection.
      };
    };

    // A socket dropped while the device slept or the network flipped often
    // never reports `close`, leaving the UI stuck on "reconnecting". When
    // the tab is shown again or the network returns, retry immediately
    // instead of waiting on a timer that may never have been armed.
    const wake = () => {
      if (closedByUserRef.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      reconnectAttemptsRef.current = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      closedByUserRef.current = true;
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
      clearReconnectTimer();
      clearOpenTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      ptyListenersRef.current.clear();
      sendQueueRef.current = [];
    };
  }, [active, tabId, agent]);

  const sendInput = useCallback(
    (data: string) => {
      let out = data;
      if (ctrlArmedRef.current && data.length > 0) {
        // Armed Ctrl: fold the leading character into its ASCII control
        // code (e.g. 'c' -> 0x03), then disarm. Only the first char of
        // the chunk is modified — if the OS keyboard delivers several
        // chars at once (autocomplete / paste), Ctrl lands on the lead.
        out = String.fromCharCode(data.charCodeAt(0) & 0x1f) + data.slice(1);
        ctrlArmedRef.current = false;
        setCtrlArmed(false);
      }
      const msg: ClientMessage = { ch: 'pty', op: 'input', data: out };
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

  return {
    sessionId,
    artifactsDir,
    artifacts,
    connected,
    onPtyData,
    sendInput,
    sendResize,
    ctrlArmed,
    toggleCtrl,
  };
}

function mergeFile(prev: ArtifactFile[], next: ArtifactFile): ArtifactFile[] {
  const without = prev.filter((f) => f.path !== next.path);
  return sortFiles([next, ...without]);
}

function sortFiles(files: ArtifactFile[]): ArtifactFile[] {
  return [...files].sort((a, b) => b.mtime - a.mtime);
}
