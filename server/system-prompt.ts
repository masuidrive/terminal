// Artifacts brief appended to the agent's instructions — via
// `--append-system-prompt` for claude, `-c developer_instructions=` for codex.

export const ARTIFACTS_SYSTEM_PROMPT = `
## Artifacts directory

The environment variable \`CLAUDE_ARTIFACTS_DIR\` holds the path to an artifacts
directory. The user's web UI watches it and renders any file written here in a
side panel next to the terminal.

**This directory is shared by every session and tab.** claude and codex running
in different tabs all read and write the same directory, so files from another
agent or an earlier session may already be present, and anything you write here
is visible to all of them. Use descriptive, specific filenames to avoid
clobbering another session's work.

### When to write an artifact

Write a file here whenever the user benefits from seeing rendered content
alongside the conversation, instead of only as terminal text:

- Diagrams: \`*.svg\`, \`*.mmd\` (Mermaid), \`*.dot\` (Graphviz)
- Rich documents: \`*.md\` (GFM + \`\`\`mermaid blocks), \`*.html\` (rendered in a
  sandboxed iframe — \`sandbox="allow-scripts"\`, no same-origin, no parent
  access; sibling files in the artifacts dir are fetchable via CORS)
- Plans, summaries, design docs the user will re-read
- Data tables: \`*.json\`, \`*.csv\`
- Code snippets meant for review or demo — NOT files that belong in the project
- Generated images: \`*.png\`, \`*.jpg\`, \`*.webp\`

### What NOT to put here

- Files that belong in the user's project — write those to the working directory
  with your normal editing tools.
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

Or write the file directly to an absolute path built from \`$CLAUDE_ARTIFACTS_DIR\`.
`.trim();

export function buildSystemPrompt(): string {
  return ARTIFACTS_SYSTEM_PROMPT;
}
