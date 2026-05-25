// Pure agent picker — shown when the user clicks "+" to spawn a new
// tab (or auto-shown on first visit if the tab strip is empty and
// nothing was preloaded via --INITIAL_AGENT). The resume-existing
// path lives in the tab strip itself now: every server session is a
// visible tab on every device, so there's nothing separate to recover.

import type { AgentKind } from '../types.ts';

interface Props {
  agents: AgentKind[];
  onPick: (agent: AgentKind) => void;
  onCancel?: () => void;
}

const AGENT_INFO: Record<AgentKind, { name: string; desc: string }> = {
  claude: { name: 'Claude Code', desc: 'Anthropic · artifacts panel enabled' },
  codex: { name: 'Codex', desc: 'OpenAI Codex CLI' },
};

export function AgentModal({ agents, onPick, onCancel }: Props) {
  if (agents.length === 0) {
    return (
      <div className="agent-modal-backdrop">
        <div className="agent-modal">
          <h2 className="agent-modal-title">No agent found</h2>
          <p className="agent-modal-note">
            Neither <code>claude</code> nor <code>codex</code> was found on
            PATH. Install one and reload.
          </p>
          {onCancel && (
            <button className="agent-modal-cancel" onClick={onCancel}>Close</button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="agent-modal-backdrop">
      <div className="agent-modal">
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
        {onCancel && (
          <button className="agent-modal-cancel" onClick={onCancel}>Cancel</button>
        )}
      </div>
    </div>
  );
}
