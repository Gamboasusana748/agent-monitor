import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('timed out waiting for monitor update'));
        return;
      }
      setTimeout(() => void tick(), 20);
    };
    void tick();
  });
}

function claudeUser(sessionId: string, text: string): Record<string, unknown> {
  return {
    type: 'user', sessionId, uuid: `${sessionId}:user`, cwd: '/tmp/provider-fixture',
    message: { role: 'user', content: text },
  };
}

function claudeAssistant(sessionId: string, text: string, index = 1): Record<string, unknown> {
  return {
    type: 'assistant', sessionId, uuid: `${sessionId}:assistant:${index}`,
    message: {
      role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
}

function piSession(sessionId: string): Record<string, unknown> {
  return {
    type: 'session', version: 3, id: sessionId, cwd: '/tmp/provider-fixture',
    provider: 'openai', modelId: 'pi-test',
  };
}

function piAssistant(sessionId: string, index: number): Record<string, unknown> {
  return {
    type: 'message', id: `${sessionId}:assistant:${index}`,
    message: {
      role: 'assistant', model: 'pi-test', content: [{ type: 'text', text: `answer-${index}` }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
}

function codexHeader(sessionId: string): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: {
      session_id: sessionId, id: `codex-${sessionId}`, thread_source: 'user', cwd: '/tmp/provider-fixture',
      model_provider: 'openai', model: 'gpt-6-astra',
    },
  };
}

test('mixed provider inventory is lazy and selection namespaces provider ids', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-providers-'));
  await writeFile(path.join(root, 'claude.jsonl'), line(claudeUser('shared', 'inspect Claude')));
  await writeFile(path.join(root, 'pi.jsonl'), line(piSession('shared')));
  await writeFile(path.join(root, 'hermes.jsonl'), line({
    ...claudeUser('shared', 'inspect Hermes'), version: 'hermes-agent',
  }));
  await writeFile(path.join(root, 'codex.jsonl'), line(codexHeader('shared')));
  const monitor = new TraceMonitor({ roots: [root], idleMs: 500 });
  try {
    await monitor.start();
    const runIds = monitor.snapshot().runs.map((run) => run.id);
    assert.deepEqual(monitor.snapshot().agents, []);
    assert.equal(runIds.includes('claude:shared'), true);
    assert.equal(runIds.includes('pi:shared'), true);
    assert.equal(runIds.includes('hermes:shared'), true);
    assert.equal(runIds.includes('codex-shared'), true);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider append updates the selected normalized trace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-provider-append-'));
  const filePath = path.join(root, 'claude.jsonl');
  await writeFile(filePath, line(claudeUser('append', 'first')));
  const monitor = new TraceMonitor({ roots: [root], idleMs: 500 });
  try {
    await monitor.start();
    await monitor.loadRun('claude:append');
    assert.equal(monitor.snapshot().agents[0]?.harness, 'claude');
    await appendFile(filePath, line(claudeAssistant('append', 'second')));
    await waitFor(() => monitor.getTrace('claude:append').then((entries) => entries.some((entry) => entry.text.includes('second'))));
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('unloadRun releases provider traces while preserving inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-provider-release-'));
  await writeFile(path.join(root, 'pi.jsonl'), `${line(piSession('release'))}${line(piAssistant('release', 1))}`);
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    await monitor.loadRun('pi:release');
    assert.equal((await monitor.getTrace('pi:release')).length > 0, true);
    monitor.unloadRun();
    assert.deepEqual(monitor.snapshot().agents, []);
    assert.equal(monitor.snapshot().runs.some((run) => run.id === 'pi:release'), true);
    assert.deepEqual(await monitor.getTrace('pi:release'), []);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider aggregate metrics survive the retained history window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-provider-history-'));
  const sessionId = 'history';
  const records = [piSession(sessionId)];
  for (let index = 0; index < 650; index += 1) records.push(piAssistant(sessionId, index));
  await writeFile(path.join(root, 'pi.jsonl'), records.map(line).join(''));
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    await monitor.loadRun('pi:history');
    const agent = monitor.snapshot().agents[0];
    assert(agent);
    assert.deepEqual(agent.stats, { inputTokens: 650, outputTokens: 1_300, toolCalls: 0, errors: 0 });
    assert.equal((await monitor.getTrace('pi:history')).length <= 200, true);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});
