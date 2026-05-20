#!/usr/bin/env node
// Wrapper around concurrently so we can parse our own flags before
// delegating to the server + vite dev processes. Currently only --yolo,
// which propagates to the backend via env so claude gets spawned with
// --dangerously-skip-permissions.
//
// Usage:
//   npm run dev                    # normal
//   npm run dev -- --yolo          # bypass permissions
//   YOLO=1 npm run dev             # same, env-var form

import { spawn } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
const yolo = argv.includes('--yolo') || process.env.YOLO === '1';

if (yolo) {
  console.log(
    '\x1b[33m[ticket.web] 🐉 YOLO mode: the agent is spawned without permission prompts\x1b[0m'
  );
}

const env = { ...process.env };
if (yolo) env.YOLO = '1';
// Dev is always LAN-exposed: the client talks to the backend directly, so
// it must be reachable from a phone on the same network.
env.LAN = '1';
if (argv.includes('--debug')) env.DEBUG = '1';
if (argv.includes('-c') || argv.includes('--continue')) env.CONTINUE = '1';

const child = spawn(
  'npx',
  [
    'concurrently',
    '-k',
    '-n', 'server,client',
    '-c', 'blue,green',
    'npm:dev:server',
    'npm:dev:client',
  ],
  { stdio: 'inherit', env, shell: false }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already dead */
    }
  });
}
