// Shown over a fresh tab until the user picks which CLI agent to spawn.
// Only rendered when more than one agent is available (a lone agent is
// chosen automatically) or when none were found. The overlay covers just
// the panel area — the tab bar stays reachable.

import type { AgentKind } from '../types.ts';

interface Props {
  agents: AgentKind[];
  onPick: (agent: AgentKind) => void;
}

const AGENT_INFO: Record<AgentKind, { name: string; desc: string }> = {
  claude: { name: 'Claude Code', desc: 'Anthropic · artifacts panel enabled' },
  codex: { name: 'Codex', desc: 'OpenAI Codex CLI' },
};

export function AgentModal({ agents, onPick }: Props) {
  return (
    <div className="agent-modal-backdrop">
      <div className="agent-modal">
        {agents.length === 0 ? (
          <>
            <h2 className="agent-modal-title">No agent found</h2>
            <p className="agent-modal-note">
              Neither <code>claude</code> nor <code>codex</code> was found on
              PATH. Install one and reload.
            </p>
          </>
        ) : (
          <>
            <h2 className="agent-modal-title">Start a session</h2>
            <div className="agent-options">
              {agents.map((a) => (
                <button
                  key={a}
                  className="agent-option"
                  onClick={() => onPick(a)}
                >
                  <span className="agent-option-name">{AGENT_INFO[a].name}</span>
                  <span className="agent-option-desc">{AGENT_INFO[a].desc}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
