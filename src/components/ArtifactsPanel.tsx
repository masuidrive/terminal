import { useEffect, useState } from 'react';
import type { ArtifactFile } from '../types.ts';
import { ArtifactRenderer } from './renderers.tsx';

interface Props {
  sessionId: string | null;
  artifacts: ArtifactFile[];
}

export function ArtifactsPanel({ sessionId, artifacts }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  // Follow-mode: when a new/updated artifact arrives and the user hasn't
  // pinned a selection, jump to it.
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    if (artifacts.length > 0) setSelected(artifacts[0]!.path);
    else setSelected(null);
  }, [artifacts, follow]);

  const file = artifacts.find((f) => f.path === selected) ?? null;
  const url = file && sessionId
    ? `/artifacts/${sessionId}/${encodeURI(file.path)}?v=${file.mtime}`
    : null;

  return (
    <div className="artifacts">
      <div className="artifacts-header">
        <span>Artifacts</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow latest
        </label>
      </div>
      <div className="artifacts-body">
        <div className="artifacts-list">
          {artifacts.length === 0 && (
            <div className="artifact-empty" style={{ height: 'auto', padding: 12 }}>
              No artifacts yet.
              <br />
              Claude writes files to <code>$CLAUDE_ARTIFACTS_DIR</code>.
            </div>
          )}
          {artifacts.map((f) => (
            <button
              key={f.path}
              className={'artifact-row' + (selected === f.path ? ' active' : '')}
              onClick={() => {
                setFollow(false);
                setSelected(f.path);
              }}
            >
              <span className="artifact-name">{f.path}</span>
              <span className="artifact-meta">
                {fmtSize(f.size)} · {fmtTime(f.mtime)}
              </span>
            </button>
          ))}
        </div>
        <div className="artifact-view">
          {file && url ? (
            <ArtifactRenderer
              key={`${file.path}@${file.mtime}`}
              url={url}
              file={file}
            />
          ) : (
            <div className="artifact-empty">Select an artifact</div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = (now - ms) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleString();
}
