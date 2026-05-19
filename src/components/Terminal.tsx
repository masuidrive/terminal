// xterm.js host. Lifecycle is keyed by `tabId` so each tab gets its own
// Terminal instance. We DON'T re-create xterm on every render — it's
// constructed exactly once per tab in a useEffect with [].

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

  // Construct xterm once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: '#000000',
        foreground: '#eaeaf0',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable; fall back to default canvas renderer
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const unsub = session.onPtyData((data) => term.write(data));
    const inputDisp = term.onData((data) => session.sendInput(data));
    const resizeDisp = term.onResize(({ cols, rows }) =>
      session.sendResize(cols, rows)
    );
    // Send initial size after layout.
    queueMicrotask(() => {
      try {
        fit.fit();
        session.sendResize(term.cols, term.rows);
      } catch { /* ignore */ }
    });

    return () => {
      unsub();
      inputDisp.dispose();
      resizeDisp.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit when our visibility/size changes.
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
    // also fit immediately when we become visible
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
