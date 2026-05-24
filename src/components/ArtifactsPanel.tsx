import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ArtifactFile } from '../types.ts';
import { ArtifactRenderer } from './renderers.tsx';

interface MenuAnchor {
  file: ArtifactFile;
  x: number;  // viewport coords of the trigger's right edge
  y: number;  // viewport coords just below the trigger
}

interface Props {
  sessionId: string | null;
  artifactsDir: string | null;
  artifacts: ArtifactFile[];
}

export function ArtifactsPanel({ sessionId, artifactsDir, artifacts }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  // Follow-mode: when a new/updated artifact arrives and the user hasn't
  // pinned a selection, jump to it.
  const [follow, setFollow] = useState(true);
  // Collapse the file list to give the preview the full pane width.
  const [listCollapsed, setListCollapsed] = useState(false);
  // Per-row "more" menu: anchor coords + which file it's open for.
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  useEffect(() => {
    if (!follow) return;
    if (artifacts.length > 0) setSelected(artifacts[0]!.path);
    else setSelected(null);
  }, [artifacts, follow]);

  // Close the menu when the file disappears (e.g., another tab deleted it).
  useEffect(() => {
    if (menuAnchor && !artifacts.some((f) => f.path === menuAnchor.file.path)) {
      setMenuAnchor(null);
    }
  }, [artifacts, menuAnchor]);

  // Close on outside click, Escape, or any scroll (the fixed position
  // would otherwise drift away from the trigger).
  useEffect(() => {
    if (!menuAnchor) return;
    function onDown(e: globalThis.MouseEvent) {
      const t = e.target as Element;
      if (t.closest('.artifact-menu') || t.closest('.artifact-row-menu')) return;
      setMenuAnchor(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuAnchor(null);
    }
    function onScroll() { setMenuAnchor(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menuAnchor]);

  function openMenu(e: MouseEvent<HTMLButtonElement>, f: ArtifactFile) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor({ file: f, x: rect.right, y: rect.bottom + 4 });
  }

  // With 0-1 artifacts there's no list to pick from, so fall back to the
  // sole artifact.
  const file =
    artifacts.find((f) => f.path === selected) ??
    (artifacts.length === 1 ? artifacts[0]! : null);
  const url =
    file && sessionId
      ? `/artifacts/${sessionId}/${encodeURI(file.path)}?v=${file.mtime}`
      : null;
  const absolutePath = file && artifactsDir ? `${artifactsDir}/${file.path}` : null;

  // The file list only earns its column with 2+ artifacts.
  const hasList = artifacts.length >= 2;
  const hideList = !hasList || listCollapsed;

  return (
    <div className={'artifacts' + (hideList ? ' list-collapsed' : '')}>
      <div className="artifacts-header">
        {hasList && (
          <button
            className="artifacts-collapse"
            onClick={() => setListCollapsed((c) => !c)}
            title={listCollapsed ? 'Show file list' : 'Hide file list'}
          >
            {/* Two glyphs; CSS shows the one matching the current layout
                (side-by-side: « », stacked vertically: ▲ ▼). */}
            <span className="arrow-h">{listCollapsed ? '»' : '«'}</span>
            <span className="arrow-v">{listCollapsed ? '▼' : '▲'}</span>
          </button>
        )}
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
          {artifacts.map((f) => (
            <div
              key={f.path}
              className={'artifact-row' + (selected === f.path ? ' active' : '')}
            >
              <button
                className="artifact-row-main"
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
              <button
                className="artifact-row-menu"
                onClick={(e) => openMenu(e, f)}
                title="More actions"
                aria-label="More actions"
              >
                ⋯
              </button>
            </div>
          ))}
        </div>
        <div className="artifact-pane">
          {file && url ? (
            <>
              <ArtifactPathBar path={file.path} absolute={absolutePath} />
              <div className="artifact-view">
                <ArtifactRenderer
                  key={`${file.path}@${file.mtime}`}
                  url={url}
                  file={file}
                />
              </div>
            </>
          ) : artifacts.length === 0 ? (
            <div className="artifact-empty">
              No artifacts yet.
              <br />
              Claude writes files to <code>$CLAUDE_ARTIFACTS_DIR</code>.
            </div>
          ) : (
            <div className="artifact-empty">Select an artifact</div>
          )}
        </div>
      </div>
      {menuAnchor && (
        <div
          className="artifact-menu"
          role="menu"
          style={{
            position: 'fixed',
            left: menuAnchor.x,
            top: menuAnchor.y,
            // Anchor to the trigger's right edge; popup grows to the left
            // so it doesn't run off the viewport.
            transform: 'translate(-100%, 0)',
          }}
        >
          <button
            onClick={() => {
              void copyToClipboard(basename(menuAnchor.file.path));
              setMenuAnchor(null);
            }}
          >
            Copy name
          </button>
          <button
            onClick={() => {
              void copyToClipboard(
                artifactsDir
                  ? `${artifactsDir}/${menuAnchor.file.path}`
                  : menuAnchor.file.path,
              );
              setMenuAnchor(null);
            }}
          >
            Copy path
          </button>
          <button
            onClick={() => {
              if (sessionId) downloadArtifact(sessionId, menuAnchor.file);
              setMenuAnchor(null);
            }}
          >
            Download
          </button>
          <button
            className="artifact-menu-danger"
            onClick={() => {
              void deleteArtifact(menuAnchor.file);
              setMenuAnchor(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* clipboard may be blocked over http or in old browsers */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* give up */ }
  ta.remove();
}

function downloadArtifact(sessionId: string, file: ArtifactFile): void {
  const a = document.createElement('a');
  a.href = `/artifacts/${sessionId}/${encodeURI(file.path)}?v=${file.mtime}`;
  a.download = basename(file.path);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function deleteArtifact(file: ArtifactFile): Promise<void> {
  try {
    await fetch(`/api/artifacts?name=${encodeURIComponent(file.path)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    console.error('[artifacts] delete failed:', err);
  }
}

function ArtifactPathBar({
  path,
  absolute,
}: {
  path: string;
  absolute: string | null;
}) {
  const [copied, setCopied] = useState<'rel' | 'abs' | null>(null);

  async function copy(value: string, which: 'rel' | 'abs') {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      // clipboard may be blocked over http or in old browsers
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(which);
        setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
      } catch {
        /* give up */
      }
      ta.remove();
    }
  }

  return (
    <div className="artifact-pathbar" title={absolute ?? path}>
      <span className="artifact-pathbar-path">{path}</span>
      <button
        className="artifact-pathbar-copy"
        onClick={() => copy(path, 'rel')}
        title="Copy relative path"
      >
        {copied === 'rel' ? '✓ copied' : 'name'}
      </button>
      {absolute && (
        <button
          className="artifact-pathbar-copy"
          onClick={() => copy(absolute, 'abs')}
          title={`Copy absolute path\n${absolute}`}
        >
          {copied === 'abs' ? '✓ copied' : 'abs path'}
        </button>
      )}
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
