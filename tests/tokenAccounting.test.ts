import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';
import { createClaudeSession } from '../src/traces/claude';
import { createPiSession } from '../src/traces/pi';
import { UsageAccumulator } from '../src/traces/usage-accounting';
import type { ProviderSession } from '../src/traces/provider-common';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function canonical(session: ProviderSession, values: unknown[]): unknown[] {
  const records: unknown[] = [];
  values.forEach((value, index) => {
    records.push(...session.normalize(value, index));
  });
  return records;
}

function tokenRecord(
  timestamp: string,
  info: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'event_msg', timestamp, payload: { type: 'token_count', info } };
}

test('cumulative Codex usage deduplicates, splits model changes, and keeps historical baseline unattributed', () => {
  const accumulator = new UsageAccumulator();
  accumulator.add({ type: 'session_meta', payload: { model: 'model-a', model_provider: 'openai', service_tier: 'standard' } });
  accumulator.add({ type: 'turn_context', payload: { turn_id: 'turn-a', model: 'model-a', model_provider: 'openai', service_tier: 'standard' } });
  const first = {
    turn_id: 'turn-a',
    last_token_usage: { input_tokens: 20, output_tokens: 2 },
    total_token_usage: { input_tokens: 100, output_tokens: 10 },
  };
  accumulator.add(tokenRecord('2026-01-01T00:00:10Z', first));
  accumulator.add(tokenRecord('2026-01-01T00:00:11Z', first));
  accumulator.add({ type: 'turn_context', payload: { turn_id: 'turn-b', model: 'model-b', model_provider: 'openai', service_tier: 'flex' } });
  accumulator.add(tokenRecord('2026-01-01T00:01:10Z', {
    turn_id: 'turn-b',
    last_token_usage: { input_tokens: 30, output_tokens: 3 },
    total_token_usage: { input_tokens: 130, output_tokens: 13 },
  }));

  const usage = accumulator.snapshot().tokenUsage;
  assert.deepEqual(usage.find((entry) => entry.model === 'model-a'), {
    model: 'model-a', provider: 'openai', serviceTier: 'standard',
    inputTokens: 20, outputTokens: 2, requestInputTokens: 20,
  });
  assert.deepEqual(usage.find((entry) => entry.model === 'model-b'), {
    model: 'model-b', provider: 'openai', serviceTier: 'flex',
    inputTokens: 30, outputTokens: 3, requestInputTokens: 30,
  });
  assert.deepEqual(usage.find((entry) => entry.model === 'unknown'), {
    model: 'unknown', inputTokens: 80, outputTokens: 8,
  });
  assert.deepEqual(accumulator.snapshot().tokenTimeline, [
    { timestamp: Date.parse('2026-01-01T00:00:00Z'), inputTokens: 20, outputTokens: 2 },
    { timestamp: Date.parse('2026-01-01T00:01:00Z'), inputTokens: 30, outputTokens: 3 },
  ]);
});

test('cumulative reset starts a new segment without duplicating repeated totals or cache fields', () => {
  const accumulator = new UsageAccumulator();
  const add = (input: number, output: number, cacheRead: number) => accumulator.add(tokenRecord('2026-01-01T00:00:10Z', {
    turn_id: 'turn',
    last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cacheRead },
    total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cacheRead },
  }));
  add(40, 4, 2);
  add(40, 4, 2);
  add(45, 5, 3);
  add(5, 1, 0);
  add(8, 2, 0);

  const usage = accumulator.snapshot().tokenUsage;
  assert.equal(usage.reduce((sum, entry) => sum + entry.inputTokens, 0), 53);
  assert.equal(usage.reduce((sum, entry) => sum + entry.outputTokens, 0), 7);
  assert.equal(usage.reduce((sum, entry) => sum + (entry.cacheReadTokens ?? 0), 0), 3);
  assert.deepEqual(accumulator.totals(), { inputTokens: 53, outputTokens: 7 });
});

test('Claude and Pi split message usage revisions by stable id and preserve cache TTL metadata', () => {
  const claudeValues = [
    {
      type: 'assistant', sessionId: 'claude-s', uuid: 'c-1',
      message: {
        id: 'message-1', role: 'assistant', model: 'claude-a', provider: 'anthropic',
        content: [{ type: 'text', text: 'first' }],
        usage: {
          input_tokens: 10, output_tokens: 2, cached_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 3 },
        },
      },
    },
    {
      type: 'assistant', sessionId: 'claude-s', uuid: 'c-1-revision',
      message: {
        id: 'message-1', role: 'assistant', model: 'claude-a', provider: 'anthropic',
        content: [{ type: 'text', text: 'revision' }],
        usage: {
          input_tokens: 10, output_tokens: 5, cached_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 3 },
        },
      },
    },
    {
      type: 'assistant', sessionId: 'claude-s', uuid: 'c-2',
      message: {
        id: 'message-2', role: 'assistant', model: 'claude-b', provider: 'anthropic',
        content: [{ type: 'text', text: 'second model' }],
        usage: {
          input_tokens: 8, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 4 },
        },
      },
    },
  ];
  const claude = createClaudeSession(claudeValues[0], '/tmp/.claude/projects/claude-s.jsonl');
  assert(claude);
  const accumulator = new UsageAccumulator();
  canonical(claude, claudeValues).forEach((record, index) => accumulator.add(record, index));
  const usage = accumulator.snapshot().tokenUsage;
  assert.deepEqual(usage.find((entry) => entry.model === 'claude-a'), {
    model: 'claude-a', provider: 'anthropic', inputTokens: 17, outputTokens: 5,
    cacheReadTokens: 4, cacheWriteTokens: 3, cacheWrite5mTokens: 3, requestInputTokens: 17,
  });
  assert.deepEqual(usage.find((entry) => entry.model === 'claude-b'), {
    model: 'claude-b', provider: 'anthropic', inputTokens: 12, outputTokens: 1,
    cacheWriteTokens: 4, cacheWrite1hTokens: 4, requestInputTokens: 12,
  });

  const piValue = {
    type: 'message', id: 'pi-message',
    message: {
      role: 'assistant', model: 'pi-model', provider: 'openai', content: 'pi',
      usage: { input_tokens: 6, output_tokens: 1 },
    },
  };
  const piRevision = {
    ...piValue,
    message: { ...piValue.message, usage: { input_tokens: 7, output_tokens: 2 } },
  };
  const pi = createPiSession({ type: 'session', version: 3, id: 'pi-s', provider: 'openai', modelId: 'pi-model' }, '/tmp/.pi/agent/sessions/pi-s.jsonl');
  assert(pi);
  const piAccumulator = new UsageAccumulator();
  canonical(pi, [{ type: 'session', version: 3, id: 'pi-s', provider: 'openai', modelId: 'pi-model' }, piValue, piRevision])
    .forEach((record, index) => piAccumulator.add(record, index));
  assert.deepEqual(piAccumulator.snapshot().tokenUsage.find((entry) => entry.model === 'pi-model'), {
    model: 'pi-model', provider: 'openai', inputTokens: 7, outputTokens: 2, requestInputTokens: 7,
  });
});

test('missing cache metadata remains distinct from an explicitly reported zero', () => {
  const accumulator = new UsageAccumulator();
  accumulator.add({ type: 'turn_context', payload: { model: 'model', provider: 'provider' } });
  accumulator.add(tokenRecord('2026-01-01T00:00:00Z', {
    usage_id: 'missing-cache', last_token_usage: { input_tokens: 10, output_tokens: 1 },
  }));
  accumulator.add(tokenRecord('2026-01-01T00:01:00Z', {
    usage_id: 'known-zero-cache', last_token_usage: {
      input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
    },
  }));
  const usage = accumulator.snapshot().tokenUsage;
  assert.equal(usage.length, 2);
  assert.equal(usage.some((entry) => entry.cacheReadTokens === undefined && entry.cacheWriteTokens === undefined), true);
  assert.equal(usage.some((entry) => entry.cacheReadTokens === 0 && entry.cacheWriteTokens === 0), true);
});

test('usage survives the bounded trace window and snapshot clones nested counters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-token-accounting-'));
  const records: unknown[] = [{
    type: 'session', version: 3, id: 'large', cwd: '/tmp/token-accounting', provider: 'openai', modelId: 'pi-model',
  }];
  for (let index = 0; index < 650; index += 1) {
    records.push({
      type: 'message', id: `message-${index}`,
      message: { role: 'assistant', model: 'pi-model', content: `answer-${index}`, usage: { input_tokens: 1, output_tokens: 2 } },
    });
  }
  await writeFile(path.join(root, 'large.jsonl'), records.map(line).join(''));
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    await monitor.loadRun('pi:large');
    const snapshot = monitor.snapshot();
    const agent = snapshot.agents[0];
    assert(agent?.tokenUsage);
    assert.deepEqual(agent.tokenUsage.find((entry) => entry.model === 'pi-model'), {
      model: 'pi-model', provider: 'openai', inputTokens: 650, outputTokens: 1_300, requestInputTokens: 1,
    });
    assert.equal(agent.stats.inputTokens, 650);
    assert.equal(agent.stats.outputTokens, 1_300);
    assert.equal((await monitor.getTrace('pi:large')).length <= 200, true);
    agent.tokenUsage[0].inputTokens = 0;
    assert.equal(monitor.snapshot().agents[0]?.tokenUsage?.[0]?.inputTokens === 0, false);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});
