// Shown over a fresh tab until the user decides what to spawn. Two
// halves:
//   - Resume: existing live sessions on the server. Surfaced first
//     because the "I just opened the URL on a new device, give me my
//     session back" path is the main reason a returning user lands
//     here. Sessions already attached to another viewer get a clear
//     "in use on another device — clicking will take over" hint,
//     because clicking IS a kick (last-attach-wins by design).
//   - Start fresh: spawn a brand-new claude/codex session.
//
// While the resumable list is still being fetched (resumable === null),
// we show a placeholder where the resume cards will go, so the user
// doesn't reflexively pick "Start fresh" only to realise a session
// they wanted was about to load.

import type { AgentKind, SessionSummary } from '../types.ts';

interface Props {
  agents: AgentKind[];
  /** null = still loading; [] = nothing to resume; non-empty = list */
  resumable: SessionSummary[] | null;
  onPick: (agent: AgentKind) => void;
  onResume: (s: SessionSummary) => void;
}

const AGENT_INFO: Record<AgentKind, { name: string; desc: string }> = {
  claude: { name: 'Claude Code', desc: 'Anthropic · artifacts panel enabled' },
  codex: { name: 'Codex', desc: 'OpenAI Codex CLI' },
};

export function AgentModal({ agents, resumable, onPick, onResume }: Props) {
  const hasAgents = agents.length > 0;
  const loadingResumable = resumable === null;
  const hasResumable = !loadingResumable && resumable.length > 0;

  if (!hasAgents && !hasResumable && !loadingResumable) {
    return (
      <div className="agent-modal-backdrop">
        <div className="agent-modal">
          <h2 className="agent-modal-title">No agent found</h2>
          <p className="agent-modal-note">
            Neither <code>claude</code> nor <code>codex</code> was found on
            PATH. Install one and reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-modal-backdrop">
      <div className="agent-modal">
        {/* Resume block goes first when there's anything to show or
            still-loading, so the user notices it before scanning for
            fresh-start buttons. */}
        {(hasResumable || loadingResumable) && (
          <>
            <h2 className="agent-modal-title">Continue a session</h2>
            <div className="resume-list">
              {loadingResumable ? (
                <div className="resume-loading">Checking for live sessions…</div>
              ) : (
                resumable.map((s) => (
                  <button
                    key={s.id}
                    className={
                      'resume-item' + (s.attached ? ' resume-item-attached' : '')
                    }
                    onClick={() => onResume(s)}
                  >
                    <span className="resume-meta">
                      <span className="resume-agent">{AGENT_INFO[s.agent].name}</span>
                      <span className="resume-idle">{fmtIdle(s.idleMs)}</span>
                      {s.attached && (
                        <span className="resume-attached">in use elsewhere</span>
                      )}
                    </span>
                    <span className="resume-preview">
                      {s.preview || '(no output yet)'}
                    </span>
                    {s.attached && (
                      <span className="resume-takeover">
                        Click to take over from the other device
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {hasAgents && (
          <>
            {(hasResumable || loadingResumable) && (
              <div className="agent-modal-sep">
                <span>or start fresh</span>
              </div>
            )}
            {!(hasResumable || loadingResumable) && (
              <h2 className="agent-modal-title">Start a session</h2>
            )}
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

function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s idle`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m idle`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h idle`;
  return `${Math.floor(h / 24)}d idle`;
}
