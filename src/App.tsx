import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Tabs } from './components/Tabs.tsx';
import { TerminalView } from './components/Terminal.tsx';
import { ArtifactsPanel } from './components/ArtifactsPanel.tsx';
import { useSession } from './hooks/useSession.ts';
import type { TabState } from './types.ts';

const TABS_KEY = 'ticket-web:tabs';
const ACTIVE_KEY = 'ticket-web:activeTabId';

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
    /* fallthrough to default */
  }
  const t = newTab(1);
  return { tabs: [t], activeId: t.id };
}

export function App() {
  const initial = loadTabs();
  const [tabs, setTabs] = useState<TabState[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const [counter, setCounter] = useState(initial.tabs.length + 1);

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
    } catch {
      /* ignore */
    }
  }, [tabs]);
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      /* ignore */
    }
  }, [activeId]);

  // Lazy-mount tabs so opening doesn't spin up every PTY at once. Once
  // mounted, keep them mounted (xterm/WS state survives switching).
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
    // Clear the persisted session id so a future tab with the same uuid
    // (very unlikely) doesn't reattach by accident. The actual server-side
    // PTY will idle out and be GC'd.
    try {
      localStorage.removeItem('ticket-web:tab:' + id);
    } catch {
      /* ignore */
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
      />
      <div className="panels" style={{ position: 'relative' }}>
        {tabs
          .filter((t) => mounted.has(t.id))
          .map((t) => (
            <TabPanel key={t.id} tabId={t.id} active={t.id === activeId} />
          ))}
      </div>
    </div>
  );
}

function TabPanel({ tabId, active }: { tabId: string; active: boolean }) {
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
      <PanelGroup direction="horizontal" autoSaveId={`ticket-web:${tabId}`}>
        <Panel defaultSize={60} minSize={25}>
          <TerminalView session={session} visible={active} />
        </Panel>
        <PanelResizeHandle className="resizer" />
        <Panel defaultSize={40} minSize={20}>
          <ArtifactsPanel
            sessionId={session.sessionId}
            artifacts={session.artifacts}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
