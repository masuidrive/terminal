// xterm's WebLinksAddon only stitches together terminal-wrapped (isWrapped)
// rows. Agents like claude / codex render their TUI with explicit line
// breaks, so a long URL — e.g. the OAuth URL printed by `/login` — is
// split across separate buffer lines and stops being recognised as one
// link. This link provider rejoins consecutive lines (wrapped OR
// explicitly broken), so the whole URL is clickable and opens in a new tab.

import type { IBufferLine, ILink, Terminal } from '@xterm/xterm';

// URL body: anything that isn't whitespace, a quote, or a bracket/pipe/etc.
const URL_EXCLUDE = '\\s"\'`<>(){}\\[\\]|\\\\^';
const URL_RE = new RegExp(`https?://[^${URL_EXCLUDE}]+`, 'gi');
const URL_CHAR = new RegExp(`[^${URL_EXCLUDE}]`);
const MAX_BLOCK_ROWS = 40;

export function registerWrappedLinkProvider(term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      callback(computeLinks(term, lineNumber));
    },
  });
}

// Whether `below` continues `above` for URL reassembly: a terminal-wrapped
// row, or `above` ran (almost) to the right edge with URL-valid characters
// on both sides of the break.
function continues(above: IBufferLine, below: IBufferLine, cols: number): boolean {
  if (below.isWrapped) return true;
  const a = above.translateToString(true);
  const b = below.translateToString(true);
  if (a.length < cols - 4 || !a.length || !b.length) return false;
  return URL_CHAR.test(a[a.length - 1]!) && URL_CHAR.test(b[0]!);
}

function computeLinks(term: Terminal, lineNumber: number): ILink[] | undefined {
  const buf = term.buffer.active;
  const cols = term.cols;
  const y0 = lineNumber - 1;
  if (!buf.getLine(y0)) return undefined;

  // Extend up and down across continuation lines to span the whole block.
  let start = y0;
  while (start > 0) {
    const prev = buf.getLine(start - 1);
    const cur = buf.getLine(start);
    if (!prev || !cur || !continues(prev, cur, cols)) break;
    start--;
    if (y0 - start > MAX_BLOCK_ROWS) break;
  }
  const rows: { y: number; text: string }[] = [];
  for (let r = start; ; r++) {
    const cur = buf.getLine(r);
    if (!cur) break;
    rows.push({ y: r, text: cur.translateToString(true) });
    const next = buf.getLine(r + 1);
    if (!next || !continues(cur, next, cols)) break;
    if (r - start > MAX_BLOCK_ROWS) break;
  }

  // Join the rows, tracking where each starts in the joined string.
  let joined = '';
  const offsets: number[] = [];
  for (const row of rows) {
    offsets.push(joined.length);
    joined += row.text;
  }

  const links: ILink[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(joined))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (url.length < 12) continue;
    const a = locate(rows, offsets, m.index);
    const b = locate(rows, offsets, m.index + url.length - 1);
    if (!a || !b) continue;
    // Only surface the link when it actually covers the queried line.
    if (lineNumber < a.y + 1 || lineNumber > b.y + 1) continue;
    links.push({
      text: url,
      range: {
        start: { x: a.x + 1, y: a.y + 1 },
        end: { x: b.x + 1, y: b.y + 1 },
      },
      activate: () => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    });
  }
  return links.length ? links : undefined;
}

// Map an index in the joined string back to a buffer row and column.
function locate(
  rows: { y: number; text: string }[],
  offsets: number[],
  idx: number,
): { y: number; x: number } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (idx >= offsets[i]!) return { y: rows[i]!.y, x: idx - offsets[i]! };
  }
  return null;
}
