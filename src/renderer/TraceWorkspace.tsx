import { useEffect, useId, useMemo, useState } from 'react';
import type { Agent, TraceEntry } from '../shared/types';
import { Dropdown } from './Dropdown';
import {
  filterConversationGroups,
  getToolInput,
  groupTraceEntries,
  type ConversationBlock,
  type ConversationGroup,
  type ConversationTool,
  type TraceEntryDetails,
} from './traceConversation';
import './TraceWorkspace.css';

const MAX_RECENT_ENTRIES = 200;

const TRACE_KIND_LABEL: Record<TraceEntry['kind'], string> = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  usage: 'Usage',
  error: 'Error',
  event: 'Event',
};

const STATUS_LABEL: Record<Agent['status'], string> = {
  starting: 'Starting',
  active: 'Active',
  idle: 'Idle',
  finished: 'Finished',
  error: 'Error',
};

const STATUS_COLOR: Record<Agent['status'], string> = {
  starting: 'var(--status-starting)',
  active: 'var(--status-active)',
  idle: 'var(--status-idle)',
  finished: 'var(--status-finished)',
  error: 'var(--status-error)',
};

const TRACE_KINDS = Object.keys(TRACE_KIND_LABEL) as TraceEntry['kind'][];

function titleFor(agent: Agent) {
  return agent.nickname || agent.role || (agent.type === 'main' ? 'Main agent' : 'Subagent');
}

function timeFor(timestamp: number | undefined) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function demoTrace(agent: Agent): TraceEntryDetails[] {
  const base = agent.createdAt ?? Date.now() - 60_000;
  return [
    {
      id: `${agent.id}-demo-discovered`,
      timestamp: base,
      kind: 'event',
      text: `${titleFor(agent)} session discovered by the monitor.`,
    },
    {
      id: `${agent.id}-demo-activity`,
      timestamp: agent.lastActivityAt ?? base + 1_000,
      kind: 'assistant',
      text: agent.activity || 'Working through the current task.',
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      turnId: `${agent.id}-demo-turn`,
    },
    {
      id: `${agent.id}-demo-tool`,
      timestamp: base + 2_000,
      kind: 'tool-call',
      text: 'search: rg --files src tests',
      callId: `${agent.id}-demo-call`,
      toolName: 'search',
    },
    {
      id: `${agent.id}-demo-result`,
      timestamp: base + 3_000,
      kind: 'tool-result',
      text: 'Found renderer entry points and shared agent types.',
      callId: `${agent.id}-demo-call`,
    },
  ];
}

function prettyTraceText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return { text, pretty: false };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return { text, pretty: false };
    return { text: JSON.stringify(parsed, null, 2), pretty: true };
  } catch {
    return { text, pretty: false };
  }
}

function preview(text: string, length = 180) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function groupLabel(kind: ConversationGroup['kind']) {
  if (kind === 'assistant') return 'Assistant';
  if (kind === 'user') return 'User';
  if (kind === 'tool') return 'Tool result';
  if (kind === 'usage') return 'Usage';
  if (kind === 'error') return 'Error';
  return 'Event';
}

function blockEntry(block: ConversationBlock) {
  return 'entry' in block ? block.entry : undefined;
}

function blockClass(block: ConversationBlock) {
  if (block.type === 'tools') return 'tools';
  return block.type;
}

function toolStatus(tool: ConversationTool) {
  if (!tool.result) return 'No result';
  return tool.result.kind === 'error' ? 'Error' : 'Complete';
}

export interface TraceWorkspaceProps {
  agent: Agent;
  demo?: boolean;
}

export function TraceWorkspace({ agent, demo = false }: TraceWorkspaceProps) {
  const searchId = useId();
  const [entries, setEntries] = useState<TraceEntryDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [openDisclosure, setOpenDisclosure] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setEntries([]);
    setOpenDisclosure(new Set());

    if (demo) {
      setEntries(demoTrace(agent));
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const bridge = typeof window === 'undefined' ? undefined : window.agentMonitor;
    if (!bridge) {
      setLoading(false);
      setError('The native monitor is unavailable in this browser session.');
      return () => {
        cancelled = true;
      };
    }

    void bridge.getTrace(agent.id)
      .then((nextEntries) => {
        if (cancelled) return;
        setEntries(nextEntries as TraceEntryDetails[]);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setLoading(false);
        setError('Trace could not be loaded from the native monitor.');
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, demo, refreshNonce]);

  const kindOptions = useMemo(() => [
    { value: 'all', label: 'All kinds' },
    ...TRACE_KINDS.map((traceKind) => ({ value: traceKind, label: TRACE_KIND_LABEL[traceKind] })),
  ], []);

  const recentEntries = entries.length > MAX_RECENT_ENTRIES ? entries.slice(-MAX_RECENT_ENTRIES) : entries;
  const groups = useMemo(() => groupTraceEntries(recentEntries), [recentEntries]);
  const filteredGroups = useMemo(
    () => filterConversationGroups(groups, search, kind),
    [groups, kind, search],
  );
  const isBounded = entries.length >= MAX_RECENT_ENTRIES;
  const hasFilter = Boolean(search.trim() || kind !== 'all');
  const status = STATUS_LABEL[agent.status];

  function toggleDisclosure(key: string) {
    setOpenDisclosure((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearFilters() {
    setSearch('');
    setKind('all');
  }

  return (
    <section className="trace-workspace" aria-labelledby={`${searchId}-title`}>
      <header className="trace-workspace__header">
        <div className="trace-workspace__heading">
          <h1 id={`${searchId}-title`}>{titleFor(agent)}</h1>
          <div className="trace-workspace__meta">
            <span>{agent.type === 'main' ? 'Root session' : agent.role || agent.type}</span>
            <span>{agent.model || 'Model pending'}</span>
            <span>{agent.reasoningEffort || 'default effort'}</span>
            <span className="trace-workspace__status" style={{ color: STATUS_COLOR[agent.status] }}>{status}</span>
          </div>
          <details className="trace-workspace__session-details">
            <summary>Session details</summary>
            <div className="trace-workspace__session-meta">
              <span>Folder: {agent.cwd || '—'}</span>
              <span>Session: {agent.sessionId || agent.threadId || '—'}</span>
            </div>
          </details>
        </div>
        <button
          type="button"
          className="trace-workspace__refresh"
          onClick={() => setRefreshNonce((value) => value + 1)}
          disabled={loading}
          aria-label="Refresh trace"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="trace-workspace__toolbar">
        <div className="trace-workspace__search">
          <input
            id={searchId}
            type="search"
            aria-label="Search trace"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversation, tool, or result"
            autoComplete="off"
          />
        </div>
        <Dropdown label="Kind" value={kind} options={kindOptions} onChange={setKind} />
        <div className="trace-workspace__count" aria-live="polite">
          {filteredGroups.length} of {groups.length} conversations
        </div>
      </div>

      {isBounded && (
        <p className="trace-workspace__notice">
          Showing the most recent {Math.min(MAX_RECENT_ENTRIES, entries.length)} entries to keep the reader responsive.
        </p>
      )}

      <div className="trace-workspace__content">
        {error && (
          <div className="trace-workspace__empty trace-workspace__empty--error" role="alert">
            <p>{error}</p>
            <button type="button" className="trace-workspace__empty-action" onClick={() => setRefreshNonce((value) => value + 1)}>Retry</button>
          </div>
        )}
        {!error && loading && <div className="trace-workspace__empty" role="status">Loading normalized trace…</div>}
        {!error && !loading && !groups.length && (
          <div className="trace-workspace__empty">
            <p>No normalized trace entries are available for this agent.</p>
          </div>
        )}
        {!error && !loading && groups.length > 0 && !filteredGroups.length && (
          <div className="trace-workspace__empty">
            <p>No conversation cards match the current filters.</p>
            {hasFilter && <button type="button" className="trace-workspace__empty-action" onClick={clearFilters}>Clear filters</button>}
          </div>
        )}
        {!error && !loading && filteredGroups.length > 0 && (
          <div className="trace-workspace__list" aria-label="Normalized conversation trace">
            {filteredGroups.map((group) => (
              <ConversationCard
                key={group.id}
                group={group}
                openDisclosure={openDisclosure}
                onToggle={toggleDisclosure}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ConversationCard({ group, openDisclosure, onToggle }: {
  group: ConversationGroup;
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <article className={`trace-workspace__card trace-workspace__card--${group.kind}`}>
      <header className="trace-workspace__card-header">
        <div className="trace-workspace__card-heading">
          <strong>{groupLabel(group.kind)}</strong>
          {group.model && <span>{group.model}</span>}
          {group.reasoningEffort && <span>{group.reasoningEffort}</span>}
          {group.turnId && <span>{group.turnId}</span>}
        </div>
        <time dateTime={group.timestamp ? new Date(group.timestamp).toISOString() : undefined}>{timeFor(group.timestamp)}</time>
      </header>
      <div className="trace-workspace__card-body">
        {group.blocks.map((block, index) => {
          const key = `${group.id}:${blockClass(block)}:${index}`;
          if (block.type === 'tools') {
            return <ToolGroup key={key} groupKey={key} tools={block.tools} openDisclosure={openDisclosure} onToggle={onToggle} />;
          }
          if (block.type === 'thinking') {
            return <ThinkingBlock key={key} groupKey={key} entry={block.entry} updates={block.updates} openDisclosure={openDisclosure} onToggle={onToggle} />;
          }
          if (block.type === 'tool-result') {
            return <UnmatchedResult key={key} groupKey={key} entry={block.entry} openDisclosure={openDisclosure} onToggle={onToggle} />;
          }
          const entry = blockEntry(block);
          if (!entry) return null;
          return <p key={key} className={`trace-workspace__text trace-workspace__text--${block.type}`}>{entry.text}</p>;
        })}
      </div>
    </article>
  );
}

function ToolGroup({ groupKey, tools, openDisclosure, onToggle }: {
  groupKey: string;
  tools: ConversationTool[];
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
}) {
  const open = openDisclosure.has(groupKey);
  const names = Array.from(new Set(tools.map(({ call }) => call.toolName || 'tool'))).join(', ');
  return (
    <section className="trace-workspace__tools">
      <button type="button" className="trace-workspace__disclosure" aria-expanded={open} onClick={() => onToggle(groupKey)}>
        <strong>{open ? 'Hide' : 'Show'} {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}</strong>
        <span>{names}</span>
      </button>
      {open && (
        <div className="trace-workspace__tool-list">
          {tools.map((tool, index) => (
            <ToolRow key={`${groupKey}:${tool.call.id}:${index}`} tool={tool} toolKey={`${groupKey}:tool:${index}`} openDisclosure={openDisclosure} onToggle={onToggle} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolRow({ tool, toolKey, openDisclosure, onToggle }: {
  tool: ConversationTool;
  toolKey: string;
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
}) {
  const open = openDisclosure.has(toolKey);
  const input = getToolInput(tool.call);
  const result = tool.result
    ? prettyTraceText(tool.result.text || 'Empty result')
    : { text: 'No result in the retained trace.', pretty: false };
  return (
    <div className={`trace-workspace__tool ${tool.result?.kind === 'error' ? 'trace-workspace__tool--error' : ''}`}>
      <button type="button" className="trace-workspace__tool-summary" aria-expanded={open} onClick={() => onToggle(toolKey)}>
        <strong>{tool.call.toolName || 'Tool call'}</strong>
        <span>{preview(input) || 'No input'}</span>
        <em>{toolStatus(tool)}</em>
        <span>{open ? 'Hide input and result' : 'Show input and result'}</span>
      </button>
      {open && (
        <div className="trace-workspace__tool-details">
          <div>
            <div className="trace-workspace__code-label">Input</div>
            <pre>{input || '—'}</pre>
          </div>
          <div>
            <div className="trace-workspace__code-label">{tool.result?.kind === 'error' ? 'Error' : 'Result'}</div>
            <pre>{result.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ groupKey, entry, updates, openDisclosure, onToggle }: {
  updates?: number;
  groupKey: string;
  entry: TraceEntryDetails;
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
}) {
  const open = openDisclosure.has(groupKey);
  return (
    <section className="trace-workspace__thinking">
      <button type="button" className="trace-workspace__disclosure" aria-expanded={open} onClick={() => onToggle(groupKey)}>
        <strong>Thinking{updates && updates > 1 ? ` · ${updates} updates` : ''}</strong>
        <span>{preview(entry.text, 220)}</span>
        <em>{open ? 'Hide reasoning' : 'Show reasoning'}</em>
      </button>
      {open && <pre className="trace-workspace__thinking-body">{entry.text}</pre>}
    </section>
  );
}

function UnmatchedResult({ groupKey, entry, openDisclosure, onToggle }: {
  groupKey: string;
  entry: TraceEntryDetails;
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
}) {
  const open = openDisclosure.has(groupKey);
  const output = prettyTraceText(entry.text);
  return (
    <section className={`trace-workspace__orphan-result ${entry.kind === 'error' ? 'trace-workspace__orphan-result--error' : ''}`}>
      <button type="button" className="trace-workspace__disclosure" aria-expanded={open} onClick={() => onToggle(groupKey)}>
        <strong>{entry.kind === 'error' ? 'Unmatched tool error' : 'Unmatched tool result'}</strong>
        <span>{preview(entry.text)}</span>
        <em>{open ? 'Hide result' : 'Show result'}</em>
      </button>
      {open && <pre className="trace-workspace__thinking-body">{output.text}</pre>}
    </section>
  );
}

export default TraceWorkspace;
