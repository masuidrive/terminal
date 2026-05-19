// File-type-dispatched renderers for the artifacts pane.
// Each renderer takes a URL (already cache-busted with ?v=mtime).

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ArtifactFile } from '../types.ts';

interface ViewProps {
  url: string;
  file: ArtifactFile;
}

export function ArtifactRenderer({ url, file }: ViewProps) {
  switch (file.ext) {
    case 'md':
    case 'markdown':
      return <MarkdownView url={url} />;
    case 'html':
    case 'htm':
      return <HtmlView url={url} />;
    case 'svg':
      return <object className="image-frame" data={url} type="image/svg+xml" />;
    case 'mmd':
    case 'mermaid':
      return <MermaidView url={url} />;
    case 'json':
      return <TextView url={url} className="json-pre" pretty="json" />;
    case 'csv':
      return <CsvView url={url} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'avif':
      return <img className="image-frame" src={url} alt={file.path} />;
    default:
      return <TextView url={url} className="code-pre" />;
  }
}

function useTextContent(url: string): string | null {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let aborted = false;
    setContent(null);
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!aborted) setContent(t);
      })
      .catch(() => { if (!aborted) setContent('// failed to load'); });
    return () => { aborted = true; };
  }, [url]);
  return content;
}

function MarkdownView({ url }: { url: string }) {
  const text = useTextContent(url);
  if (text === null) return <div className="artifact-empty">Loading…</div>;
  return (
    <div className="md-render">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function HtmlView({ url }: { url: string }) {
  return (
    <iframe
      className="html-frame"
      src={url}
      sandbox="allow-scripts allow-same-origin"
      title="artifact"
    />
  );
}

function TextView({
  url,
  className,
  pretty,
}: {
  url: string;
  className: string;
  pretty?: 'json';
}) {
  const text = useTextContent(url);
  if (text === null) return <div className="artifact-empty">Loading…</div>;
  let display = text;
  if (pretty === 'json') {
    try {
      display = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* show raw */
    }
  }
  return <pre className={className}>{display}</pre>;
}

function CsvView({ url }: { url: string }) {
  const text = useTextContent(url);
  if (text === null) return <div className="artifact-empty">Loading…</div>;
  const rows = parseCsv(text);
  if (rows.length === 0) return <div className="artifact-empty">empty</div>;
  const [head, ...body] = rows;
  return (
    <table className="csv-table">
      <thead>
        <tr>
          {head.map((c, i) => (
            <th key={i}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, i) => (
          <tr key={i}>
            {row.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Minimal CSV parser. Good enough for artifact preview, not a full RFC 4180.
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

function MermaidView({ url }: { url: string }) {
  const text = useTextContent(url);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (text === null || !hostRef.current) return;
    let cancelled = false;
    (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      try {
        const { svg } = await mermaid.render(
          'm' + Math.random().toString(36).slice(2),
          text
        );
        if (!cancelled && hostRef.current) hostRef.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled && hostRef.current) {
          hostRef.current.textContent = String(err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [text]);
  return <div ref={hostRef} />;
}
