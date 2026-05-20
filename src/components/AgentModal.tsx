// Shown over a fresh tab until the user picks which CLI agent to spawn.
// The overlay only covers the panel area — the tab bar stays reachable,
// so the user can switch or close the tab instead of choosing.

import type { AgentKind } from '../types.ts';

interface Props {
  onPick: (agent: AgentKind) => void;
}

export function AgentModal({ onPick }: Props) {
  return (
    <div className="agent-modal-backdrop">
      <div className="agent-modal">
        <h2 className="agent-modal-title">Start a session</h2>
        <div className="agent-options">
          <button className="agent-option" onClick={() => onPick('claude')}>
            <span className="agent-option-name">Claude Code</span>
            <span className="agent-option-desc">
              Anthropic · artifacts panel enabled
            </span>
          </button>
          <button className="agent-option" onClick={() => onPick('codex')}>
            <span className="agent-option-name">Codex</span>
            <span className="agent-option-desc">OpenAI Codex CLI</span>
          </button>
        </div>
      </div>
    </div>
  );
}
