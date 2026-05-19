// Termux-style soft-keyboard helper row. Buttons send byte sequences
// directly to the PTY via the session API. Tap CTRL / SHIFT / ALT to
// arm a modifier; the next key fires with it and the modifier disarms.
//
// `onPointerDown` with preventDefault keeps focus on xterm's hidden
// textarea, which keeps the on-screen keyboard from dismissing between
// taps.

import type { PointerEvent } from 'react';
import { useState } from 'react';
import type { SessionApi } from '../hooks/useSession.ts';

type ArrowLetter = 'A' | 'B' | 'C' | 'D';

type KeyDef =
  | { label: string; kind: 'raw'; bytes: string }
  | { label: string; kind: 'char'; char: string }
  | { label: string; kind: 'arrow'; letter: ArrowLetter }
  | { label: string; kind: 'tab' }
  | { label: string; kind: 'modifier'; mod: 'ctrl' | 'shift' | 'alt' }
  | { label: string; kind: 'macro'; bytes: string };

// Mirror of a Termux `extra-keys` config:
//   [['ESC','&','/','-','_','UP', {macro:"CTRL b", display:'C-b'}],
//    ['TAB','CTRL','SHIFT','ALT','LEFT','DOWN','RIGHT']]
const ROWS: ReadonlyArray<ReadonlyArray<KeyDef>> = [
  [
    { label: 'Esc', kind: 'raw', bytes: '\x1b' },
    { label: '&',   kind: 'char', char: '&' },
    { label: '/',   kind: 'char', char: '/' },
    { label: '-',   kind: 'char', char: '-' },
    { label: '_',   kind: 'char', char: '_' },
    { label: '↑',   kind: 'arrow', letter: 'A' },
    { label: 'C-b', kind: 'macro', bytes: '\x02' },
  ],
  [
    { label: 'Tab',   kind: 'tab' },
    { label: 'Ctrl',  kind: 'modifier', mod: 'ctrl'  },
    { label: 'Shift', kind: 'modifier', mod: 'shift' },
    { label: 'Alt',   kind: 'modifier', mod: 'alt'   },
    { label: '←',     kind: 'arrow', letter: 'D' },
    { label: '↓',     kind: 'arrow', letter: 'B' },
    { label: '→',     kind: 'arrow', letter: 'C' },
  ],
];

interface Props {
  session: SessionApi;
}

export function KeyboardToolbar({ session }: Props) {
  const [ctrl, setCtrl]   = useState(false);
  const [shift, setShift] = useState(false);
  const [alt, setAlt]     = useState(false);

  function clearMods() { setCtrl(false); setShift(false); setAlt(false); }

  // xterm modifier param: 1 + shift + alt*2 + ctrl*4
  function modParam(): number {
    return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  }

  function press(k: KeyDef, e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault();

    if (k.kind === 'modifier') {
      if (k.mod === 'ctrl')  setCtrl(v => !v);
      if (k.mod === 'shift') setShift(v => !v);
      if (k.mod === 'alt')   setAlt(v => !v);
      return;
    }

    if (k.kind === 'macro') {
      session.sendInput(k.bytes);
      clearMods();
      return;
    }

    let bytes = '';
    if (k.kind === 'raw') {
      bytes = k.bytes;
    } else if (k.kind === 'char') {
      let c = k.char;
      if (shift && c >= 'a' && c <= 'z') c = c.toUpperCase();
      // Ctrl+single-char → ASCII control byte (e.g. Ctrl+/ = 0x1f).
      if (ctrl) c = String.fromCharCode(c.charCodeAt(0) & 0x1f);
      bytes = c;
      if (alt) bytes = '\x1b' + bytes;
    } else if (k.kind === 'arrow') {
      const m = modParam();
      bytes = m === 1 ? `\x1b[${k.letter}` : `\x1b[1;${m}${k.letter}`;
    } else if (k.kind === 'tab') {
      if (shift)    bytes = '\x1b[Z';
      else if (alt) bytes = '\x1b\t';
      else          bytes = '\t';
    }

    session.sendInput(bytes);
    clearMods();
  }

  return (
    <div className="kbd-toolbar" role="toolbar" aria-label="terminal keys">
      {ROWS.map((row, i) => (
        <div className="kbd-row" key={i}>
          {row.map((k) => {
            const armed =
              k.kind === 'modifier' &&
              ((k.mod === 'ctrl'  && ctrl) ||
               (k.mod === 'shift' && shift) ||
               (k.mod === 'alt'   && alt));
            return (
              <button
                key={k.label}
                className={'kbd-btn' + (armed ? ' kbd-armed' : '')}
                tabIndex={-1}
                onPointerDown={(e) => press(k, e)}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
