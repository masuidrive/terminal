export type {
  ArtifactFile,
  ServerMessage,
  ClientMessage,
  AgentKind,
} from '../shared/protocol.ts';

import type { AgentKind } from '../shared/protocol.ts';

export interface TabState {
  id: string;            // local tab id (uuid generated client-side)
  title: string;         // user-visible label
  agent?: AgentKind;     // chosen via the startup modal; absent until picked
}

// Shape returned by GET /api/sessions — used by the Resume picker to
// let a fresh device take over a session started on another one.
export interface SessionSummary {
  id: string;
  agent: AgentKind;
  attached: boolean;
  idleMs: number;
  createdAt: number;
  preview: string;
}
