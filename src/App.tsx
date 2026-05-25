import { useEffect, useRef, useState } from 'react';
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
import { useSession, SESSION_KEY_PREFIX } from './hooks/useSession.ts';
import { useMediaQuery } from './hooks/useMediaQuery.ts';
import { useSoftKeyboard } from './hooks/useSoftKeyboard.ts';
import type { AgentKind, TabState } from './types.ts';

const TABS_KEY = 'ticket-web:tabs';
const ACTIVE_KEY = 'ticket-web:activeTabId';
const VIEW_KEY = 'ticket-web:view';

type ViewMode = 'split' | 'term' | 'artifacts';

// `crypto.randomUUID()` requires a secure context (HTTPS or localhost),
// which excludes the LAN-IP / hostname use case we care about. Fall back
// to a hand-rolled v4 UUID using getRandomValues — that one IS available
// in non-secure contexts on all modern browsers.
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) {
    try { return c.randomUUID(); } catch { /* fall through */ }
  }
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => {
    for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0;
    return a;
  } }).getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

function newTab(idx: number): TabState {
  // Neutral until the agent modal resolves; the first word is then
  // swapped for the chosen agent's name (e.g. "session 2" -> "codex 2").
  return { id: uuid(), title: `session ${idx}` };
}

function loadTabs(): { tabs: TabState[]; activeId: string; fresh: boolean } {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const tabs = JSON.parse(raw) as TabState[];
      if (Array.isArray(tabs) && tabs.length > 0) {
        const savedActive = localStorage.getItem(ACTIVE_KEY);
        const activeId =
          savedActive && tabs.some((t) => t.id === savedActive)
            ? savedActive
            : tabs[0]!.id;
        return { tabs, activeId, fresh: false };
      }
    }
  } catch {
    /* fallthrough */
  }
  const t = newTab(1);
  return { tabs: [t], activeId: t.id, fresh: true };
}

export function App() {
  const initial = loadTabs();
  const [tabs, setTabs] = useState<TabState[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const [counter, setCounter] = useState(initial.tabs.length + 1);
  // Whether this load started from a brand-new tab (vs restored tabs) —
  // captured once at mount, so a CLI-specified initial agent applies only
  // to a genuinely fresh first window.
  const initialFreshRef = useRef(initial.fresh);

  // Per-tab sendInput, kept here so a window-level file drop can paste
  // the uploaded path into whichever tab is active. TabPanels register
  // and unregister themselves on mount/unmount.
  const [sendInputs] = useState(() => new Map<string, (data: string) => void>());

  const isNarrow = useMediaQuery('(max-width: 1023px)');
  // The soft-keyboard toolbar is shown only while the on-screen keyboard
  // is actually up — a keyboard being open already implies a touch device.
  const keyboardOpen = useSoftKeyboard();

  // PROJECT_DIR and the installed agents are process-wide on the server, so
  // a single fetch on mount is enough. `availableAgents` stays null until
  // the fetch resolves so the agent picker doesn't flash the wrong state.
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentKind[] | null>(null);
  useEffect(() => {
    let aborted = false;
    fetch('/api/info')
      .then((r) => r.json())
      .then(
        (d: {
          projectDir?: string;
          agents?: AgentKind[];
          initialAgent?: AgentKind | null;
        }) => {
          if (aborted) return;
          if (typeof d.projectDir === 'string') setProjectDir(d.projectDir);
          // Apply a CLI-specified initial agent to the fresh first window
          // before revealing the picker, so the modal never flashes. Both
          // setStates here batch into one render with the tab agent set.
          if (
            (d.initialAgent === 'claude' || d.initialAgent === 'codex') &&
            initialFreshRef.current
          ) {
            handleChooseAgent(activeId, d.initialAgent);
          }
          setAvailableAgents(Array.isArray(d.agents) ? d.agents : ['claude', 'codex']);
        },
      )
      .catch(() => {
        // /api/info unreachable — fall back to offering both in the modal.
        if (!aborted) setAvailableAgents(['claude', 'codex']);
      });
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guard against losing the running session to an accidental back-swipe
  // or tab close — the browser shows its native "leave site?" prompt.
  // Only arm the prompt while at least one tab has a stored server-side
  // session: an empty just-opened app has nothing worth confirming, and
  // surprising the user with a "leave?" dialog there is just noise.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      let hasLiveTab = false;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(SESSION_KEY_PREFIX)) {
            hasLiveTab = true;
            break;
          }
        }
      } catch {
        /* ignore — fall through without prompt */
      }
      if (!hasLiveTab) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* ignore */ }
  }, [tabs]);
  useEffect(() => {
    try { localStorage.setItem(ACTIVE_KEY, activeId); } catch { /* ignore */ }
  }, [activeId]);

  const [mounted, setMounted] = useState<Set<string>>(() => new Set([initial.activeId]));
  function ensureMounted(id: string) {
    setMounted((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function handleSelect(id: string) {
    ensureMounted(id);
    setActiveId(id);
  }

  function handleNew() {
    const t = newTab(counter);
    setCounter((c) => c + 1);
    setTabs((prev) => [...prev, t]);
    ensureMounted(t.id);
    setActiveId(t.id);
  }

  function handleClose(id: string) {
    let storedSession: string | null = null;
    try {
      storedSession = localStorage.getItem(SESSION_KEY_PREFIX + id);
      localStorage.removeItem(SESSION_KEY_PREFIX + id);
    } catch {
      /* ignore */
    }
    if (storedSession) {
      fetch(`/api/sessions/${encodeURIComponent(storedSession)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => undefined);
    }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = newTab(counter);
        setCounter((c) => c + 1);
        setActiveId(fresh.id);
        ensureMounted(fresh.id);
        return [fresh];
      }
      if (id === activeId) {
        const neighbor = next[Math.max(0, idx - 1)]!;
        setActiveId(neighbor.id);
        ensureMounted(neighbor.id);
      }
      return next;
    });
    setMounted((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function handleChooseAgent(id: string, agent: AgentKind) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, agent, title: t.title.replace(/^\S+/, agent) }
          : t
      )
    );
  }

  // Window-level file drop: upload to the shared artifacts dir, paste the
  // resulting path into the active tab's terminal.
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
    if (files.length === 0) return;
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
              tabId={t.id}
              active={t.id === activeId}
              view={view}
              keyboardOpen={keyboardOpen}
              agent={t.agent ?? null}
              availableAgents={availableAgents}
              sendInputs={sendInputs}
              onChooseAgent={(a) => handleChooseAgent(t.id, a)}
              onExit={() => handleClose(t.id)}
            />
          ))}
      </div>
      {dragOver && (
        <div className="app-drop-overlay">Drop to upload to artifacts</div>
      )}
    </div>
  );
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
  tabId,
  active,
  view,
  keyboardOpen,
  agent,
  availableAgents,
  sendInputs,
  onChooseAgent,
  onExit,
}: {
  tabId: string;
  active: boolean;
  view: ViewMode;
  keyboardOpen: boolean;
  agent: AgentKind | null;
  availableAgents: AgentKind[] | null;
  sendInputs: Map<string, (data: string) => void>;
  onChooseAgent: (agent: AgentKind) => void;
  onExit: () => void;
}) {
  const session = useSession(tabId, true, agent, onExit);
  // Register this tab's sendInput so a window-level file drop can target it.
  useEffect(() => {
    sendInputs.set(tabId, session.sendInput);
    return () => { sendInputs.delete(tabId); };
  }, [tabId, session.sendInput, sendInputs]);
  // A fresh tab with no agent and no server session yet needs one chosen.
  const needsAgent = agent == null && session.sessionId == null;
  // With exactly one agent installed, skip the modal and pick it directly.
  useEffect(() => {
    if (needsAgent && availableAgents != null && availableAgents.length === 1) {
      onChooseAgent(availableAgents[0]!);
    }
  }, [needsAgent, availableAgents, onChooseAgent]);
  // Modal when the choice is real (2 agents) or there's nothing to run (0).
  const showAgentModal =
    needsAgent && availableAgents != null && availableAgents.length !== 1;
  // Surface WS state so debugging "blank screen" cases doesn't need
  // DevTools — a banner appears when we're disconnected.
  const showStatus = !needsAgent && !session.connected;
  const termPanelRef = useRef<ImperativePanelHandle>(null);
  const artPanelRef = useRef<ImperativePanelHandle>(null);

  // Drive panel sizes from the current view. minSize=0 + collapsible lets
  // a pane shrink to nothing without unmounting.
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

  // Soft-keyboard toolbar: only while the keyboard is up and the terminal
  // pane is visible.
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
      data-tab-id={tabId}
    >
      {showStatus && (
        <div className="status-banner">
          {session.sessionId
            ? `Reconnecting to session ${session.sessionId.slice(0, 8)}…`
            : 'Connecting to server…'}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId={`ticket-web:${tabId}`}
          // Without this, react-resizable-panels keeps complaining about
          // server/client size mismatches when we drive sizes imperatively.
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
      {showAgentModal && (
        <AgentModal agents={availableAgents ?? []} onPick={onChooseAgent} />
      )}
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
