import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

// StrictMode is intentionally NOT used: xterm.js schedules internal
// setTimeouts during `open()` that read into `_renderService` later. Under
// StrictMode's mount → unmount(dispose) → remount cycle, the pending timer
// fires after dispose and reads undefined, crashing the page. Many
// xterm-based React apps disable StrictMode for this reason.
createRoot(document.getElementById('root')!).render(<App />);
