import type { TabState } from '../types.ts';

type ViewMode = 'split' | 'term' | 'artifacts';

interface Props {
  tabs: TabState[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  view: ViewMode;
  onViewChange: (m: ViewMode) => void;
  /** If false, the Split button is hidden (narrow viewports). */
  showSplit: boolean;
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
}: Props) {
  return (
    <div className="tabs">
      <div className="tabs-list">
        {tabs.map((t) => (
          <div key={t.id} className={'tab' + (t.id === activeId ? ' active' : '')}>
            <button
              className="tab-label"
              onClick={() => onSelect(t.id)}
              title={t.title}
            >
              {t.title}
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
        ))}
        <button className="tab-new" onClick={onNew} title="New tab">
          +
        </button>
      </div>
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
