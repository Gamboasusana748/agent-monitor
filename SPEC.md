# Agent Monitor

A local visual observability dashboard for AI coding agents.

Agent Monitor automatically discovers active agent sessions from tools such as Codex, Claude Code, Pi, and Hermes, then visualizes the main agent and its subagents as a live graph.

The UI should feel closer to **n8n / ComfyUI** than a traditional log viewer: agents are nodes, spawn relationships are edges, and new subagents appear and animate in real time.

---

## 1. Product Goal

Agent Monitor should answer these questions at a glance:

- What agent runs are currently active?
- Which agent is the main/root agent?
- Which subagents were spawned?
- Who spawned whom?
- Which model is each agent using?
- What reasoning effort/configuration is each agent using?
- What is each agent currently doing?
- Which agents are active, idle, finished, or errored?
- How many tokens and tool calls is each agent consuming?
- How much parallel work is happening?

The basic experience:

```text
Launch Agent Monitor
        ↓
Automatically discover running agents
        ↓
Detect main/root agent
        ↓
Render main agent
        ↓
Agent spawns subagent
        ↓
New node animates into graph
        ↓
Agent Monitor updates live
```

No manual JSONL file selection should be required for normal use.

---

# 2. Initial Supported Agent Harnesses

Build the architecture for multiple providers from the start, but implement them incrementally.

Initial priority:

1. Codex
2. Claude Code
3. Pi
4. Hermes
5. Generic Session Trace / future adapters

The existing `jsonl-viewer` implementation can serve as reference code for trace detection and normalization. It already detects Codex, Claude Code, Pi, Hermes, and STS formats.

Codex should be the first complete implementation because the existing trace format already exposes explicit main/subagent relationships through `thread_source` and `parent_thread_id`.

---

# 3. Recommended Stack

## Desktop

Start with:

```text
Electron
```

Reason: the existing `jsonl-viewer` trace implementation already uses Node filesystem APIs and Electron IPC, so much of the proven discovery logic can be adapted quickly.

Tauri can remain a future option if app size or resource usage becomes important.

## Frontend

```text
React
TypeScript
Vite
@xyflow/react
Zustand
Tailwind CSS
shadcn/ui
```

Core visualization:

```text
React Flow / @xyflow/react
```

---

# 4. High-Level Architecture

```text
┌───────────────────────────────────────┐
│             Trace Sources             │
│                                       │
│ ~/.codex/sessions                     │
│ ~/.claude/projects                    │
│ ~/.pi/agent/sessions                  │
│ ~/.hermes/...                         │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│              Trace Monitor            │
│                                       │
│ scan                                  │
│ watch                                 │
│ detect new traces                     │
│ detect updates                        │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│           Provider Adapters           │
│                                       │
│ CodexAdapter                          │
│ ClaudeAdapter                         │
│ PiAdapter                             │
│ HermesAdapter                         │
└──────────────────┬────────────────────┘
                   │
              Agent Events
                   │
                   ▼
┌───────────────────────────────────────┐
│              Agent Graph              │
│                                       │
│ Runs                                  │
│ Agents                                │
│ Parent/child relationships            │
│ Status                                │
│ Activity                              │
│ Metrics                               │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│             React / Zustand           │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│            React Flow UI              │
│                                       │
│ Main agent                            │
│ Subagents                             │
│ Animated spawn edges                  │
│ Status                                │
│ Metrics                               │
└───────────────────────────────────────┘
```

---

# 5. Core Domain Model

The application should model **agents**, not files.

A JSONL file is only evidence backing an agent.

```ts
export type AgentHarness =
  | "codex"
  | "claude"
  | "pi"
  | "hermes"
  | "unknown";

export type AgentType =
  | "main"
  | "subagent"
  | "child-session"
  | "unknown";

export type AgentStatus =
  | "starting"
  | "active"
  | "idle"
  | "finished"
  | "error";

export interface AgentRun {
  id: string;

  harness: AgentHarness;

  rootAgentId?: string;

  cwd?: string;

  startedAt?: number;

  lastActivityAt?: number;
}
```

Agent:

```ts
export interface Agent {
  id: string;

  runId: string;

  parentId: string | null;

  harness: AgentHarness;

  type: AgentType;

  status: AgentStatus;

  sessionId?: string;

  threadId?: string;

  model?: string;

  provider?: string;

  reasoningEffort?: string;

  role?: string;

  nickname?: string;

  cwd?: string;

  tracePath?: string;

  createdAt?: number;

  lastActivityAt?: number;

  stats: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    errors: number;
  };
}
```

Relationship:

```ts
export interface AgentEdge {
  id: string;

  source: string;

  target: string;

  type: "spawn";

  status:
    | "starting"
    | "active"
    | "finished";
}
```

---

# 6. Event Model

Provider adapters should emit normalized events.

The React UI should never need to understand Codex JSONL versus Claude JSONL.

```ts
export type AgentEvent =
  | {
      type: "run.discovered";
      run: AgentRun;
    }
  | {
      type: "agent.discovered";
      agent: Agent;
    }
  | {
      type: "agent.spawned";
      agent: Agent;
    }
  | {
      type: "agent.updated";
      agentId: string;
      changes: Partial<Agent>;
    }
  | {
      type: "agent.activity";
      agentId: string;
      timestamp: number;
    }
  | {
      type: "agent.finished";
      agentId: string;
    }
  | {
      type: "agent.error";
      agentId: string;
      error?: string;
    };
```

Pipeline:

```text
Codex JSONL
     │
     ▼
CodexAdapter
     │
     ▼
agent.spawned
     │
     ▼
AgentGraph reducer
     │
     ▼
Zustand
     │
     ▼
React Flow
```

---

# 7. Trace Monitor

Create a dedicated process/module responsible for discovering traces.

Suggested module:

```text
src/main/trace-monitor/
```

Responsibilities:

```text
Initial scan
Directory watching
File creation detection
File modification detection
File deletion detection
Debouncing filesystem events
Provider detection
Incremental reads
```

Watch:

```text
~/.codex/sessions
~/.claude/projects
~/.pi/agent/sessions
~/.hermes/session-exports/traces
```

The existing viewer currently has strong support for live updates of a single opened file, using file watching, directory watching, and polling.

Agent Monitor should expand this concept into a persistent multi-directory monitor.

Recommended:

```text
chokidar
```

rather than manually managing large numbers of nested `fs.watch()` handles.

---

# 8. Codex Adapter

Codex should be the MVP provider.

The existing implementation already recognizes:

```text
thread_source
parent_thread_id
agent_role
agent_path
agent_nickname
```

and already builds parent/child graphs from them.

Mapping:

```text
thread_source = user
        ↓
MAIN AGENT

thread_source = subagent
        ↓
SUBAGENT
```

Relationship:

```text
subagent.parent_thread_id
        ↓
parent.thread_id
```

Example:

```text
              ┌────────────────────┐
              │ Main Agent         │
              │ GPT-6 Astra        │
              └─────────┬──────────┘
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
    ┌────────────────┐    ┌────────────────┐
    │ Explorer       │    │ Test Runner    │
    │ GPT-5.6 Luna   │    │ GPT-5.6 Luna   │
    └────────────────┘    └────────────────┘
```

Also preserve explicit identifiers:

```ts
{
  sessionId,
  threadId,
  parentThreadId
}
```

Do not collapse these into one generic ID internally.

---

# 9. Automatic Main Agent Detection

Agent Monitor must automatically identify main/root agents.

For Codex:

```text
thread_source === "user"
```

means:

```text
type = main
```

No filename or model heuristics should be needed.

The existing viewer deliberately relies on `thread_source` rather than guessing from model names or filenames. Keep the same principle.

---

# 10. Live Subagent Discovery

This is the key feature.

Example:

```text
12:00:00

┌─────────────────┐
│ Astra           │
│ MAIN            │
│ ● ACTIVE        │
└─────────────────┘
```

Codex spawns Luna.

The filesystem monitor discovers another rollout.

```text
12:00:04

           ┌─────────────────┐
           │ Astra           │
           │ MAIN            │
           └────────┬────────┘
                    │
                    ▼
           ┌─────────────────┐
           │ Explorer        │
           │ Luna            │
           │ ● STARTING      │
           └─────────────────┘
```

A few moments later:

```text
           ┌─────────────────┐
           │ Astra           │
           │ MAIN            │
           └────────┬────────┘
                    │
                    ▼
           ┌─────────────────┐
           │ Explorer        │
           │ Luna            │
           │ ● ACTIVE        │
           └─────────────────┘
```

No refresh.

No opening files.

No selecting trace directories.

---

# 11. React Flow Dashboard

The main screen should be the graph.

```text
┌──────────────────────────────────────────────────────────┐
│ Agent Monitor       Codex ▾     Current Run ▾    ● LIVE │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                  ┌───────────────────┐                   │
│                  │ MAIN              │                   │
│                  │ GPT-6 Astra       │                   │
│                  │ medium            │                   │
│                  │ ● Active          │                   │
│                  └─────────┬─────────┘                   │
│                            │                             │
│                  ┌─────────┴────────┐                    │
│                  │                  │                    │
│                  ▼                  ▼                    │
│          ┌──────────────┐   ┌──────────────┐             │
│          │ Explorer     │   │ Tester       │             │
│          │ Luna · max   │   │ Luna · max   │             │
│          │ ● Active     │   │ ◉ Idle       │             │
│          └──────────────┘   └──────────────┘             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

# 12. Agent Node Design

Main node:

```text
┌───────────────────────────────────┐
│ CODEX                         ●   │
│                                   │
│ Main Agent                        │
│ GPT-6 Astra · medium              │
│                                   │
│ Working on Agent Monitor          │
│                                   │
│ 124k in   18k out   32 tools      │
└───────────────────────────────────┘
```

Subagent:

```text
┌─────────────────────────────┐
│ EXPLORER                ●   │
│                             │
│ GPT-5.6 Luna · max          │
│                             │
│ Searching repository        │
│                             │
│ 14k in · 2k out · 6 tools   │
└─────────────────────────────┘
```

Possible indicators:

```text
● Active
◉ Idle
✓ Finished
! Error
```

---

# 13. Spawn Animation

When a subagent appears:

1. Parent node pulses.
2. Spawn edge grows outward.
3. Child node fades/scales into view.
4. A particle travels from parent → child.
5. Active edges retain subtle animation.
6. Finished edges become static.

Conceptually:

```tsx
<BaseEdge path={path} />

{active && (
  <circle r={4}>
    <animateMotion
      path={path}
      dur="1.2s"
      repeatCount="indefinite"
    />
  </circle>
)}
```

Avoid relaying out the entire graph whenever a node arrives.

Existing node positions should remain stable whenever possible.

---

# 14. Layout

Start with hierarchical top-down layout.

```text
MAIN
 │
 ├── SUBAGENT
 │      │
 │      └── SUBAGENT
 │
 └── SUBAGENT
```

Recommended initial layout engine:

```text
Dagre
```

Later consider:

```text
ELK
```

for larger agent trees.

Controls:

```text
Fit View
Auto Layout
Center Root
Center Active
Zoom
```

---

# 15. Agent Status

Do not infer `"finished"` simply because a file stopped changing.

Use evidence-based status.

```text
STARTING
    ↓
ACTIVE
    ↓
IDLE
    ↓
FINISHED
```

Rules:

### Starting

Agent discovered but little/no output exists yet.

### Active

Recent trace activity.

### Idle

No activity within a configurable threshold.

### Finished

Provider explicitly reports completion.

### Error

Provider explicitly reports an error.

The current viewer already distinguishes recently written trace files as LIVE, so similar timestamp logic can be reused.

---

# 16. Agent Details Panel

Clicking an agent should open a side panel.

```text
┌────────────────────────────────┐
│ Explorer                       │
│                                │
│ Harness       Codex            │
│ Model         GPT-5.6 Luna     │
│ Effort        max              │
│ Role          explorer         │
│ Status        Active           │
│                                │
│ Input         18,421           │
│ Output        2,194            │
│ Tool calls    12               │
│ Errors        0                │
│ Duration      02:41            │
│                                │
│ Current activity               │
│ Searching repository...        │
│                                │
│ [Open Trace]                   │
└────────────────────────────────┘
```

---

# 17. Trace Detail View

Agent Monitor should still allow inspecting the underlying trace.

Do not make the graph replace trace inspection.

Flow:

```text
Agent graph
   ↓ click agent
Agent details
   ↓
Open trace
   ↓
Messages / thinking / tool calls
```

This is where the useful normalization logic from `jsonl-viewer` can be adapted.

The existing parser already normalizes user messages, assistant messages, thinking blocks, tool calls/results, timestamps, token usage, and errors across several harnesses.

---

# 18. Run Discovery

Agent Monitor should distinguish individual runs/projects.

Example:

```text
Recent Runs

● Codex       Agent Monitor          4 agents
● Claude Code AntibesCode            3 agents
○ Codex       AIBackends             7 agents
○ Pi          Coworker               1 agent
```

Selecting a run changes the React Flow graph.

Default:

```text
Most recently active run
```

Do not combine unrelated sessions into one giant graph.

---

# 19. Claude Code Adapter

Implement after Codex.

Responsibilities:

```text
Detect Claude session
Determine root session
Detect subagent sessions when possible
Normalize model/status/activity
Emit Agent events
```

Avoid guessing agent relationships from ordinary message `parentUuid` relationships.

Message lineage and agent lineage are different concepts.

If explicit subagent lifecycle information is available, prefer it.

---

# 20. Pi Adapter

Pi also needs careful semantics.

The existing Pi traces contain `parentId` links for conversation branching.

Do not automatically interpret:

```text
message.parentId
```

as:

```text
agent.parentId
```

Instead distinguish:

```text
conversation branch
```

from:

```text
subagent
```

If Pi creates related child sessions:

```text
MAIN
  │
  └── CHILD SESSION
```

represent them initially as:

```text
type = child-session
```

until explicit agent spawn evidence exists.

---

# 21. Hermes Adapter

Follow the same provider interface.

```ts
interface AgentProviderAdapter {
  detect(input: TraceInput): boolean;

  inspect(input: TraceInput): AgentObservation | null;

  processUpdate(
    previous: AgentObservation | null,
    input: TraceInput
  ): AgentEvent[];
}
```

Every new provider should plug into Agent Monitor without affecting React Flow.

---

# 22. Suggested Repository Structure

```text
agent-monitor/
│
├── src/
│   │
│   ├── main/
│   │   ├── index.ts
│   │   │
│   │   ├── trace-monitor/
│   │   │   ├── TraceMonitor.ts
│   │   │   ├── TraceScanner.ts
│   │   │   └── TraceWatcher.ts
│   │   │
│   │   └── ipc/
│   │       └── agent-events.ts
│   │
│   ├── traces/
│   │   ├── types.ts
│   │   ├── parser.ts
│   │   │
│   │   └── providers/
│   │       ├── codex.ts
│   │       ├── claude.ts
│   │       ├── pi.ts
│   │       └── hermes.ts
│   │
│   ├── graph/
│   │   ├── types.ts
│   │   ├── reducer.ts
│   │   └── selectors.ts
│   │
│   ├── renderer/
│   │   ├── App.tsx
│   │   │
│   │   ├── dashboard/
│   │   │   ├── AgentDashboard.tsx
│   │   │   ├── AgentCanvas.tsx
│   │   │   │
│   │   │   ├── nodes/
│   │   │   │   ├── AgentNode.tsx
│   │   │   │   └── MainAgentNode.tsx
│   │   │   │
│   │   │   ├── edges/
│   │   │   │   └── SpawnEdge.tsx
│   │   │   │
│   │   │   └── layout/
│   │   │       └── dagre.ts
│   │   │
│   │   ├── details/
│   │   │   └── AgentDetails.tsx
│   │   │
│   │   ├── traces/
│   │   │   └── TraceViewer.tsx
│   │   │
│   │   └── store/
│   │       └── agentStore.ts
│   │
│   └── shared/
│       └── ipc.ts
│
├── tests/
│   ├── codex/
│   ├── claude/
│   ├── pi/
│   └── graph/
│
├── package.json
└── README.md
```

---

# 23. Implementation Phases

## Phase 1 — Project Foundation

Goal: establish the application architecture.

Implement:

- Electron + React + TypeScript + Vite
- React Flow
- Zustand
- Tailwind
- Basic app shell
- IPC
- Agent/Run domain types
- Agent graph reducer

Deliverable:

```text
Agent Monitor launches
        ↓
Mock graph renders
        ↓
Nodes + edges work
```

---

## Phase 2 — Codex Discovery

Goal: automatically discover Codex sessions.

Implement:

- Scan `~/.codex/sessions`
- Detect Codex JSONL
- Parse session metadata
- Detect root/main agent
- Detect subagents
- Resolve `parent_thread_id`
- Build AgentRun
- Build Agent graph

Deliverable:

```text
Launch Agent Monitor
        ↓
Current Codex main agent appears automatically
```

---

## Phase 3 — Live Codex Monitoring

Goal: visualize subagents as they spawn.

Implement:

- Watch Codex session directories
- Detect new rollout files
- Incrementally inspect new traces
- Emit `agent.spawned`
- Add React Flow node dynamically
- Add parent-child edge
- Update status/activity

Deliverable:

```text
Codex calls spawn_agent
        ↓
New Luna node appears automatically
```

This is the first major product milestone.

---

## Phase 4 — Animation & UX

Implement:

- Spawn particle
- Animated edge
- Node fade/scale
- Parent pulse
- Active indicators
- Stable graph positioning
- Auto-fit when appropriate
- Minimap
- Run selector
- Agent details drawer

Deliverable:

A ComfyUI/n8n-like live agent experience.

---

## Phase 5 — Trace Details

Implement:

- Agent trace timeline
- User messages
- Assistant messages
- Thinking/reasoning
- Tool calls
- Tool results
- Token usage
- Errors

Reuse/adapt normalization concepts from `jsonl-viewer`.

---

## Phase 6 — Claude Code

Implement:

- Claude session detection
- Active run discovery
- Main agent identification
- Subagent relationship detection
- Status/activity
- Metrics

No UI redesign should be necessary.

---

## Phase 7 — Pi + Hermes

Implement:

```text
PiAdapter
HermesAdapter
```

Keep provider-specific behavior inside adapters.

---

# 24. MVP Definition

The first public MVP should focus on one experience:

> Launch Agent Monitor while Codex is working and visually watch its agent tree evolve.

Required MVP behavior:

```text
✓ Automatically discover Codex

✓ Automatically identify main agent

✓ Render main agent in React Flow

✓ Detect new subagent

✓ Resolve its parent

✓ Animate the new node

✓ Animate spawn edge

✓ Detect nested subagents

✓ Show model

✓ Show reasoning effort

✓ Show role/nickname

✓ Show ACTIVE / IDLE

✓ Click node for details

✓ Open normalized trace
```

Not required for the first MVP:

```text
Claude Code
Pi
Hermes
Costs
Git diff visualization
Tool graph
Historical replay
Remote agents
Team collaboration
Cloud sync
```

---

# 25. MVP Acceptance Scenario

This should become the primary end-to-end test.

```text
1. Start Agent Monitor.

2. Start Codex.

3. Give Codex a task.

4. Agent Monitor automatically detects the session.

5. GPT-6 Astra appears as MAIN.

6. Astra spawns a GPT-5.6 Luna explorer.

7. A new Luna node animates onto the canvas.

8. Astra spawns a second Luna test agent.

9. The second Luna node appears beside the first.

10. Luna #2 spawns another agent.

11. The new agent appears beneath Luna #2.

12. Agent activity updates live.

13. Luna #1 finishes.

14. Its status changes to FINISHED.

15. Click Luna #1.

16. Its full trace is shown.
```

At no point should the user need to manually open a JSONL file.

---

# 26. Future Features

Once the agent graph is solid, Agent Monitor can become a much broader coding-agent observability tool.

Potential future views:

### Tool activity

```text
Agent
 ├── shell
 ├── search
 ├── browser
 └── git
```

### Files touched

```text
Explorer
   │
   ├── src/parser.ts
   ├── src/App.tsx
   └── package.json
```

### Token flow

```text
MAIN
  120k
   │
   ├── Explorer 18k
   ├── Tester   24k
   └── Reviewer 11k
```

### Cost

```text
Run Cost    $2.74

Astra       $2.10
Luna #1     $0.21
Luna #2     $0.28
Luna #3     $0.15
```

### Timeline replay

```text
00:00 Main starts
00:18 Explorer spawned
00:24 Tester spawned
01:42 Explorer finished
02:11 Reviewer spawned
03:04 Main finished
```

### Parallelism

Show how many agents are simultaneously working.

### Bottleneck analysis

Identify agents blocking their parent.

### Git integration

Show which agent modified which files.

---

# 27. Product Direction

Agent Monitor should eventually sit between a trace viewer and an observability platform:

```text
JSONL viewer
      ↓
Agent trace viewer
      ↓
Agent topology viewer
      ↓
Live multi-agent debugger
      ↓
Coding-agent observability
```

The strongest initial positioning is simple:

> **Agent Monitor lets you see your coding agents work.**

And the first version should obsess over one moment:

```text
Main agent
     │
     │ spawning...
     ▼
New subagent appears live
```

If that interaction feels great, the foundation of Agent Monitor is right.
