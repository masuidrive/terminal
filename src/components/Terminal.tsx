// xterm.js host. We delay term.open() until the host element has been
// laid out — opening into a 0-width host bakes a tiny cols value into
// xterm, and the first chunk of PTY data (typically the server-replayed
// recent buffer) ends up word-wrapped at ~5 columns and never recovers.
//
// Lifecycle keyed by `tabId` so each tab gets its own Terminal instance;
// React only unmounts when the tab itself unmounts, view-mode toggles
// don't touch us.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionApi } from '../hooks/useSession.ts';

interface Props {
  session: SessionApi;
  visible: boolean;
}

export function TerminalView({ session, visible }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Construct once. Wait for the host to have real dimensions before
  // calling term.open() — otherwise xterm latches a tiny cols and the
  // first replayed PTY frame is wrapped beyond recognition.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    function init() {
      if (disposed) return;
      const term = new Terminal({
        fontFamily:
          'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 10000,
        theme: { background: '#000000', foreground: '#eaeaf0' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      const u11 = new Unicode11Addon();
      term.loadAddon(u11);
      term.unicode.activeVersion = '11';
      term.open(host!);
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        /* fall back to canvas */
      }
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // Send initial size BEFORE wiring data, so any backlog replay
      // arrives after the server has already resized claude's PTY to
      // our actual columns.
      if (term.cols > 5 && term.rows > 2) {
        session.sendResize(term.cols, term.rows);
      }
      const unsub = session.onPtyData((data) => term.write(data));
      const inputDisp = term.onData((data) => session.sendInput(data));
      const resizeDisp = term.onResize(({ cols, rows }) =>
        session.sendResize(cols, rows)
      );

      cleanup = () => {
        unsub();
        inputDisp.dispose();
        resizeDisp.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }

    // If the host already has real dimensions, init now. Otherwise wait
    // for layout via ResizeObserver and init on the first non-zero size.
    const rect = host.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) {
      init();
    } else {
      const ro = new ResizeObserver((entries) => {
        const e = entries[0];
        if (!e) return;
        const b = (e.contentBoxSize?.[0] ?? null) as
          | { inlineSize: number; blockSize: number }
          | null;
        const w = b ? b.inlineSize : e.contentRect.width;
        const h = b ? b.blockSize : e.contentRect.height;
        if (w > 1 && h > 1) {
          ro.disconnect();
          init();
        }
      });
      ro.observe(host);
      cleanup = () => ro.disconnect();
    }

    return () => {
      disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit when our visibility / host size changes. We don't replace
  // xterm — just have it recompute cols/rows for the current host size
  // and let onResize forward that to the PTY.
  useLayoutEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit();
      } catch { /* ignore */ }
    });
    ro.observe(host);
    queueMicrotask(() => {
      try {
        fitRef.current?.fit();
      } catch { /* ignore */ }
    });
    return () => ro.disconnect();
  }, [visible]);

  return (
    <div className="terminal-pane" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
}
