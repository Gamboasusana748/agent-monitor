import type { Agent, AgentEdge, AgentEvent, AgentRun, AgentStatus } from '../shared/types';

export interface AgentGraphState {
  agents: Agent[];
  runs: AgentRun[];
  edges: AgentEdge[];
}

export function createGraphState(initial: Partial<AgentGraphState> = {}): AgentGraphState {
  return {
    agents: (initial.agents ?? []).map(cloneAgent),
    runs: (initial.runs ?? []).map((run) => ({ ...run })),
    edges: (initial.edges ?? []).map((edge) => ({ ...edge })),
  };
}

function cloneAgent(agent: Agent): Agent {
  return { ...agent, stats: { ...agent.stats } };
}

function mergeAgent(previous: Agent | undefined, next: Agent): Agent {
  if (!previous) return cloneAgent(next);
  return {
    ...previous,
    ...next,
    // A partial observation should not erase metadata discovered in the first
    // session_meta line. Stats are replaced by the adapter's current totals.
    stats: { ...previous.stats, ...next.stats },
  };
}

function mergeChanges(previous: Agent, changes: Partial<Agent>): Agent {
  return {
    ...previous,
    ...changes,
    stats: { ...previous.stats, ...(changes.stats ?? {}) },
  };
}

function hasAncestor(agentId: string, parentId: string, byId: Map<string, Agent>): boolean {
  const seen = new Set<string>();
  let current = byId.get(parentId);
  while (current) {
    if (current.id === agentId) return true;
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    const nextId = current.parentId;
    current = nextId ? byId.get(nextId) : undefined;
  }
  return false;
}

function buildThreadIndex(agents: Agent[]): Map<string, Agent> {
  const byThread = new Map<string, Agent>();
  for (const agent of agents) {
    if (!agent.threadId) continue;
    const key = `${agent.harness}:${agent.threadId}`;
    if (byThread.has(key)) continue;
    byThread.set(key, agent);
  }
  return byThread;
}

function rootsFor(agents: Agent[], byId: Map<string, Agent>): Map<string, Agent> {
  const memo = new Map<string, Agent>();
  const resolving = new Set<string>();
  const resolve = (agent: Agent): Agent => {
    const cached = memo.get(agent.id);
    if (cached) return cached;
    if (resolving.has(agent.id)) {
      memo.set(agent.id, agent);
      return agent;
    }
    resolving.add(agent.id);
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    const root = parent ? resolve(parent) : agent;
    resolving.delete(agent.id);
    memo.set(agent.id, root);
    return root;
  };
  for (const agent of agents) resolve(agent);
  return memo;
}

function rebuildGraph(state: AgentGraphState, suppliedRuns: AgentRun[] = []): AgentGraphState {
  const agents = state.agents.map(cloneAgent);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const byThread = buildThreadIndex(agents);

  // Resolve explicit parent_thread_id references on every pass. This is what
  // makes a child discovered before its parent move into place later.
  for (const agent of agents) {
    if (!agent.parentThreadId) {
      // Keep a direct parent supplied by a generic caller. Codex observations
      // normally use parentThreadId, while graph consumers may already have a
      // resolved parent id.
      if (!agent.parentId || !byId.has(agent.parentId) || agent.parentId === agent.id || hasAncestor(agent.id, agent.parentId, byId)) {
        agent.parentId = null;
      }
      continue;
    }
    const parent = byThread.get(`${agent.harness}:${agent.parentThreadId}`);
    if (!parent || parent.id === agent.id || hasAncestor(agent.id, parent.id, byId)) {
      agent.parentId = null;
    } else {
      agent.parentId = parent.id;
    }
  }

  const roots = rootsFor(agents, byId);
  const membersByRun = new Map<string, Agent[]>();
  for (const agent of agents) {
    const root = roots.get(agent.id) ?? agent;
    const members = membersByRun.get(root.id) ?? [];
    members.push(agent);
    membersByRun.set(root.id, members);
  }

  const runsById = new Map<string, AgentRun>();
  for (const run of [...state.runs, ...suppliedRuns]) runsById.set(run.id, { ...run });

  for (const agent of agents) {
    const root = roots.get(agent.id) ?? agent;
    const runId = root.id;
    agent.runId = runId;
    const existing = runsById.get(runId);
    const members = membersByRun.get(runId) ?? [agent];
    const startedAt = minDefined(existing?.startedAt, ...members.map((item) => item.createdAt));
    const lastActivityAt = maxDefined(existing?.lastActivityAt, ...members.map((item) => item.lastActivityAt));
    runsById.set(runId, {
      id: runId,
      harness: root.harness,
      rootAgentId: root.id,
      ...(root.nickname ? { title: root.nickname } : {}),
      ...(root.cwd ? { cwd: root.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    });
  }

  const edges: AgentEdge[] = [];
  for (const agent of agents) {
    if (!agent.parentId || !byId.has(agent.parentId)) continue;
    edges.push({
      id: `spawn:${agent.parentId}->${agent.id}`,
      source: agent.parentId,
      target: agent.id,
      type: 'spawn',
      status: edgeStatus(agent.status),
    });
  }

  // Stable ordering helps React and makes snapshots deterministic even when
  // filesystem events arrive in different orders.
  agents.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  const runs = Array.from(runsById.values()).filter((run) => agents.some((agent) => agent.runId === run.id));
  runs.sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0) || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { agents, runs, edges };
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.min(...present) : undefined;
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

function edgeStatus(status: AgentStatus): AgentEdge['status'] {
  if (status === 'finished' || status === 'error') return 'finished';
  if (status === 'starting') return 'starting';
  return 'active';
}

export function reduceAgentEvent(current: AgentGraphState, event: AgentEvent): AgentGraphState {
  const state = createGraphState(current);
  if (event.type === 'run.discovered') {
    const index = state.runs.findIndex((run) => run.id === event.run.id);
    if (index === -1) state.runs.push({ ...event.run });
    else state.runs[index] = { ...state.runs[index], ...event.run };
    return rebuildGraph(state);
  }

  if (event.type === 'agent.discovered' || event.type === 'agent.spawned') {
    const index = state.agents.findIndex((agent) => agent.id === event.agent.id);
    if (index === -1) state.agents.push(cloneAgent(event.agent));
    else state.agents[index] = mergeAgent(state.agents[index], event.agent);
    return rebuildGraph(state);
  }

  const agent = state.agents.find((item) => item.id === event.agentId);
  if (!agent) return rebuildGraph(state);
  if (event.type === 'agent.updated') {
    const index = state.agents.findIndex((item) => item.id === event.agentId);
    state.agents[index] = mergeChanges(agent, event.changes);
  } else if (event.type === 'agent.activity') {
    if (agent.status !== 'finished' && agent.status !== 'error') agent.status = 'active';
    agent.lastActivityAt = event.timestamp;
  } else if (event.type === 'agent.finished') {
    agent.status = 'finished';
  } else if (event.type === 'agent.error') {
    agent.status = 'error';
    if (event.error) agent.activity = event.error;
    agent.stats.errors += 1;
  }
  return rebuildGraph(state);
}

export function reduceAgentEvents(current: AgentGraphState, events: AgentEvent[]): AgentGraphState {
  return events.reduce(reduceAgentEvent, current);
}

export function replaceAgents(current: AgentGraphState, agents: Agent[], runs: AgentRun[] = []): AgentGraphState {
  return rebuildGraph({ agents: agents.map(cloneAgent), runs: runs.map((run) => ({ ...run })), edges: [] });
}

export function cloneGraphState(state: AgentGraphState): AgentGraphState {
  return {
    agents: state.agents.map(cloneAgent),
    runs: state.runs.map((run) => ({ ...run })),
    edges: state.edges.map((edge) => ({ ...edge })),
  };
}

export default reduceAgentEvent;
