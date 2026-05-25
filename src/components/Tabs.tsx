import type { SessionSummary } from '../types.ts';

type ViewMode = 'split' | 'term' | 'artifacts';

interface Props {
  tabs: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  view: ViewMode;
  onViewChange: (m: ViewMode) => void;
  /** If false, the Split button is hidden (narrow viewports). */
  showSplit: boolean;
  /** Server PROJECT_DIR; shown next to the view toggle as a breadcrumb. */
  projectDir: string | null;
}

// Show the full path when it's short. Once it's long, drop everything but
// the trailing two path segments and prepend `…/`.
function shortenPath(p: string): string {
  if (p.length <= 28) return p;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

// Title is derived from the agent + this session's position among
// sessions of the same agent. So "claude 1", "codex 1", "claude 2",
// matching what the user used to see in the per-tab title.
function deriveTitles(tabs: SessionSummary[]): Map<string, string> {
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  for (const t of tabs) {
    const n = (counts.get(t.agent) ?? 0) + 1;
    counts.set(t.agent, n);
    out.set(t.id, `${t.agent} ${n}`);
  }
  return out;
}

export function Tabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  view,
  onViewChange,
  showSplit,
  projectDir,
}: Props) {
  const titles = deriveTitles(tabs);
  return (
    <div className="tabs">
      <div className="tabs-list">
        {tabs.map((t) => {
          const title = titles.get(t.id) ?? t.agent;
          return (
            <div
              key={t.id}
              className={
                'tab' +
                (t.id === activeId ? ' active' : '') +
                (t.attached && t.id !== activeId ? ' tab-attached-elsewhere' : '')
              }
              title={
                t.attached && t.id !== activeId
                  ? `${title} — in use on another device`
                  : title
              }
            >
              <button
                className="tab-label"
                onClick={() => onSelect(t.id)}
              >
                {title}
                {t.attached && t.id !== activeId && (
                  <span className="tab-attached-dot" aria-hidden="true" />
                )}
              </button>
              <button
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="tab-new" onClick={onNew} title="New tab">
          +
        </button>
      </div>
      {projectDir && (
        <span className="tab-path" title={projectDir}>
          {shortenPath(projectDir)}
        </span>
      )}
      <div className="view-toggle">
        <button
          className={'view-btn' + (view === 'term' ? ' active' : '')}
          onClick={() => onViewChange('term')}
          title="Show terminal only"
        >
          Term
        </button>
        <button
          className={'view-btn' + (view === 'artifacts' ? ' active' : '')}
          onClick={() => onViewChange('artifacts')}
          title="Show artifacts only"
        >
          Files
        </button>
        {showSplit && (
          <button
            className={'view-btn' + (view === 'split' ? ' active' : '')}
            onClick={() => onViewChange('split')}
            title="Show both side-by-side"
          >
            Split
          </button>
        )}
      </div>
    </div>
  );
}
