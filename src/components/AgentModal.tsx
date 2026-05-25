// Shown over a fresh tab until the user decides what to spawn — either
// pick which CLI agent to start fresh, or resume an existing session
// that's still alive on the server (possibly started from another
// device). The overlay covers just the panel area; the tab bar stays
// reachable. Only rendered when more than one agent is available (a
// lone agent is chosen automatically) or there's something to resume,
// or no agent is installed at all.

import type { AgentKind, SessionSummary } from '../types.ts';

interface Props {
  agents: AgentKind[];
  resumable: SessionSummary[];
  onPick: (agent: AgentKind) => void;
  onResume: (s: SessionSummary) => void;
}

const AGENT_INFO: Record<AgentKind, { name: string; desc: string }> = {
  claude: { name: 'Claude Code', desc: 'Anthropic · artifacts panel enabled' },
  codex: { name: 'Codex', desc: 'OpenAI Codex CLI' },
};

export function AgentModal({ agents, resumable, onPick, onResume }: Props) {
  return (
    <div className="agent-modal-backdrop">
      <div className="agent-modal">
        {agents.length === 0 && resumable.length === 0 ? (
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
            {agents.length > 0 && (
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
            )}
            {resumable.length > 0 && (
              <>
                <div className="agent-modal-sep">
                  <span>or resume</span>
                </div>
                <div className="resume-list">
                  {resumable.map((s) => (
                    <button
                      key={s.id}
                      className="resume-item"
                      onClick={() => onResume(s)}
                      title={s.attached ? 'In use on another device — clicking will take over' : undefined}
                    >
                      <span className="resume-meta">
                        <span className="resume-agent">{AGENT_INFO[s.agent].name}</span>
                        <span className="resume-idle">{fmtIdle(s.idleMs)}</span>
                        {s.attached && <span className="resume-attached">live</span>}
                      </span>
                      <span className="resume-preview">{s.preview || '(no output yet)'}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s idle`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m idle`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h idle`;
  return `${Math.floor(h / 24)}d idle`;
}
