// xterm.js host. We delay term.open() until the host element has been
// laid out — opening into a 0-width host bakes a tiny cols value into
// xterm, and the first chunk of PTY data (typically the server-replayed
// recent buffer) ends up word-wrapped at ~5 columns and never recovers.
//
// Lifecycle keyed by `tabId` so each tab gets its own Terminal instance;
// React only unmounts when the tab itself unmounts, view-mode toggles
// don't touch us.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { registerWrappedLinkProvider } from '../terminalLinks.ts';
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
      // Custom link provider that also clicks URLs broken across lines.
      registerWrappedLinkProvider(term);
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

  // Re-fit when our visibility / host size changes. We rely entirely on
  // ResizeObserver and refuse to fit until the host has non-degenerate
  // dimensions: during view-mode transitions the host briefly has width
  // 0 (Panel hasn't been resized yet), and fitting at that moment would
  // bake a 1- or 2-column value into xterm that survives the subsequent
  // expand. Threshold of 20 px keeps us above the smallest plausible
  // cell size with margin.
  useLayoutEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      try {
        fitRef.current?.fit();
      } catch { /* ignore */ }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [visible]);

  // Drop a file onto the terminal: upload it to the shared artifacts dir
  // and paste the resulting absolute path at the cursor.
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (!dragOver) setDragOver(true);
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadAndInsert(files, session);
  }

  return (
    <div
      className={'terminal-pane' + (dragOver ? ' dragover' : '')}
      style={{ display: visible ? 'block' : 'none' }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div ref={hostRef} className="terminal-host" />
      {dragOver && (
        <div className="terminal-drop-overlay">Drop to upload to artifacts</div>
      )}
    </div>
  );
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // `types` is a DOMStringList in older browsers, an array in modern ones.
  for (const t of Array.from(dt.types ?? [])) if (t === 'Files') return true;
  return (dt.files?.length ?? 0) > 0;
}

async function uploadAndInsert(files: File[], session: SessionApi) {
  for (const file of files) {
    try {
      const url = `/api/artifacts/upload?name=${encodeURIComponent(file.name)}`;
      const r = await fetch(url, { method: 'POST', body: file });
      if (!r.ok) {
        console.error('[drop] upload failed:', r.status);
        continue;
      }
      const data = (await r.json()) as { path?: string };
      if (typeof data.path === 'string') session.sendInput(data.path + ' ');
    } catch (err) {
      console.error('[drop] upload error:', err);
    }
  }
}
