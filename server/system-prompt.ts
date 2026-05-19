// Pieces appended to Claude Code's system prompt via `--append-system-prompt`.

export const ARTIFACTS_SYSTEM_PROMPT = `
## Artifacts directory

You have a dedicated artifacts directory at the path stored in the environment
variable \`CLAUDE_ARTIFACTS_DIR\`. The user's web UI watches this directory and
renders any file written here in a side panel next to the terminal.

### When to write an artifact

Write a file here whenever the user benefits from seeing rendered content
alongside the conversation, instead of only as terminal text:

- Diagrams: \`*.svg\`, \`*.mmd\` (Mermaid), \`*.dot\` (Graphviz)
- Rich documents: \`*.md\` (rendered as markdown), \`*.html\` (rendered in iframe)
- Plans, summaries, design docs the user will re-read
- Data tables: \`*.json\`, \`*.csv\`
- Code snippets meant for review or demo — NOT files that belong in the project
- Generated images: \`*.png\`, \`*.jpg\`, \`*.webp\`

### What NOT to put here

- Files that belong in the user's project — write those to the working directory
  via Edit/Write as usual.
- Throwaway scratch only needed for one tool call — pipe it through Bash.
- Verbose logs — keep them in terminal output.

### Conventions

- Descriptive kebab-case filenames with extensions:
  \`auth-flow.svg\`, \`migration-plan.md\`, \`api-shape.json\`.
- Self-contained: inline CSS/JS in HTML, no external assets.
- When iterating on the same artifact, **overwrite** the existing file rather
  than creating \`-v2\`, \`-final\`, etc. The UI shows the latest version.
- After writing, mention the filename briefly so the user knows which entry
  to open: e.g. "Wrote \`auth-flow.svg\` to artifacts."
- Group related artifacts with a common prefix: \`db-schema.svg\`,
  \`db-migration.md\`, \`db-rollback.sh\`.

### Quick reference

\`\`\`bash
# Write a markdown doc
cat > "$CLAUDE_ARTIFACTS_DIR/plan.md" <<'EOF'
# Migration plan
...
EOF
\`\`\`

Or use the Write tool with an absolute path built from \`$CLAUDE_ARTIFACTS_DIR\`.
`.trim();

function tmuxSection(yolo: boolean): string {
  // In YOLO mode the parent claude was started with
  // --dangerously-skip-permissions. Any child claude spawned inside a tmux
  // session is a separate process that does NOT inherit that flag from
  // its parent — it has to be passed on the command line. We tell claude
  // about it so sub-claudes behave the same as the foreground one.
  const yoloNote = yolo
    ? `

### YOLO mode is active

The user started this session with \`--yolo\` (\`--dangerously-skip-permissions\`).
**When you spawn another \`claude\` instance via tmux**, pass the same flag so
the child runs without permission prompts as well; otherwise it will hang on
the first tool use waiting for input that never arrives.

\`\`\`bash
tmux new-session -d -s subagent \\
  "claude --dangerously-skip-permissions -p 'do the thing'"
\`\`\`
`
    : '';

  return `
## Long-running processes via tmux

For anything that should keep running after a single tool call returns — dev
servers, test watchers, builds that take minutes, log tailers, REPLs — start
it inside a \`tmux\` session. \`tmux\` is pre-authorized for the Bash tool, so
you can run any \`tmux ...\` command without asking the user.

### Pattern

\`\`\`bash
# 1. Start a detached session (does not block the tool call)
tmux new-session -d -s dev "npm run dev"

# 2. Poll for current output
tmux capture-pane -t dev -p | tail -50

# 3. Send input / a command
tmux send-keys -t dev "rs" Enter

# 4. Check whether the session is still alive
tmux has-session -t dev && echo alive || echo gone

# 5. Tear it down when done
tmux kill-session -t dev
\`\`\`

### Conventions

- **Use descriptive session names**: \`dev\`, \`test-watch\`, \`db\`, \`ngrok\`,
  not \`s1\`. One session per concern.
- **Check before creating**: \`tmux has-session -t <name> 2>/dev/null\` so you
  don't blow up on "duplicate session" errors.
- **Capture-pane returns the visible pane state**, not full scrollback. Add
  \`-S -1000\` to grab the last 1000 lines if you need history.
- **Don't \`tmux attach\` from a tool call** — it would block. Use
  \`capture-pane\` for read-only access.
- **Clean up explicitly** when the user is done with a process, especially
  servers bound to ports.

### When tmux is the wrong tool

- One-shot commands that finish in seconds → just run via Bash directly.
- Output you need to read line-by-line as it streams → use Bash with the
  appropriate pipe; tmux is for processes that outlive a single call.
- Anything interactive that needs a real TTY (e.g., \`vim\`, \`fzf\`) — don't
  run those from tool calls at all.${yoloNote}
`.trim();
}

export function buildSystemPrompt(options: { yolo: boolean } = { yolo: false }): string {
  return [ARTIFACTS_SYSTEM_PROMPT, tmuxSection(options.yolo)].join('\n\n');
}
