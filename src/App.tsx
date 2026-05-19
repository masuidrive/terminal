import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Tabs } from './components/Tabs.tsx';
import { TerminalView } from './components/Terminal.tsx';
import { ArtifactsPanel } from './components/ArtifactsPanel.tsx';
import { useSession } from './hooks/useSession.ts';
import { useMediaQuery } from './hooks/useMediaQuery.ts';
import type { TabState } from './types.ts';

const TABS_KEY = 'ticket-web:tabs';
const ACTIVE_KEY = 'ticket-web:activeTabId';
const VIEW_KEY = 'ticket-web:view';

type ViewMode = 'split' | 'term' | 'artifacts';

function newTab(idx: number): TabState {
  return { id: crypto.randomUUID(), title: `claude ${idx}` };
}

function loadTabs(): { tabs: TabState[]; activeId: string } {
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
        return { tabs, activeId };
      }
    }
  } catch {
    /* fallthrough */
  }
  const t = newTab(1);
  return { tabs: [t], activeId: t.id };
}

export function App() {
  const initial = loadTabs();
  const [tabs, setTabs] = useState<TabState[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const [counter, setCounter] = useState(initial.tabs.length + 1);

  // Narrow viewports (Fold cover screen, phones, half-screen browsers) get
  // a single-pane layout with a Terminal/Artifacts toggle in the tab bar.
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const [view, setView] = useState<ViewMode>(() => {
    const saved = (localStorage.getItem(VIEW_KEY) as ViewMode | null) ?? 'split';
    return saved === 'split' || saved === 'term' || saved === 'artifacts' ? saved : 'split';
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);
  // When the viewport flips to narrow, collapse split mode to terminal.
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
      storedSession = localStorage.getItem('ticket-web:tab:' + id);
      localStorage.removeItem('ticket-web:tab:' + id);
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

  return (
    <div className="app">
      <Tabs
        tabs={tabs}
        activeId={activeId}
        onSelect={handleSelect}
        onClose={handleClose}
        onNew={handleNew}
        view={view}
        onViewChange={setView}
        showSplit={!isNarrow}
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
            />
          ))}
      </div>
    </div>
  );
}

function TabPanel({
  tabId,
  active,
  view,
}: {
  tabId: string;
  active: boolean;
  view: ViewMode;
}) {
  const session = useSession(tabId, true);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: active ? 'block' : 'none',
      }}
      data-tab-id={tabId}
    >
      {view === 'split' ? (
        <PanelGroup direction="horizontal" autoSaveId={`ticket-web:${tabId}`}>
          <Panel defaultSize={60} minSize={25}>
            <TerminalView session={session} visible={active} />
          </Panel>
          <PanelResizeHandle className="resizer" />
          <Panel defaultSize={40} minSize={20}>
            <ArtifactsPanel
              sessionId={session.sessionId}
              artifactsDir={session.artifactsDir}
              artifacts={session.artifacts}
            />
          </Panel>
        </PanelGroup>
      ) : view === 'term' ? (
        // Single-pane terminal; we still mount Artifacts off-screen so its
        // WS-driven state (the artifacts list) stays current when the user
        // flips back to it.
        <div className="single-pane">
          <TerminalView session={session} visible={active} />
          <div className="off-screen">
            <ArtifactsPanel
              sessionId={session.sessionId}
              artifactsDir={session.artifactsDir}
              artifacts={session.artifacts}
            />
          </div>
        </div>
      ) : (
        <div className="single-pane">
          <ArtifactsPanel
            sessionId={session.sessionId}
            artifactsDir={session.artifactsDir}
            artifacts={session.artifacts}
          />
          <div className="off-screen">
            <TerminalView session={session} visible={false} />
          </div>
        </div>
      )}
    </div>
  );
}
