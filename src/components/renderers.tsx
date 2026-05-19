// File-type-dispatched renderers for the artifacts pane.
//
// - Markdown:   react-markdown + remark-gfm; ```mermaid blocks render as
//               diagrams; other ``` blocks are highlighted with shiki.
// - HTML:       sandboxed iframe.
// - SVG/PNG/…:  native <object>/<img>.
// - .mmd:       full-pane Mermaid diagram.
// - .csv:       sortable table.
// - everything else: CodeView (shiki highlight + line numbers; for big
//               files we fall back to a plain <pre>).

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ArtifactFile } from '../types.ts';

const SHIKI_THEME = 'github-dark-default';
const MAX_HIGHLIGHT_BYTES = 256 * 1024;

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
      return <MermaidStandalone url={url} />;
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
      return <CodeView url={url} ext={file.ext} />;
  }
}

// ---------------------------------------------------------------- helpers

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
      .catch(() => {
        if (!aborted) setContent('// failed to load');
      });
    return () => {
      aborted = true;
    };
  }, [url]);
  return content;
}

// Extension → shiki language id. shiki's bundled languages are a superset
// of common formats; unknown extensions fall back to 'plaintext'.
const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  py: 'python', pyi: 'python',
  rb: 'ruby', erb: 'erb',
  rs: 'rust',
  go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', fs: 'fsharp', vb: 'vb',
  php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', ash: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  json: 'json', json5: 'json5', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml', svg: 'xml', plist: 'xml',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', stylus: 'stylus',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  md: 'markdown', mdx: 'mdx', markdown: 'markdown',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  jl: 'julia',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  nim: 'nim',
  zig: 'zig',
  v: 'v',
  d: 'd',
  dart: 'dart',
  diff: 'diff', patch: 'diff',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  env: 'bash',
  make: 'make', mk: 'make',
  cmake: 'cmake',
  gradle: 'groovy',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  proto: 'proto',
  txt: 'plaintext', log: 'plaintext',
};

function shikiLangFor(ext: string): string {
  return EXT_TO_LANG[ext.toLowerCase()] ?? 'plaintext';
}

// Lazy shiki highlighter — created on first use, cached, languages loaded
// on demand. shiki is ~1 MB so we never want it on the critical path.
type ShikiHighlighter = Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>;
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(lang: string): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import('shiki');
      return shiki.createHighlighter({
        themes: [SHIKI_THEME],
        langs: ['plaintext'],
      });
    })();
  }
  const hi = await highlighterPromise;
  if (lang !== 'plaintext' && !loadedLangs.has(lang)) {
    try {
      await hi.loadLanguage(lang as never);
      loadedLangs.add(lang);
    } catch {
      // unknown to shiki — caller will fall back to plaintext
    }
  }
  return hi;
}

// ---------------------------------------------------------------- code

interface CodeViewProps {
  url: string;
  ext: string;
}

function CodeView({ url, ext }: CodeViewProps) {
  const text = useTextContent(url);
  const [html, setHtml] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    if (text === null) {
      setHtml(null);
      setTooLarge(false);
      return;
    }
    // Pretty-print JSON for both display and highlighting.
    let source = text;
    if (ext === 'json') {
      try {
        source = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
    }
    if (source.length > MAX_HIGHLIGHT_BYTES) {
      setTooLarge(true);
      setHtml(null);
      return;
    }
    setTooLarge(false);
    let cancelled = false;
    (async () => {
      const requested = shikiLangFor(ext);
      const hi = await getHighlighter(requested);
      const lang = hi.getLoadedLanguages().includes(requested as never)
        ? requested
        : 'plaintext';
      const out = hi.codeToHtml(source, {
        lang,
        theme: SHIKI_THEME,
        transformers: [
          {
            line(node, lineNumber) {
              // Stash the line number on the element so CSS ::before can
              // render it. We also tag it as `data-line` for the gutter.
              const props = node.properties as Record<string, unknown>;
              props['data-line'] = String(lineNumber);
            },
          },
        ],
      });
      if (!cancelled) setHtml(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [text, ext]);

  if (text === null) return <div className="artifact-empty">Loading…</div>;
  if (tooLarge) {
    return (
      <div>
        <div className="artifact-note">
          File is larger than 256 KB — rendering as plain text without
          syntax highlighting.
        </div>
        <pre className="code-pre">{text}</pre>
      </div>
    );
  }
  if (html === null) {
    // shiki still warming up — render the raw text so the user sees
    // content immediately.
    return <pre className="code-pre">{text}</pre>;
  }
  return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------- markdown

function MarkdownView({ url }: { url: string }) {
  const text = useTextContent(url);
  if (text === null) return <div className="artifact-empty">Loading…</div>;
  return (
    <div className="md-render">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...rest }) {
            const match = /language-([\w-]+)/.exec(className ?? '');
            const lang = match?.[1];
            const raw = String(children).replace(/\n$/, '');
            if (lang === 'mermaid') {
              return <MermaidBlock code={raw} />;
            }
            if (lang) {
              return <InlineHighlight code={raw} lang={lang} />;
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre({ node, children }) {
            // We unwrap the default <pre> when the fenced block had a
            // language tag — the code() handler replaces those with our
            // own renderer (Mermaid or a shiki <pre>), which doesn't want
            // a second <pre> around it.
            type AstNode = { tagName?: string; properties?: { className?: string[] }; children?: AstNode[] };
            const ast = node as unknown as AstNode | undefined;
            const codeChild = ast?.children?.find((c) => c.tagName === 'code');
            const cls = (codeChild?.properties?.className ?? []).join(' ');
            if (cls && /language-[\w-]+/.test(cls)) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function InlineHighlight({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hi = await getHighlighter(lang);
        const resolved = hi.getLoadedLanguages().includes(lang as never) ? lang : 'plaintext';
        const out = hi.codeToHtml(code, { lang: resolved, theme: SHIKI_THEME });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  if (html === null) {
    return <pre className="code-pre">{code}</pre>;
  }
  return (
    <div className="code-block inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

// ---------------------------------------------------------------- html

function HtmlView({ url }: { url: string }) {
  // Intentionally omit `allow-same-origin`: pairing it with `allow-scripts`
  // lets the framed document reach the parent's origin (cookies, /api, /ws),
  // which means a Claude-generated HTML artifact could drive the PTY.
  return (
    <iframe
      className="html-frame"
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title="artifact"
    />
  );
}

// ---------------------------------------------------------------- csv

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

// ---------------------------------------------------------------- mermaid

function MermaidStandalone({ url }: { url: string }) {
  const text = useTextContent(url);
  if (text === null) return <div className="artifact-empty">Loading…</div>;
  return <MermaidBlock code={text} />;
}

function MermaidBlock({ code }: { code: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    let cancelled = false;
    (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      try {
        const { svg } = await mermaid.render(
          'm' + Math.random().toString(36).slice(2),
          code
        );
        if (!cancelled && hostRef.current) hostRef.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled && hostRef.current) {
          hostRef.current.textContent = String(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);
  return <div ref={hostRef} className="mermaid-block" />;
}
