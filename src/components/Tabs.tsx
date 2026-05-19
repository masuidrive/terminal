import type { TabState } from '../types.ts';

interface Props {
  tabs: TabState[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function Tabs({ tabs, activeId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={'tab' + (t.id === activeId ? ' active' : '')}
        >
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
  );
}
