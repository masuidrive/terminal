// Termux-style soft-keyboard helper row. Each button sends a fixed byte
// sequence directly to the PTY via the session API.
//
// `onPointerDown` with preventDefault keeps focus on xterm's hidden
// textarea, which keeps the on-screen keyboard from dismissing between
// taps.

import type { PointerEvent } from 'react';
import type { SessionApi } from '../hooks/useSession.ts';

type ArrowLetter = 'A' | 'B' | 'C' | 'D';

type KeyDef =
  | { label: string; kind: 'raw'; bytes: string }
  | { label: string; kind: 'char'; char: string }
  | { label: string; kind: 'arrow'; letter: ArrowLetter }
  | { label: string; kind: 'tab' }
  | { label: string; kind: 'macro'; bytes: string };

const ROWS: ReadonlyArray<ReadonlyArray<KeyDef>> = [
  [
    { label: 'Esc',   kind: 'raw',   bytes: '\x1b' },
    { label: 'C-b',   kind: 'macro', bytes: '\x02' },
    { label: '/',     kind: 'char',  char: '/' },
    { label: '-',     kind: 'char',  char: '-' },
    { label: '_',     kind: 'char',  char: '_' },
    { label: '↑',     kind: 'arrow', letter: 'A' },
    { label: 'Enter', kind: 'raw',   bytes: '\r' },
  ],
  [
    { label: 'Tab',   kind: 'tab' },
    { label: 'C-c',   kind: 'macro', bytes: '\x03' },
    { label: 'Space', kind: 'char',  char: ' ' },
    { label: 'C-j',   kind: 'macro', bytes: '\n' },
    { label: '←',     kind: 'arrow', letter: 'D' },
    { label: '↓',     kind: 'arrow', letter: 'B' },
    { label: '→',     kind: 'arrow', letter: 'C' },
  ],
];

interface Props {
  session: SessionApi;
}

export function KeyboardToolbar({ session }: Props) {
  function press(k: KeyDef, e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault();

    let bytes = '';
    if (k.kind === 'raw' || k.kind === 'macro') {
      bytes = k.bytes;
    } else if (k.kind === 'char') {
      bytes = k.char;
    } else if (k.kind === 'arrow') {
      bytes = `\x1b[${k.letter}`;
    } else if (k.kind === 'tab') {
      bytes = '\t';
    }

    session.sendInput(bytes);
  }

  return (
    <div className="kbd-toolbar" role="toolbar" aria-label="terminal keys">
      {ROWS.map((row, i) => (
        <div className="kbd-row" key={i}>
          {row.map((k) => (
            <button
              key={k.label}
              className="kbd-btn"
              tabIndex={-1}
              onPointerDown={(e) => press(k, e)}
            >
              {k.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
