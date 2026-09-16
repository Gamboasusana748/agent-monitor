# Discovery and privacy

Startup reads bounded session headers to list runs; it does not parse every trace body. Select a run to load its main agent and subagents. Switching runs releases the previous run’s parsed content.

Default sources:

| Provider | Local source |
| --- | --- |
| Codex | `$CODEX_HOME/sessions` or `~/.codex/sessions` |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` |
| Pi | `$PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions` |
| Hermes | `$HERMES_HOME/state.db`, `session-exports/traces`, and `sessions`, defaulting to `~/.hermes` |

Hermes database discovery reads session metadata only; message bodies are queried only for the selected run. The database is opened read-only. Native Hermes sessions take precedence when an export has the same session ID. Claude nested subagent files and explicitly marked Hermes subagents produce spawn edges. Pi message-tree links and Hermes compression continuations are not treated as spawned agents.

No manual file selection is needed. No traces are uploaded and no trace content is executed. The renderer has no Node access; a narrow, isolated IPC bridge exposes snapshots and normalized trace entries for discovered agents.

To use a fixture directory or another JSONL trace location (this override disables the default sources, including the Hermes database):

```sh
AGENT_MONITOR_TRACE_ROOT=/absolute/path/to/sessions npm run dev
```

Set `AGENT_MONITOR_IDLE_MS` to a positive number of milliseconds to adjust the inactivity threshold. Inactivity means idle, never finished. Completion and error states require explicit provider events. A resumed turn can return an agent to active.

Trace files, session exports, local databases, credentials, local agent configuration, build output, and test artifacts are excluded by `.gitignore`. Tests generate synthetic sessions in temporary directories; the repository does not include machine traces.
