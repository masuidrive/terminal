// xterm's WebLinksAddon only stitches together terminal-wrapped (isWrapped)
// rows. Agents like claude / codex render their TUI with explicit line
// breaks, so a long URL — e.g. the OAuth URL printed by `/login` — is
// split across separate buffer lines and stops being recognised as one
// link. This link provider rejoins consecutive lines (wrapped OR
// explicitly broken), so the whole URL is clickable and opens in a new tab.

import type { IBufferLine, ILink, Terminal } from '@xterm/xterm';

// URL body: the ASCII characters legal in a URL, minus the brackets and
// quotes that usually wrap a URL rather than belong to it. Restricting to
// ASCII also makes a URL stop cleanly when CJK text follows it with no
// separating space — common in Japanese — instead of swallowing it.
const URL_CHARS = 'A-Za-z0-9!#$%&*+,./:;=?@_~\\-';
const URL_RE = new RegExp(`https?://[${URL_CHARS}]+`, 'gi');
const URL_CHAR = new RegExp(`[${URL_CHARS}]`);
const MAX_BLOCK_ROWS = 40;

export function registerWrappedLinkProvider(term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      callback(computeLinks(term, lineNumber));
    },
  });
}

// Whether `below` continues `above` for URL reassembly: a terminal-wrapped
// row, or a row an agent's renderer broke mid-URL with an explicit
// newline. We can't recover the renderer's intent, so any explicit break
// counts as a continuation when both sides of the seam are URL characters.
// This also stitches plain wrapped prose, which is harmless: URL_RE only
// yields a link when a scheme is present, and a non-URL char (space, CJK,
// quote) on either side stops the run. Earlier code additionally required
// `above` to reach the right edge — that dropped URLs whose renderer
// wrapped them at `&`/`/` delimiters or within a margin, leaving the line
// short of `cols`.
function continues(above: IBufferLine, below: IBufferLine): boolean {
  if (below.isWrapped) return true;
  const a = above.translateToString(true);
  const b = below.translateToString(true);
  if (!a.length || !b.length) return false;
  // A fresh list / ordered-list item is a new logical line, not a URL
  // that happens to resume with a URL-valid character.
  if (/^\s*([-*+]|\d+[.)])\s/.test(b)) return false;
  return URL_CHAR.test(a[a.length - 1]!) && URL_CHAR.test(b[0]!);
}

function computeLinks(term: Terminal, lineNumber: number): ILink[] | undefined {
  const buf = term.buffer.active;
  const y0 = lineNumber - 1;
  if (!buf.getLine(y0)) return undefined;

  // Extend up and down across continuation lines to span the whole block.
  let start = y0;
  while (start > 0) {
    const prev = buf.getLine(start - 1);
    const cur = buf.getLine(start);
    if (!prev || !cur || !continues(prev, cur)) break;
    start--;
    if (y0 - start > MAX_BLOCK_ROWS) break;
  }
  const rows: { y: number; text: string }[] = [];
  for (let r = start; ; r++) {
    const cur = buf.getLine(r);
    if (!cur) break;
    rows.push({ y: r, text: cur.translateToString(true) });
    const next = buf.getLine(r + 1);
    if (!next || !continues(cur, next)) break;
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
