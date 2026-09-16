import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Agent, MonitorSnapshot, TraceEntry } from '../../shared/types';
import { replaceAgents } from '../../graph/reducer';

type Row = Record<string, unknown>;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const str = (value: unknown) => typeof value === 'string' ? value : '';
const timestamp = (value: unknown) => num(value) ? (num(value) < 1e11 ? num(value) * 1000 : num(value)) : undefined;
const bounded = (value: string) => value.length > 65536 ? `${value.slice(0, 65536)}\n[Truncated]` : value;
function parse(value: unknown): unknown { try { return JSON.parse(str(value)); } catch { return value; } }
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const row = value as Row;
    return str(row.text ?? row.content ?? row.thinking) || JSON.stringify(value);
  }
  return value == null ? '' : String(value);
}

/** Read-only native Hermes session source. Messages are queried only for the selected run. */
export class HermesMonitor extends EventEmitter {
  private readonly dbPath: string;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private db?: DatabaseSync;
  private identity?: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private pending?: Promise<void>;
  private selectedRunId?: string;
  private generation = 0;
  private traces = new Map<string, TraceEntry[]>();
  private catalog: Agent[] = [];
  private errors: string[] = [];
  private sessionColumns = new Set<string>();
  private messageColumns = new Set<string>();
  private usageColumns = new Set<string>();

  constructor(options: { dbPath?: string; idleMs?: number; pollMs?: number } = {}) {
    super();
    this.dbPath = options.dbPath ?? path.join(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), 'state.db');
    this.idleMs = options.idleMs ?? 30_000;
    this.pollMs = options.pollMs ?? 2_000;
  }

  async start(): Promise<void> {
    if (this.running) return this.pending;
    this.running = true;
    await this.refresh();
    if (!this.running) return;
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    this.close();
    this.unloadRun();
  }

  private close() { this.db?.close(); this.db = undefined; this.identity = undefined; }

  snapshot(): MonitorSnapshot {
    const graph = replaceAgents({agents:[],runs:[],edges:[]}, this.catalog);
    const agents = graph.agents.filter(agent => agent.runId === this.selectedRunId);
    const ids = new Set(agents.map(agent => agent.id));
    return {
      agents: agents.map(agent => ({...agent,stats:{...agent.stats},tokenUsage:agent.tokenUsage?.map(usage=>({...usage}))})),
      runs: graph.runs.map(run => ({...run,agentCount:graph.agents.filter(agent => agent.runId === run.id).length})),
      edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
      watching: this.running, errors:[...this.errors],
      ...(this.selectedRunId ? {selectedRunId:this.selectedRunId} : {}),
    };
  }

  async loadRun(runId: string): Promise<void> {
    const generation = ++this.generation;
    await this.start();
    if (generation !== this.generation || !this.running) return;
    if (!this.snapshot().runs.some(run => run.id === runId)) throw new Error(`Unknown Hermes run: ${runId}`);
    this.traces.clear();
    this.selectedRunId = runId;
    this.readSelected();
    this.publish();
  }
  unloadRun(): void { this.generation += 1; this.selectedRunId = undefined; this.traces.clear(); this.publish(); }
  async getTrace(agentId: string): Promise<TraceEntry[]> { return (this.traces.get(agentId) ?? []).map(entry => ({...entry})); }
  private publish() { this.emit('snapshot',this.snapshot()); }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.readInventory().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readInventory(): Promise<void> {
    try {
      const info = await stat(this.dbPath);
      if (!this.running) return;
      const identity = `${info.dev}:${info.ino}`;
      if (this.identity !== identity) {
        this.close();
        this.db = new DatabaseSync(this.dbPath, {readOnly:true});
        this.db.exec('PRAGMA busy_timeout=200');
        this.sessionColumns = new Set((this.db.prepare('PRAGMA table_info(sessions)').all() as Row[]).map(row => str(row.name)));
        this.messageColumns = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as Row[]).map(row => str(row.name)));
        this.usageColumns = new Set((this.db.prepare('PRAGMA table_info(session_model_usage)').all() as Row[]).map(row => str(row.name)));
        if (!this.sessionColumns.has('id') || !this.messageColumns.has('session_id')) throw new Error('Unsupported Hermes database schema');
        this.identity = identity;
      }
      const columns = ['id','source','parent_session_id','model','cwd','title','started_at','ended_at','end_reason','last_activity_at','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','tool_call_count'];
      const projection = columns.map(column => this.sessionColumns.has(column) ? column : `NULL AS ${column}`).join(',')
        + (this.sessionColumns.has('model_config') ? ", CASE WHEN json_valid(model_config) THEN json_extract(model_config, '$._delegate_from') END AS delegate_from" : ', NULL AS delegate_from');
      const rows = this.db!.prepare(`SELECT ${projection} FROM sessions`).all() as Row[];
      this.catalog = rows.map(row => {
        const id = `hermes:${str(row.id)}`;
        const child = row.source === 'subagent' && !!row.parent_session_id && row.delegate_from === row.parent_session_id;
        const lastActivityAt = timestamp(row.last_activity_at) ?? timestamp(row.ended_at) ?? timestamp(row.started_at);
        const end = str(row.end_reason);
        const failed = /error|fail|incomplete|orphan/.test(end);
        return {
          id,runId:id,harness:'hermes',parentId:null,threadId:id,sessionId:str(row.id),
          ...(child && row.parent_session_id ? {parentThreadId:`hermes:${str(row.parent_session_id)}`} : {}),
          type:child?'subagent':'main', model:str(row.model)||undefined,cwd:str(row.cwd)||undefined,
          role:child?'subagent':undefined,nickname:str(row.title)||undefined,
          tracePath:this.dbPath,createdAt:timestamp(row.started_at),lastActivityAt,
          status:failed?'error':row.ended_at?'finished':lastActivityAt && lastActivityAt > Date.now()-this.idleMs?'active':'idle',
          stats:{inputTokens:num(row.input_tokens)+num(row.cache_read_tokens)+num(row.cache_write_tokens),outputTokens:num(row.output_tokens),toolCalls:num(row.tool_call_count),errors:failed?1:0},
        } satisfies Agent;
      });
      this.errors = [];
      if (this.selectedRunId && !this.snapshot().runs.some(run => run.id === this.selectedRunId)) this.unloadRun();
      this.readSelected();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.close();
      this.catalog = [];
      this.traces.clear();
      this.errors = code === 'ENOENT' || code === 'ENOTDIR' ? [] : [`Hermes: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (this.running) this.publish();
  }

  private readSelected(): void {
    if (!this.db || !this.selectedRunId) return;
    this.traces.clear();
    const columns = ['id','role','content','tool_call_id','tool_calls','tool_name','timestamp','finish_reason','reasoning','reasoning_content'];
    // Bound individual fields before they cross the SQLite/JS boundary.
    const projection = columns.map(column => !this.messageColumns.has(column) ? `NULL AS ${column}` : ['content','tool_calls','reasoning','reasoning_content'].includes(column) ? `substr(${column},1,131072) AS ${column}` : column).join(',');
    const query = this.db.prepare(`SELECT ${projection} FROM messages WHERE session_id=? ${this.messageColumns.has('active') ? 'AND active=1' : ''} ORDER BY id DESC LIMIT 200`);
    for (const agent of this.snapshot().agents) {
      const rows = (query.all(agent.sessionId!) as Row[]).reverse();
      const last = rows.at(-1);
      const storedAgent = this.catalog.find(candidate => candidate.id === agent.id);
      if (storedAgent && this.usageColumns.has('session_id') && this.usageColumns.has('model')) {
        const fields = ['model','billing_provider','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'];
        const selection = fields.map(field => this.usageColumns.has(field) ? field : `NULL AS ${field}`).join(',');
        storedAgent.tokenUsage = (this.db.prepare(`SELECT ${selection} FROM session_model_usage WHERE session_id=?`).all(agent.sessionId!) as Row[]).map(row => ({
          model:str(row.model),provider:str(row.billing_provider)||undefined,
          inputTokens:num(row.input_tokens)+num(row.cache_read_tokens)+num(row.cache_write_tokens),outputTokens:num(row.output_tokens),
          cacheReadTokens:row.cache_read_tokens == null ? undefined : num(row.cache_read_tokens),
          cacheWriteTokens:row.cache_write_tokens == null ? undefined : num(row.cache_write_tokens),
        }));
      }
      if (last && storedAgent) {
        const finish = str(last.finish_reason).toLowerCase();
        if (/error|fail|abort/.test(finish)) {
          storedAgent.status = 'error';
          storedAgent.stats.errors = Math.max(1, storedAgent.stats.errors);
        } else if (last.role === 'assistant' && (!str(last.tool_calls)
            || (Array.isArray(parse(last.tool_calls)) && !(parse(last.tool_calls) as unknown[]).length))) {
          storedAgent.status = 'finished';
        } else if (storedAgent.status === 'finished') {
          storedAgent.status = 'idle';
          storedAgent.activity = 'Interrupted';
        }
      }
      const entries: TraceEntry[] = [];
      const add = (row:Row,kind:TraceEntry['kind'],text:string,extra:Partial<TraceEntry>={}) => entries.push({id:`${agent.id}:${row.id}:${entries.length}`,timestamp:timestamp(row.timestamp),kind,text:bounded(text),model:agent.model,...extra});
      for (const row of rows) {
        const role = str(row.role);
        const failed = /error|fail|abort/.test(str(row.finish_reason));
        const reasoning = str(row.reasoning_content) || str(row.reasoning);
        if (reasoning) add(row,'thinking',reasoning);
        const text = content(parse(row.content));
        if (role === 'tool' || role === 'function') add(row,failed?'error':'tool-result',text,{callId:str(row.tool_call_id)||undefined,toolName:str(row.tool_name)||undefined});
        else if (text) add(row,role === 'user'?'user':role === 'assistant'?'assistant':'event',text);
        const calls = parse(row.tool_calls);
        if (Array.isArray(calls)) for (const item of calls) {
          if (!item || typeof item !== 'object') continue;
          const call = item as Row;
          const fn = call.function && typeof call.function === 'object' ? call.function as Row : call;
          const name = str(fn.name) || 'tool';
          add(row,'tool-call',`${name}: ${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? fn.input ?? {})}`,{callId:str(call.id)||undefined,toolName:name});
        }
        if (failed && role !== 'tool') add(row,'error',str(row.finish_reason));
      }
      this.traces.set(agent.id,entries.slice(-200));
    }
  }
}
