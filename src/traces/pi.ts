import {
  codexUsage,
  contentText,
  firstString,
  isObject,
  namespacedId,
  parseJson,
  pathLower,
  rawTimestamp,
  type JsonObject,
  type ProviderSession,
} from './provider-common';

type PiBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-call'; id?: string; name: string; input: unknown }
  | { kind: 'tool-result'; id?: string; output: unknown; error: boolean; toolName?: string };

interface PiIdentity {
  sessionId: string;
  agentId: string;
  parentThreadId?: string;
  threadSource: 'user' | 'subagent';
  cwd?: string;
  model?: string;
  provider?: string;
  serviceTier?: string;
  effort?: string;
  forkParentSession?: string;
  agentPath: string;
}

function messageOf(value: JsonObject): JsonObject | undefined {
  return isObject(value.message) ? value.message : undefined;
}

function blockType(value: JsonObject): string {
  return (firstString(value, ['type']) ?? '').toLowerCase();
}

function toolInput(value: JsonObject): unknown {
  if ('arguments' in value) return parseJson(value.arguments);
  if ('input' in value) return parseJson(value.input);
  if ('parameters' in value) return parseJson(value.parameters);
  if ('command' in value) return { command: value.command };
  return {};
}

function normalizedBlocks(content: unknown): PiBlock[] {
  if (content === undefined || content === null || content === '') return [];
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
    return [{ kind: 'text', text: String(content) }];
  }
  if (!Array.isArray(content)) {
    const text = contentText(content);
    return text ? [{ kind: 'text', text }] : [];
  }
  const blocks: PiBlock[] = [];
  for (const raw of content) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      blocks.push({ kind: 'text', text: String(raw) });
      continue;
    }
    if (!isObject(raw)) continue;
    const type = blockType(raw);
    if (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'message') {
      const text = typeof raw.text === 'string' ? raw.text : contentText(raw.content);
      if (text) blocks.push({ kind: 'text', text });
      continue;
    }
    if (type === 'thinking' || type === 'reasoning' || type === 'summary' || type === 'summary_text') {
      const text = contentText(raw.thinking ?? raw.text ?? raw.summary ?? raw.content);
      if (text) blocks.push({ kind: 'thinking', text });
      continue;
    }
    if (type === 'toolcall' || type === 'tool_call' || type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const id = firstString(raw, ['id', 'call_id', 'callId', 'toolCallId']);
      const name = firstString(raw, ['name', 'toolName', 'tool_name'])
        ?? (type === 'local_shell_call' ? 'shell' : type.replace(/_(?:call)$/, ''));
      blocks.push({ kind: 'tool-call', ...(id ? { id } : {}), name, input: toolInput(raw) });
      continue;
    }
    if (type === 'toolresult' || type === 'tool_result' || type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      const id = firstString(raw, ['toolCallId', 'tool_call_id', 'tool_use_id', 'call_id', 'callId', 'id']);
      const output = raw.content !== undefined ? raw.content : raw.output !== undefined ? raw.output : raw.result;
      blocks.push({
        kind: 'tool-result',
        ...(id ? { id } : {}),
        output,
        error: raw.isError === true || raw.is_error === true || String(raw.status ?? '').toLowerCase() === 'error',
        ...(firstString(raw, ['toolName', 'tool_name', 'name']) ? { toolName: firstString(raw, ['toolName', 'tool_name', 'name']) } : {}),
      });
      continue;
    }
    const fallback = contentText(raw);
    if (fallback) blocks.push({ kind: 'text', text: fallback });
  }
  return blocks;
}

function pathSegments(tracePath: string): string[] {
  return tracePath.replaceAll('\\', '/').split('/').filter(Boolean);
}

function basenameWithoutExtension(tracePath: string): string | undefined {
  const segments = pathSegments(tracePath);
  const file = segments[segments.length - 1]?.replace(/\.jsonl$/i, '');
  return file || undefined;
}

function explicitPiParent(value: JsonObject): string | undefined {
  const direct = firstString(value, [
    'parentThreadId', 'parent_thread_id', 'parentAgentId', 'parent_agent_id',
    'spawnedFrom', 'spawned_from', 'spawnedBy', 'spawned_by',
  ]);
  if (direct) return direct;

  // parentSession is a fork/conversation relationship in Pi. It becomes an
  // agent edge only when the trace explicitly labels the session as spawned.
  const spawnMarker = value.spawned === true || value.isSubagent === true || value.is_subagent === true
    || firstString(value, ['agentType', 'agent_type', 'threadSource', 'thread_source', 'relationship']) === 'subagent'
    || firstString(value, ['relationship']) === 'spawn';
  return spawnMarker ? firstString(value, ['parentSession', 'parent_session']) : undefined;
}

function deriveIdentity(value: JsonObject, tracePath: string): PiIdentity {
  const message = messageOf(value);
  const sessionId = firstString(value, ['id', 'sessionId', 'session_id'])
    ?? firstString(message, ['sessionId', 'session_id'])
    ?? basenameWithoutExtension(tracePath)
    ?? 'unknown';
  const explicitParent = explicitPiParent(value);
  const parentThreadId = explicitParent ? namespacedId('pi', explicitParent) : undefined;
  const model = firstString(value, ['modelId', 'model_id', 'model'])
    ?? firstString(message, ['modelId', 'model_id', 'model']);
  const provider = firstString(value, ['provider', 'model_provider', 'modelProvider'])
    ?? firstString(message, ['provider', 'model_provider', 'modelProvider']);
  const usage = isObject(message?.usage) ? message.usage : isObject(value.usage) ? value.usage : undefined;
  const serviceTier = firstString(value, ['service_tier', 'serviceTier', 'tier'])
    ?? firstString(message, ['service_tier', 'serviceTier', 'tier'])
    ?? firstString(usage, ['service_tier', 'serviceTier', 'tier']);
  const effort = firstString(value, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort'])
    ?? firstString(message, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort']);
  const cwd = firstString(value, ['cwd', 'working_directory', 'workingDirectory'])
    ?? firstString(message, ['cwd', 'working_directory', 'workingDirectory']);
  return {
    sessionId,
    agentId: namespacedId('pi', sessionId),
    ...(parentThreadId ? { parentThreadId } : {}),
    threadSource: parentThreadId ? 'subagent' : 'user',
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(effort ? { effort } : {}),
    ...(firstString(value, ['parentSession', 'parent_session']) ? { forkParentSession: firstString(value, ['parentSession', 'parent_session']) } : {}),
    agentPath: tracePath,
  };
}

function syntheticHeader(identity: PiIdentity, value: JsonObject): JsonObject {
  const payload: JsonObject = {
    id: identity.agentId,
    session_id: identity.sessionId,
    thread_source: identity.threadSource,
    harness: 'pi',
    ...(identity.parentThreadId ? { parent_thread_id: identity.parentThreadId } : {}),
    ...(identity.forkParentSession ? { parent_session: identity.forkParentSession } : {}),
    ...(identity.cwd ? { cwd: identity.cwd } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.provider ? { model_provider: identity.provider, provider: identity.provider } : {}),
    ...(identity.serviceTier ? { service_tier: identity.serviceTier } : {}),
    ...(identity.effort ? { effort: identity.effort, reasoning_effort: identity.effort } : {}),
    agent_path: identity.agentPath,
  };
  const timestamp = rawTimestamp(value, messageOf(value));
  if (timestamp !== undefined) payload.timestamp = timestamp;
  return { type: 'session_meta', payload };
}

function record(type: string, payload: JsonObject, timestamp: unknown): JsonObject {
  return {
    type,
    ...(timestamp !== undefined ? { timestamp } : {}),
    payload,
  };
}

function turnContext(
  turnId: string,
  timestamp: unknown,
  model: string | undefined,
  provider: string | undefined,
  serviceTier: string | undefined,
  effort: string | undefined,
  cwd: string | undefined,
): JsonObject {
  return record('turn_context', {
    turn_id: turnId,
    ...(model ? { model } : {}),
    ...(provider ? { model_provider: provider, provider } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(effort ? { effort, reasoning_effort: effort } : {}),
    ...(cwd ? { cwd } : {}),
  }, timestamp);
}

function responseMessage(role: 'user' | 'assistant', text: string, timestamp: unknown): JsonObject {
  return record('response_item', {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  }, timestamp);
}

function responseThinking(text: string, timestamp: unknown): JsonObject {
  return record('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text }] }, timestamp);
}

function responseToolCall(block: Extract<PiBlock, { kind: 'tool-call' }>, timestamp: unknown, metadata?: JsonObject): JsonObject {
  return record('response_item', {
    type: 'custom_tool_call',
    ...(block.id ? { call_id: block.id } : {}),
    name: block.name,
    input: block.input,
    ...(metadata ? { metadata } : {}),
  }, timestamp);
}

function responseToolResult(block: Extract<PiBlock, { kind: 'tool-result' }>, timestamp: unknown): JsonObject {
  return record('response_item', {
    type: 'custom_tool_call_output',
    ...(block.id ? { call_id: block.id } : {}),
    ...(block.toolName ? { tool_name: block.toolName } : {}),
    output: block.output,
    ...(block.error ? { status: 'error', error: true } : {}),
  }, timestamp);
}

function lifecycle(type: string, text: string | undefined, timestamp: unknown): JsonObject {
  return record('event_msg', { type, ...(text ? { message: text } : {}) }, timestamp);
}

type NormalizedUsage = ReturnType<typeof codexUsage>;

function usageRecord(values: NormalizedUsage, turnId: string, timestamp: unknown, usageId = turnId): JsonObject | undefined {
  if (values.input === undefined && values.output === undefined) return undefined;
  const lastTokenUsage: JsonObject = {
    ...(values.input !== undefined ? { input_tokens: values.input } : {}),
    ...(values.output !== undefined ? { output_tokens: values.output } : {}),
    ...(values.cacheRead !== undefined ? {
      cached_input_tokens: values.cacheRead,
      cache_read_input_tokens: values.cacheRead,
    } : {}),
    ...(values.cacheCreate !== undefined ? {
      cache_write_input_tokens: values.cacheCreate,
      cache_creation_input_tokens: values.cacheCreate,
    } : {}),
    ...(values.cacheWrite5m !== undefined || values.cacheWrite1h !== undefined ? {
      cache_creation: {
        ...(values.cacheWrite5m !== undefined ? { ephemeral_5m_input_tokens: values.cacheWrite5m } : {}),
        ...(values.cacheWrite1h !== undefined ? { ephemeral_1h_input_tokens: values.cacheWrite1h } : {}),
      },
    } : {}),
    input_tokens_includes_cache: true,
  };
  return record('event_msg', {
    type: 'token_count',
    info: {
      turn_id: turnId,
      usage_id: usageId,
      last_token_usage: lastTokenUsage,
    },
  }, timestamp);
}

function rawId(value: JsonObject, message: JsonObject | undefined, agentId: string, index: number): string {
  return firstString(message, ['id', 'messageId', 'message_id'])
    ?? firstString(value, ['id', 'uuid', 'messageId', 'message_id'])
    ?? `${agentId}:entry:${index}`;
}

function errorText(value: JsonObject, message?: JsonObject): string | undefined {
  return contentText(value.error ?? value.message ?? value.reason ?? value.text)
    || contentText(message?.content)
    || undefined;
}

function messageModel(value: JsonObject, message: JsonObject | undefined, fallback: string | undefined): string | undefined {
  return firstString(message, ['modelId', 'model_id', 'model'])
    ?? firstString(value, ['modelId', 'model_id', 'model'])
    ?? fallback;
}

function messageProvider(value: JsonObject, message: JsonObject | undefined, fallback: string | undefined): string | undefined {
  return firstString(message, ['provider', 'model_provider', 'modelProvider'])
    ?? firstString(value, ['provider', 'model_provider', 'modelProvider'])
    ?? fallback;
}

function messageEffort(value: JsonObject, message: JsonObject | undefined, fallback: string | undefined): string | undefined {
  return firstString(message, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort'])
    ?? firstString(value, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort'])
    ?? fallback;
}

class PiSession implements ProviderSession {
  readonly harness = 'pi' as const;
  readonly header: unknown;
  private readonly identity: PiIdentity;
  private headerEmitted = false;
  private currentModel?: string;
  private currentProvider?: string;
  private currentServiceTier?: string;
  private currentEffort?: string;
  private currentCwd?: string;
  private readonly usageMessageValues = new Map<string, NormalizedUsage>();

  constructor(identity: PiIdentity, header: JsonObject) {
    this.identity = identity;
    this.header = header;
    this.currentModel = identity.model;
    this.currentProvider = identity.provider;
    this.currentServiceTier = identity.serviceTier;
    this.currentEffort = identity.effort;
    this.currentCwd = identity.cwd;
  }

  normalize(value: unknown, index: number): unknown[] {
    const output: unknown[] = [];
    if (!this.headerEmitted) {
      output.push(this.header);
      this.headerEmitted = true;
    }
    if (!isObject(value)) return output;
    const message = messageOf(value);
    const type = firstString(value, ['type'])?.toLowerCase();
    const timestamp = rawTimestamp(value, message);

    if (type === 'model_change') {
      this.currentModel = firstString(value, ['modelId', 'model_id', 'model']) ?? this.currentModel;
      this.currentProvider = firstString(value, ['provider', 'model_provider', 'modelProvider']) ?? this.currentProvider;
      this.currentServiceTier = firstString(value, ['service_tier', 'serviceTier', 'tier']) ?? this.currentServiceTier;
      output.push(turnContext(rawId(value, undefined, this.identity.agentId, index), timestamp, this.currentModel, this.currentProvider, this.currentServiceTier, this.currentEffort, this.currentCwd));
      return output;
    }
    if (type === 'thinking_level_change') {
      this.currentEffort = firstString(value, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort']) ?? this.currentEffort;
      output.push(turnContext(rawId(value, undefined, this.identity.agentId, index), timestamp, this.currentModel, this.currentProvider, this.currentServiceTier, this.currentEffort, this.currentCwd));
      return output;
    }
    if (type === 'session_info') return output;
    if (type === 'session') {
      // A session line may be the first normalized value. Keep dynamic fields
      // current without emitting a second synthetic header.
      this.currentModel = firstString(value, ['modelId', 'model_id', 'model']) ?? this.currentModel;
      this.currentProvider = firstString(value, ['provider', 'model_provider', 'modelProvider']) ?? this.currentProvider;
      this.currentEffort = firstString(value, ['thinkingLevel', 'thinking_level', 'reasoningEffort', 'reasoning_effort', 'effort']) ?? this.currentEffort;
      this.currentCwd = firstString(value, ['cwd', 'working_directory', 'workingDirectory']) ?? this.currentCwd;
      return output;
    }

    const model = messageModel(value, message, this.currentModel);
    const provider = messageProvider(value, message, this.currentProvider);
    const effort = messageEffort(value, message, this.currentEffort);
    const messageUsage = message?.usage ?? value.usage;
    const usageObject = isObject(messageUsage) ? messageUsage : undefined;
    const serviceTier = firstString(message, ['service_tier', 'serviceTier', 'tier'])
      ?? firstString(value, ['service_tier', 'serviceTier', 'tier'])
      ?? firstString(usageObject, ['service_tier', 'serviceTier', 'tier'])
      ?? this.currentServiceTier;
    const cwd = firstString(value, ['cwd', 'working_directory', 'workingDirectory']) ?? this.currentCwd;
    this.currentModel = model;
    this.currentProvider = provider;
    this.currentServiceTier = serviceTier;
    this.currentEffort = effort;
    this.currentCwd = cwd;
    const turnId = rawId(value, message, this.identity.agentId, index);
    const addContext = () => output.push(turnContext(turnId, timestamp, model, provider, serviceTier, effort, cwd));
    const addUsage = (usage: unknown, usageId = turnId) => {
      if (!isObject(usage)) return;
      const normalizedValues = codexUsage(usage);
      const previous = this.usageMessageValues.get(usageId);
      const merged: NormalizedUsage = {
        ...(normalizedValues.input !== undefined || previous?.input !== undefined
          ? { input: Math.max(normalizedValues.input ?? 0, previous?.input ?? 0) } : {}),
        ...(normalizedValues.output !== undefined || previous?.output !== undefined
          ? { output: Math.max(normalizedValues.output ?? 0, previous?.output ?? 0) } : {}),
        ...(normalizedValues.cacheRead !== undefined || previous?.cacheRead !== undefined
          ? { cacheRead: Math.max(normalizedValues.cacheRead ?? 0, previous?.cacheRead ?? 0) } : {}),
        ...(normalizedValues.cacheCreate !== undefined || previous?.cacheCreate !== undefined
          ? { cacheCreate: Math.max(normalizedValues.cacheCreate ?? 0, previous?.cacheCreate ?? 0) } : {}),
        ...(normalizedValues.cacheWrite5m !== undefined || previous?.cacheWrite5m !== undefined
          ? { cacheWrite5m: Math.max(normalizedValues.cacheWrite5m ?? 0, previous?.cacheWrite5m ?? 0) } : {}),
        ...(normalizedValues.cacheWrite1h !== undefined || previous?.cacheWrite1h !== undefined
          ? { cacheWrite1h: Math.max(normalizedValues.cacheWrite1h ?? 0, previous?.cacheWrite1h ?? 0) } : {}),
      };
      if (previous && JSON.stringify(previous) === JSON.stringify(merged)) return;
      const normalized = usageRecord(merged, turnId, timestamp, usageId);
      if (normalized) output.push(normalized);
      if (normalized) this.usageMessageValues.set(usageId, merged);
    };
    const addBlock = (block: PiBlock, role: 'user' | 'assistant') => {
      if (block.kind === 'text') output.push(responseMessage(role, block.text, timestamp));
      else if (block.kind === 'thinking') output.push(responseThinking(block.text, timestamp));
      else if (block.kind === 'tool-call') output.push(responseToolCall(block, timestamp));
      else output.push(responseToolResult(block, timestamp));
    };

    if (type === 'message' && message) {
      const role = firstString(message, ['role']) ?? 'assistant';
      if (role === 'bashExecution') {
        addContext();
        const callId = firstString(message, ['id', 'callId', 'call_id']) ?? firstString(value, ['id']) ?? `${this.identity.agentId}:bash:${index}`;
        const call: PiBlock = { kind: 'tool-call', id: callId, name: 'bash', input: { command: message.command ?? '' } };
        output.push(responseToolCall(call, timestamp, {
          exitCode: message.exitCode,
          cancelled: message.cancelled === true,
          truncated: message.truncated === true,
        }));
        output.push(responseToolResult({
          kind: 'tool-result',
          id: callId,
          output: message.output ?? '',
          error: typeof message.exitCode === 'number' && message.exitCode !== 0,
          toolName: 'bash',
        }, timestamp));
        return output;
      }
      if (role === 'toolResult') {
        addContext();
        const result: PiBlock = {
          kind: 'tool-result',
          ...(firstString(message, ['toolCallId', 'tool_call_id', 'callId', 'call_id']) ? { id: firstString(message, ['toolCallId', 'tool_call_id', 'callId', 'call_id']) } : {}),
          output: message.content ?? message.output ?? message.result,
          error: message.isError === true || message.is_error === true,
          ...(firstString(message, ['toolName', 'tool_name', 'name']) ? { toolName: firstString(message, ['toolName', 'tool_name', 'name']) } : {}),
        };
        output.push(responseToolResult(result, timestamp));
        return output;
      }

      addContext();
      const blocks = normalizedBlocks(message.content);
      if (message.reasoningContent !== undefined) {
        const thinking = contentText(message.reasoningContent);
        if (thinking) output.push(responseThinking(thinking, timestamp));
      }
      for (const block of blocks) addBlock(block, role === 'user' ? 'user' : 'assistant');
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const callValue of toolCalls) {
        if (!isObject(callValue)) continue;
        const block: PiBlock = {
          kind: 'tool-call',
          ...(firstString(callValue, ['id', 'call_id', 'callId']) ? { id: firstString(callValue, ['id', 'call_id', 'callId']) } : {}),
          name: firstString(callValue, ['name', 'toolName', 'tool_name'])
            ?? (isObject(callValue.function) ? firstString(callValue.function, ['name']) : undefined)
            ?? 'tool',
          input: isObject(callValue.function) && 'arguments' in callValue.function
            ? parseJson(callValue.function.arguments)
            : toolInput(callValue),
        };
        output.push(responseToolCall(block, timestamp));
      }
      addUsage(messageUsage, turnId);
      const stopReason = firstString(message, ['stopReason', 'stop_reason'])?.toLowerCase();
      if (stopReason === 'error' || stopReason === 'aborted' || stopReason === 'cancelled' || stopReason === 'canceled') {
        output.push(lifecycle('error', errorText(value, message) ?? `Turn ${stopReason}`, timestamp));
      } else if ((stopReason === 'stop' || stopReason === 'end_turn' || stopReason === 'stop_sequence')
        && !blocks.some((block) => block.kind === 'tool-call') && toolCalls.length === 0) {
        output.push(lifecycle('task_complete', 'Turn completed', timestamp));
      }
      return output;
    }

    if (type === 'bash_execution' || type === 'bashexecution') {
      addContext();
      const callId = firstString(value, ['id', 'callId', 'call_id']) ?? `${this.identity.agentId}:bash:${index}`;
      output.push(responseToolCall({ kind: 'tool-call', id: callId, name: 'bash', input: { command: value.command ?? '' } }, timestamp, {
        exitCode: value.exitCode,
        cancelled: value.cancelled === true,
        truncated: value.truncated === true,
      }));
      output.push(responseToolResult({
        kind: 'tool-result',
        id: callId,
        output: value.output ?? '',
        error: typeof value.exitCode === 'number' && value.exitCode !== 0,
        toolName: 'bash',
      }, timestamp));
      return output;
    }

    if (type === 'compaction' || type === 'compaction_summary' || type === 'branch_summary' || type === 'branchsummary') {
      addContext();
      const text = contentText(value.summary ?? value.message ?? value.content ?? value.text);
      if (text) output.push(responseThinking(type.startsWith('branch') ? `Branch summary: ${text}` : `Context compacted: ${text}`, timestamp));
      return output;
    }

    if (type === 'custom_message' || type === 'custommessage') {
      if (value.display === false) return output;
      addContext();
      const text = contentText(value.content ?? value.message ?? value.text);
      if (text) output.push(responseMessage('assistant', text, timestamp));
      return output;
    }

    if (type === 'error' || type === 'turn_error' || type === 'turn_failed' || type === 'agent_error') {
      addContext();
      output.push(lifecycle('error', errorText(value, message) ?? 'Task failed', timestamp));
      return output;
    }

    if (type === 'turn_end' || type === 'turn_complete' || type === 'end_turn' || type === 'agent_end' || type === 'session_end' || type === 'done' || type === 'shutdown') {
      addContext();
      output.push(lifecycle('turn_complete', errorText(value, message) ?? 'Turn completed', timestamp));
    }
    return output;
  }
}

const PI_MESSAGE_ROLES = new Set([
  'user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'customMessage',
  'custom_message', 'branchSummary', 'compactionSummary',
]);

function hasPiSignal(value: JsonObject, tracePath: string): boolean {
  const type = firstString(value, ['type'])?.toLowerCase();
  if (type === 'session') {
    // A bare {type:"session", id:"..."} is common in unrelated logs. Pi's
    // native header carries at least one session setting, or lives in its
    // well-known session directory.
    return !!firstString(value, ['version', 'cwd', 'provider', 'modelId', 'model'])
      || pathLower(tracePath).includes('/.pi/agent/sessions');
  }
  const message = messageOf(value);
  const role = firstString(message, ['role']);
  const pathSignal = pathLower(tracePath).includes('/.pi/agent/sessions');
  const entrySignal = firstString(value, ['parentId', 'parent_id', 'sessionId', 'session_id', 'provider', 'modelId'])
    || firstString(message, ['provider', 'modelId', 'model', 'usage']);
  return type === 'message' && !!role && PI_MESSAGE_ROLES.has(role) && (!!entrySignal || pathSignal);
}

export function createPiSession(value: unknown, tracePath: string): ProviderSession | null {
  if (!isObject(value) || !hasPiSignal(value, tracePath)) return null;
  const identity = deriveIdentity(value, tracePath);
  return new PiSession(identity, syntheticHeader(identity, value));
}

export default createPiSession;
