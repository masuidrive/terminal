import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

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
createRoot(document.getElementById('root')!).render(<App />);
