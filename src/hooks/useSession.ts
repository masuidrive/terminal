// One useSession() per tab. Manages WS lifecycle, PTY data callbacks,
// and the live artifacts list. The Terminal component subscribes via
// onPtyData; the ArtifactsPanel reads `artifacts` reactively.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ArtifactFile, ClientMessage, ServerMessage } from '../types.ts';

export interface SessionApi {
  sessionId: string | null;
  artifacts: ArtifactFile[];
  connected: boolean;
  // Imperative: subscribe to PTY chunks. Returns an unsubscribe fn.
  onPtyData: (cb: (data: string) => void) => () => void;
  // Imperative: send raw input bytes (already utf-8 string).
  sendInput: (data: string) => void;
  // Imperative: notify backend of resize.
  sendResize: (cols: number, rows: number) => void;
}

export function useSession(active: boolean): SessionApi {
  const wsRef = useRef<WebSocket | null>(null);
  const ptyListenersRef = useRef<Set<(data: string) => void>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!active) return; // lazy-connect: only the active tab opens its WS on mount
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // In dev we connect to the backend port directly to avoid going
    // through Vite's WebSocket proxy, which adds noticeable per-keystroke
    // latency. In prod the backend serves the static bundle itself, so
    // same-origin is fine.
    const backendPort = import.meta.env.VITE_BACKEND_PORT ?? '7681';
    const wsHost = import.meta.env.DEV
      ? `${window.location.hostname}:${backendPort}`
      : window.location.host;
    const ws = new WebSocket(`${proto}://${wsHost}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

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
          break;
        case 'error':
          console.error('[server]', msg.message);
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
      ptyListenersRef.current.clear();
    };
  }, [active]);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const msg: ClientMessage = { ch: 'pty', op: 'input', data };
    ws.send(JSON.stringify(msg));
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const msg: ClientMessage = { ch: 'pty', op: 'resize', cols, rows };
    ws.send(JSON.stringify(msg));
  }, []);

  const onPtyData = useCallback((cb: (data: string) => void) => {
    ptyListenersRef.current.add(cb);
    return () => {
      ptyListenersRef.current.delete(cb);
    };
  }, []);

  return { sessionId, artifacts, connected, onPtyData, sendInput, sendResize };
}

function mergeFile(prev: ArtifactFile[], next: ArtifactFile): ArtifactFile[] {
  const without = prev.filter((f) => f.path !== next.path);
  return sortFiles([next, ...without]);
}

function sortFiles(files: ArtifactFile[]): ArtifactFile[] {
  return [...files].sort((a, b) => b.mtime - a.mtime);
}
