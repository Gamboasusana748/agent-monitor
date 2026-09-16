# Agent Monitor

See your Codex, Claude Code, Pi, and Hermes agents work: a local Electron dashboard that discovers sessions automatically and shows their parent/child relationships as a live graph.

## Run

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

`npm run dev:web` opens a browser-only preview. Filesystem discovery runs inside Electron; the browser preview provides an explicitly labeled demo.

## Included in this implementation

- Lightweight multi-provider run discovery, with on-demand loading and incremental monitoring of the selected run.
- Explicit main/subagent metadata, nested parent relationships, separate runs, and explicit run selection.
- React Flow graph with model, reasoning effort, role, activity, token and tool metrics.
- Spawn animation, status indicators, minimap, zoom, and graph layout controls.
- Agent details and normalized trace inspection.
- Provider adapters for Codex, Claude Code, Pi, and Hermes JSONL, plus a read-only native Hermes database source.

This implements local provider support from [SPEC.md](SPEC.md). Generic traces, cloud services, and full historical replay remain later phases. Missing metadata is shown as unknown rather than guessed.

## Appearance

Use the **Theme** selector in the top bar to choose **Green** (default), **Charcoal**, or **Light**. The choice is saved locally and restored on the next launch. Sidebar rows and section titles use text without decorative icons. Theme, provider, and run pickers use custom keyboard-accessible menus.

Use **Expand trace** or **Open trace in tab** in the details panel to read entries across the full window. Trace tabs use conversation cards with collapsible thinking and tool groups. Tool inputs and results are paired by their call IDs, including interleaved results; unmatched outputs remain visible. Search and event-kind filters keep matching conversation context together. Consecutive cumulative thinking summaries collapse into one block with an update count. Refresh reloads the recent entries, and the Graph tab returns to the canvas.

## Token usage and cost estimates

The sidebar shows combined input/output totals for loaded runs. Click the graph's token totals to open a per-agent breakdown, aggregated IN/OUT totals, a tokens-per-minute chart, and cumulative usage. Live counters use rolling digits and respect reduced-motion settings.

USD values use verified per-model API rates, including available cache and context-tier metadata. They are API-equivalent estimates, not subscription bills. Unknown models or incomplete usage remain unpriced and are disclosed in the breakdown. See [pricing sources and assumptions](docs/token-pricing.md).

## Discovery and privacy

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

## Development

```sh
npm test
npm run typecheck
npm run build
```

- `src/main/`: Electron lifecycle, IPC bridge, filesystem monitor.
- `src/traces/`: provider adapters and normalization.
- `src/graph/`: agent relationship and run derivation.
- `src/shared/`: provider-independent contracts.
- `src/renderer/`: React Flow dashboard, details, trace viewer, Zustand state.

Renderer edits reload during `npm run dev`. Restart that command after changing main-process or preload code. Build outputs are `dist/` and `dist-electron/`; this repository does not yet produce signed installers.

Trace detection and normalization follow the concepts in the neighboring `jsonl-viewer` project. The Electron bridge follows the [context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

## Memory bounds

Only the selected run has parsed trace bodies in memory. Its live detail view retains the latest 200 normalized entries per agent, with individual displayed entries capped at 64 KiB. JSONL metrics are folded across the entire selected file even when older display entries are discarded. Hermes database metrics come from its stored session counters; its reader queries only the latest 200 message rows per selected agent. Original trace files remain unchanged. Oversized malformed lines are skipped so a partial write cannot grow an unbounded buffer.

`npm run test:smoke` builds the application and runs the Electron acceptance scenario with temporary synthetic sessions. It requires a desktop session and verifies explicit run selection, live nodes and edges, details, completion, and switching runs.
