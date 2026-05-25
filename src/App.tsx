// Top-level app shell.
//
// The tab strip is a direct projection of the server's session list:
// /api/sessions on mount + WS-broadcast updates from any attached
// session. Each device thus sees the same tabs in the same order, and
// changes (create / close / agent exit) propagate live to every viewer.
//
// Per-device state still in localStorage: which tab is focused, and
// the split/term/artifacts view mode. Both are UI preferences — there's
// no reason a phone and a laptop need to look at the same tab.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import { Tabs } from './components/Tabs.tsx';
import { TerminalView } from './components/Terminal.tsx';
import { ArtifactsPanel } from './components/ArtifactsPanel.tsx';
import { KeyboardToolbar } from './components/KeyboardToolbar.tsx';
import { AgentModal } from './components/AgentModal.tsx';
import { useSession } from './hooks/useSession.ts';
import { useMediaQuery } from './hooks/useMediaQuery.ts';
import { useSoftKeyboard } from './hooks/useSoftKeyboard.ts';
import type { AgentKind, SessionSummary } from './types.ts';

const ACTIVE_KEY = 'ticket-web:activeSessionId';
const VIEW_KEY = 'ticket-web:view';

type ViewMode = 'split' | 'term' | 'artifacts';

function readSavedActive(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
function writeSavedActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* ignore */ }
}

export function App() {
  // Tabs are SessionSummary objects, sorted by createdAt so the order
  // is stable across devices.
  const [tabs, setTabs] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabsLoaded, setTabsLoaded] = useState(false);

  const isNarrow = useMediaQuery('(max-width: 1023px)');
  const keyboardOpen = useSoftKeyboard();

  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentKind[] | null>(null);
  // Explicit "+" or auto-shown when there are no tabs yet.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Bootstrap: pull project info AND the initial tab list. Active tab
  // restores from localStorage if it's still in the list; otherwise we
  // fall back to the first tab.
  useEffect(() => {
    let aborted = false;
    Promise.all([
      fetch('/api/info').then((r) => r.json()).catch(() => ({})),
      fetch('/api/sessions').then((r) => r.json()).catch(() => ({ sessions: [] })),
    ]).then(([info, list]) => {
      if (aborted) return;
      const d = info as { projectDir?: string; agents?: AgentKind[] };
      const s = list as { sessions?: SessionSummary[] };
      if (typeof d.projectDir === 'string') setProjectDir(d.projectDir);
      setAvailableAgents(Array.isArray(d.agents) ? d.agents : ['claude', 'codex']);
      const sorted = sortTabs(s.sessions ?? []);
      setTabs(sorted);
      const saved = readSavedActive();
      const fallback = sorted[0]?.id ?? null;
      setActiveId(saved && sorted.some((t) => t.id === saved) ? saved : fallback);
      setTabsLoaded(true);
    });
    return () => { aborted = true; };
  }, []);

  // Persist the active tab id per device (NOT the tabs themselves —
  // those come from the server now).
  useEffect(() => {
    if (tabsLoaded) writeSavedActive(activeId);
  }, [activeId, tabsLoaded]);

  // View mode persists per device too.
  const [view, setView] = useState<ViewMode>(() => {
    const saved = (localStorage.getItem(VIEW_KEY) as ViewMode | null) ?? 'split';
    return saved === 'split' || saved === 'term' || saved === 'artifacts' ? saved : 'split';
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);
  useEffect(() => {
    if (isNarrow && view === 'split') setView('term');
  }, [isNarrow, view]);

  // Live tab-list updates from any attached WS. Server is authoritative,
  // so we just replace the local list. activeId stays put when valid;
  // otherwise we re-anchor to the first tab.
  const handleSessionsBroadcast = useCallback((list: SessionSummary[]) => {
    const sorted = sortTabs(list);
    setTabs(sorted);
    setActiveId((prev) => {
      if (prev && sorted.some((t) => t.id === prev)) return prev;
      return sorted[0]?.id ?? null;
    });
  }, []);

  // Auto-open the agent picker when there are no tabs (e.g. brand-new
  // server, or every session was closed). Don't pop it while we're
  // still loading the initial list.
  useEffect(() => {
    if (!tabsLoaded) return;
    if (tabs.length === 0 && availableAgents != null && availableAgents.length > 0) {
      setPickerOpen(true);
    }
  }, [tabsLoaded, tabs.length, availableAgents]);

  // beforeunload prompt only while there's something worth keeping.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (tabs.length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [tabs.length]);

  // Mount each tab's TabPanel once it's been selected. We keep mounted
  // ones around so switching back is instant; new tabs are mounted
  // lazily on first focus.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (activeId) {
      setMounted((prev) => {
        if (prev.has(activeId)) return prev;
        const next = new Set(prev);
        next.add(activeId);
        return next;
      });
    }
  }, [activeId]);

  function handleSelect(id: string) {
    setActiveId(id);
  }

  function handleNew() {
    setPickerOpen(true);
  }

  async function handlePickAgent(agent: AgentKind) {
    setPickerOpen(false);
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent }),
      });
      if (!r.ok) {
        console.error('[create] failed:', r.status);
        return;
      }
      const created = (await r.json()) as SessionSummary;
      // Optimistic add — the broadcast will arrive too, but updating
      // here means activeId can flip immediately without waiting.
      setTabs((prev) =>
        prev.some((t) => t.id === created.id) ? prev : sortTabs([...prev, created]),
      );
      setActiveId(created.id);
    } catch (err) {
      console.error('[create] error:', err);
    }
  }

  async function handleClose(id: string) {
    // Optimistic UI: remove now, then DELETE on the server. Broadcast
    // will confirm and update everyone else.
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveId((prev) => (prev === id ? null : prev));
    setMounted((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        keepalive: true,
      });
    } catch {
      /* server-side broadcast will reconcile if delete fails */
    }
  }

  // Per-tab sendInput, kept here so a window-level file drop can paste
  // the uploaded path into whichever tab is active.
  const [sendInputs] = useState(() => new Map<string, (data: string) => void>());

  // File drop overlay state.
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
    if (files.length === 0 || activeId == null) return;
    const send = sendInputs.get(activeId);
    void uploadAndInsert(files, send);
  }

  return (
    <div
      className={'app' + (dragOver ? ' dragover' : '')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Tabs
        tabs={tabs}
        activeId={activeId}
        onSelect={handleSelect}
        onClose={handleClose}
        onNew={handleNew}
        view={view}
        onViewChange={setView}
        showSplit={!isNarrow}
        projectDir={projectDir}
      />
      <div className="panels" style={{ position: 'relative' }}>
        {tabs
          .filter((t) => mounted.has(t.id))
          .map((t) => (
            <TabPanel
              key={t.id}
              session={t}
              active={t.id === activeId}
              view={view}
              keyboardOpen={keyboardOpen}
              sendInputs={sendInputs}
              onSessions={handleSessionsBroadcast}
              onExit={() => handleClose(t.id)}
            />
          ))}
      </div>
      {pickerOpen && (
        <AgentModal
          agents={availableAgents ?? []}
          onPick={handlePickAgent}
          onCancel={() => setPickerOpen(false)}
        />
      )}
      {dragOver && (
        <div className="app-drop-overlay">Drop to upload to artifacts</div>
      )}
    </div>
  );
}

function sortTabs(list: SessionSummary[]): SessionSummary[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt);
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const t of Array.from(dt.types ?? [])) if (t === 'Files') return true;
  return (dt.files?.length ?? 0) > 0;
}

async function uploadAndInsert(
  files: File[],
  send: ((data: string) => void) | undefined,
) {
  for (const file of files) {
    try {
      const url = `/api/artifacts/upload?name=${encodeURIComponent(file.name)}`;
      const r = await fetch(url, { method: 'POST', body: file });
      if (!r.ok) {
        console.error('[drop] upload failed:', r.status);
        continue;
      }
      const data = (await r.json()) as { path?: string };
      if (typeof data.path === 'string' && send) send(data.path + ' ');
    } catch (err) {
      console.error('[drop] upload error:', err);
    }
  }
}

// One stable layout across all three view modes. We never re-parent the
// Terminal or ArtifactsPanel — that would destroy the xterm instance and
// lose the rendered buffer. Instead, view changes flip a CSS class that
// controls grid column sizing and visibility of the resize handle.
function TabPanel({
  session: tab,
  active,
  view,
  keyboardOpen,
  sendInputs,
  onSessions,
  onExit,
}: {
  session: SessionSummary;
  active: boolean;
  view: ViewMode;
  keyboardOpen: boolean;
  sendInputs: Map<string, (data: string) => void>;
  onSessions: (list: SessionSummary[]) => void;
  onExit: () => void;
}) {
  const session = useSession(tab.id, true, onSessions, onExit);
  // Register this tab's sendInput so a window-level file drop can target it.
  useEffect(() => {
    sendInputs.set(tab.id, session.sendInput);
    return () => { sendInputs.delete(tab.id); };
  }, [tab.id, session.sendInput, sendInputs]);

  const showStatus = !session.connected && !session.kicked;
  const termPanelRef = useRef<ImperativePanelHandle>(null);
  const artPanelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    const term = termPanelRef.current;
    const art = artPanelRef.current;
    if (!term || !art) return;
    if (view === 'split') {
      term.resize(60);
    } else if (view === 'term') {
      term.resize(100);
    } else {
      term.resize(0);
    }
  }, [view]);

  const showToolbar = keyboardOpen && view !== 'artifacts';

  return (
    <div
      className={`tab-panel view-${view}`}
      style={{
        position: 'absolute',
        inset: 0,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
      }}
      data-tab-id={tab.id}
    >
      {session.kicked ? (
        <div className="status-banner status-banner-kicked">
          <span>
            Another device is using this session.{' '}
            <button
              className="status-banner-action"
              onClick={() => window.location.reload()}
            >
              Reload to take it back
            </button>
          </span>
        </div>
      ) : showStatus ? (
        <div className="status-banner">
          {`Reconnecting to session ${tab.id.slice(0, 8)}…`}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId={`ticket-web:${tab.id}`}
          storage={memoryStorage}
        >
          <Panel
            ref={termPanelRef}
            defaultSize={60}
            minSize={0}
            collapsible
            collapsedSize={0}
          >
            <TerminalView session={session} visible={active && view !== 'artifacts'} />
          </Panel>
          <PanelResizeHandle className={'resizer' + (view === 'split' ? '' : ' resizer-hidden')} />
          <Panel
            ref={artPanelRef}
            defaultSize={40}
            minSize={0}
            collapsible
            collapsedSize={0}
          >
            <ArtifactsPanel
              sessionId={session.sessionId}
              artifactsDir={session.artifactsDir}
              artifacts={session.artifacts}
            />
          </Panel>
        </PanelGroup>
      </div>
      {showToolbar && <KeyboardToolbar session={session} />}
    </div>
  );
}

// We don't want react-resizable-panels persisting its own split position
// across sessions — we manage that ourselves via the view state. Use a
// memory-only storage that the library still accepts.
const memoryStorage: Storage = {
  length: 0,
  clear() {},
  getItem() { return null; },
  key() { return null; },
  removeItem() {},
  setItem() {},
} as Storage;
