import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

// On-screen error overlay. Anything thrown during boot or as an unhandled
// promise rejection appears here, so a blank page isn't silent.
function showError(label: string, err: unknown) {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  const root = document.body;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#5c1a1a;color:#fff;' +
    'padding:10px 14px;font:12px ui-monospace,monospace;white-space:pre-wrap;max-height:50vh;overflow:auto;';
  div.textContent = `[${label}] ${msg}`;
  root.appendChild(div);
}
window.addEventListener('error', (e) => showError('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError('unhandled', e.reason));

// Recovery hatch: ?reset=1 nukes everything we persist in localStorage
// and reloads. Useful when a stale session-id mapping is making the
// page render blank.
if (new URLSearchParams(location.search).get('reset') === '1') {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('ticket-web:')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  location.replace(location.pathname);
}

// Mobile / no-keyboard debug console. Triggered by visiting with
// `?debug=1`, by setting `localStorage.debug = '1'`, or by long-pressing
// the page in dev mode. Tap the floating gear that appears bottom-right
// to open a full console / network / DOM inspector.
const wantDebug =
  new URLSearchParams(location.search).get('debug') === '1' ||
  (() => { try { return localStorage.getItem('ticket-web:debug') === '1'; } catch { return false; } })();
if (wantDebug) {
  void import('eruda').then(({ default: eruda }) => {
    eruda.init({ tool: ['console', 'elements', 'network', 'resources', 'info'] });
    try { localStorage.setItem('ticket-web:debug', '1'); } catch { /* ignore */ }
  });
}

// StrictMode is intentionally NOT used: xterm.js schedules internal
// setTimeouts during `open()` that read into `_renderService` later. Under
// StrictMode's mount → unmount(dispose) → remount cycle, the pending timer
// fires after dispose and reads undefined, crashing the page. Many
// xterm-based React apps disable StrictMode for this reason.
// Remove the static boot probe — its presence after this point would
// mean main.tsx never reached this line.
document.getElementById('boot-probe')?.remove();

createRoot(document.getElementById('root')!).render(<App />);
