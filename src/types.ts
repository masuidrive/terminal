export type { ArtifactFile, ServerMessage, ClientMessage } from '../shared/protocol.ts';

export interface TabState {
  id: string;        // local tab id (uuid generated client-side)
  title: string;     // user-visible label
}
