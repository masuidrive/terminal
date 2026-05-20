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
