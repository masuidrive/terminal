#!/usr/bin/env node
// Production / `npx` entry point. Runs the TypeScript backend through the
// tsx loader; the backend serves both the built client (dist/) and the
// API on a single port. The client is built ahead of time by the
// `prepare` lifecycle script when the package is installed.
//
// Usage:
//   npx github:masuidrive/terminal           # localhost only, quiet
//   npx github:masuidrive/terminal --lan     # also reachable on the LAN
//   npx github:masuidrive/terminal --yolo    # agent skips permission prompts
//   npx github:masuidrive/terminal --debug   # verbose logs + access log
//   SERVER_PORT=8080 npx github:masuidrive/terminal

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const argv = process.argv.slice(2);
if (argv.includes('--yolo') || process.env.YOLO === '1') {
  process.env.YOLO = '1';
  console.log(
    '\x1b[33m🐉 YOLO mode: the agent is spawned without permission prompts\x1b[0m'
  );
}
if (argv.includes('--lan')) process.env.LAN = '1';
if (argv.includes('--debug')) process.env.DEBUG = '1';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(root, 'server', 'index.ts');

register();
await import(pathToFileURL(serverEntry).href);
