// One useSession() per tab. Owns the WS lifecycle for a single
// server-side session (UUID passed in), forwards PTY data through the
// onPtyData fan-out, and surfaces session-list broadcasts to the
// parent so the tab strip can update on every device at once.
//
// Sessions live on the server — this hook never persists anything to
// localStorage. The tab strip restores itself from /api/sessions on
// page load, so there's nothing for the client to remember.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ArtifactFile, ClientMessage, ServerMessage, SessionSummary } from '../types.ts';

const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const;
// Force-close a socket that never reaches OPEN within this window — a
// half-dead network can leave one stuck in CONNECTING indefinitely,
// which would otherwise stall the whole retry loop.
const OPEN_TIMEOUT_MS = 10_000;

export interface SessionApi {
  /** Server-issued session UUID — same value as the prop, restated for
   *  convenience so components don't need to thread it separately. */
  sessionId: string;
  /** Absolute path of this session's artifacts directory on the server's
   *  filesystem. Used by the UI for the "copy absolute path" button. */
  artifactsDir: string | null;
  artifacts: ArtifactFile[];
  connected: boolean;
  /** True after the server bounced us with code 4000 — i.e. another
   *  device picked up this same session. Reset on next successful open. */
  kicked: boolean;
  onPtyData: (cb: (data: string) => void) => () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  ctrlArmed: boolean;
  toggleCtrl: () => void;
}

function wsUrlForSession(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const backendPort = import.meta.env.VITE_BACKEND_PORT ?? '4567';
  // Talk to the backend directly in dev (bypass Vite's WS proxy, which
  // adds noticeable per-keystroke latency).
  const host = import.meta.env.DEV
    ? `${window.location.hostname}:${backendPort}`
    : window.location.host;
  return `${proto}://${host}/ws?session=${encodeURIComponent(sessionId)}`;
}

export function useSession(
  sessionId: string,
  active: boolean,
  onSessions: (list: SessionSummary[]) => void,
  onExit: () => void,
): SessionApi {
  const wsRef = useRef<WebSocket | null>(null);
  // Stashed in refs so the stable ws.onmessage closures see the latest
  // callbacks without re-running the connection effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onSessionsRef = useRef(onSessions);
  onSessionsRef.current = onSessions;
  /** Queue of stringified messages pending an OPEN socket. Drained on
   *  ws.onopen so that early sends (initial resize fired during xterm
   *  layout) never get silently dropped. */
  const sendQueueRef = useRef<string[]>([]);
  const ptyListenersRef = useRef<Set<(data: string) => void>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const closedByUserRef = useRef(false);

  const [artifactsDir, setArtifactsDir] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [connected, setConnected] = useState(false);
  const [kicked, setKicked] = useState(false);

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

      const ws = new WebSocket(wsUrlForSession(sessionId));
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
        setKicked(false);
        reconnectAttemptsRef.current = 0;
        // Drain the pre-open queue. We intentionally don't replay these
        // through sendRaw to avoid re-queueing in pathological cases.
        const q = sendQueueRef.current;
        sendQueueRef.current = [];
        for (const m of q) {
          try { ws.send(m); } catch { /* ignore */ }
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
            setArtifactsDir(msg.artifactsDir);
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
          case 'sessions':
            onSessionsRef.current(msg.sessions);
            break;
          case 'pty-exit':
            // The agent process is gone — close the tab. The server has
            // already deleted the session and will broadcast a sessions
            // update with this id removed.
            onExitRef.current();
            break;
          case 'error':
            console.error('[server]', msg.message);
            break;
        }
      };

      ws.onclose = (ev) => {
        clearOpenTimer();
        // Ignore a superseded socket's late close.
        if (wsRef.current !== ws) return;
        setConnected(false);
        wsRef.current = null;
        if (closedByUserRef.current) return;

        // Our own 4xxx close codes never retry:
        //   4000 — replaced by a newer connection on another device
        //   4001 — session destroyed (DELETE'd) on the server
        //   4002 — session not found (no longer exists)
        //   4003 — bad request (missing ?session=)
        if (ev.code >= 4000 && ev.code < 4100) {
          if (ev.code === 4000) {
            setKicked(true);
          } else {
            // Session is gone for good — tell the parent so the tab can
            // be removed from the strip.
            onExitRef.current();
          }
          return;
        }

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
        try { ws.close(); } catch { /* ignore */ }
      }
      ptyListenersRef.current.clear();
      sendQueueRef.current = [];
    };
  }, [active, sessionId]);

  const sendInput = useCallback(
    (data: string) => {
      let out = data;
      if (ctrlArmedRef.current && data.length > 0) {
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
    kicked,
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
