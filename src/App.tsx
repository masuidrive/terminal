import { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Tabs } from './components/Tabs.tsx';
import { TerminalView } from './components/Terminal.tsx';
import { ArtifactsPanel } from './components/ArtifactsPanel.tsx';
import { useSession } from './hooks/useSession.ts';
import type { TabState } from './types.ts';

function newTab(idx: number): TabState {
  return { id: crypto.randomUUID(), title: `claude ${idx}` };
}

export function App() {
  const [tabs, setTabs] = useState<TabState[]>(() => [newTab(1)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  const [counter, setCounter] = useState(2);

  // Keep tabs mounted once opened so xterm + WS state survives tab switching.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([tabs[0]!.id]));
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
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        // always keep at least one tab
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

// One TabPanel mounts a single useSession() + the split layout.
// We render every mounted tab into the same area, only the active one is
// visible (display:none for the rest) so its xterm/WS keeps running.
function TabPanel({ tabId, active }: { tabId: string; active: boolean }) {
  const session = useSession(true);
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
