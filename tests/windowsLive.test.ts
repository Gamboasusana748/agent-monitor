import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function header(id: string): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: {
      session_id: `session-${id}`,
      id,
      thread_source: 'user',
      cwd: '/tmp/windows-live',
      model_provider: 'openai',
      model: 'gpt-6-astra',
    },
  };
}

function message(text: string, timestamp?: string): Record<string, unknown> {
  return {
    type: 'response_item',
    ...(timestamp ? { timestamp } : {}),
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
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

async function setFileTimes(filePath: string, atimeMs: number, mtimeMs: number): Promise<void> {
  await utimes(filePath, atimeMs / 1_000, mtimeMs / 1_000);
}

type InternalWatcher = {
  emit(event: string, ...args: unknown[]): boolean;
  listeners(event: string): Array<(...args: unknown[]) => void>;
  on(event: string, listener: (...args: unknown[]) => void): InternalWatcher;
  removeAllListeners(event: string): InternalWatcher;
};

function watcherFor(monitor: TraceMonitor): InternalWatcher {
  const watcher = (monitor as unknown as { watcher?: InternalWatcher }).watcher;
  assert(watcher, 'monitor watcher should be ready');
  return watcher;
}

function emitRawChange(monitor: TraceMonitor, root: string, filePath: string): void {
  const watchedPath = path.relative(root, filePath);
  watcherFor(monitor).emit('raw', 'change', watchedPath, { watchedPath: root });
}

async function withFileChangeEventsMuted(monitor: TraceMonitor, action: () => Promise<void>): Promise<void> {
  const watcher = watcherFor(monitor);
  const listeners = [
    ...watcher.listeners('change').map((listener) => ['change', listener] as const),
    ...watcher.listeners('raw').map((listener) => ['raw', listener] as const),
  ];
  watcher.removeAllListeners('change');
  watcher.removeAllListeners('raw');
  try {
    await action();
  } finally {
    for (const [event, listener] of listeners) watcher.on(event, listener);
  }
}

test('a recent trace record keeps an initially loaded trace active with stale file times', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-timestamp-'));
  const runId = 'recent-record';
  const filePath = path.join(root, `${runId}.jsonl`);
  const recent = Date.now() - 500;
  const stale = recent - 120_000;
  await writeFile(filePath, `${line(header(runId))}${line(message('recent work', new Date(recent).toISOString()))}`);
  await setFileTimes(filePath, stale, stale);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    await monitor.loadRun(runId);
    const agent = monitor.snapshot().agents.find((item) => item.id === runId);
    assert(agent);
    assert.equal(agent.status, 'active');
    assert((agent.lastActivityAt ?? 0) > stale + 1_000);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows raw append updates the selected trace when mtime is frozen', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-raw-'));
  const runId = 'raw-selected';
  const filePath = path.join(root, `${runId}.jsonl`);
  const stale = Date.now() - 120_000;
  await writeFile(filePath, `${line(header(runId))}${line(message('first work'))}`);
  await setFileTimes(filePath, stale, stale);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    await monitor.loadRun(runId);
    const before = monitor.snapshot().agents.find((item) => item.id === runId);
    assert(before);

    await withFileChangeEventsMuted(monitor, async () => {
      await appendFile(filePath, line(message('raw append')));
      await setFileTimes(filePath, Date.now(), stale);
    });
    emitRawChange(monitor, root, filePath);
    await waitFor(() => monitor.getTrace(runId).then((entries) => entries.some((entry) => entry.text.includes('raw append'))));

    const after = monitor.snapshot().agents.find((item) => item.id === runId);
    assert(after);
    assert.equal(after.status, 'active');
    assert((after.lastActivityAt ?? 0) > (before.lastActivityAt ?? 0));
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('growth in an unselected trace advances its catalog activity time', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-catalog-'));
  const runId = 'catalog-growth';
  const filePath = path.join(root, `${runId}.jsonl`);
  const stale = Date.now() - 120_000;
  await writeFile(filePath, line(header(runId)));
  await setFileTimes(filePath, stale, stale);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    const before = monitor.snapshot().runs.find((run) => run.id === runId);
    assert(before);
    assert(before.lastActivityAt !== undefined);

    await appendFile(filePath, line(message('catalog update')));
    await setFileTimes(filePath, Date.now(), stale);
    watcherFor(monitor).emit('change', filePath);
    await waitFor(() => {
      const current = monitor.snapshot().runs.find((run) => run.id === runId);
      return current?.lastActivityAt !== undefined && current.lastActivityAt > (before.lastActivityAt ?? 0);
    });
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate raw and normal notifications do not refresh activity repeatedly', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-dedupe-'));
  const runId = 'dedupe-selected';
  const filePath = path.join(root, `${runId}.jsonl`);
  const stale = Date.now() - 120_000;
  await writeFile(filePath, `${line(header(runId))}${line(message('before append'))}`);
  await setFileTimes(filePath, stale, stale);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    await monitor.loadRun(runId);
    await withFileChangeEventsMuted(monitor, async () => {
      await appendFile(filePath, line(message('one append')));
      await setFileTimes(filePath, Date.now(), stale);
    });
    emitRawChange(monitor, root, filePath);
    watcherFor(monitor).emit('change', filePath);
    await waitFor(() => monitor.getTrace(runId).then((entries) => entries.some((entry) => entry.text.includes('one append'))));

    const updated = monitor.snapshot().agents.find((item) => item.id === runId);
    assert(updated?.lastActivityAt !== undefined);
    const activityAt = updated.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 30));
    emitRawChange(monitor, root, filePath);
    watcherFor(monitor).emit('change', filePath);
    emitRawChange(monitor, root, filePath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(monitor.snapshot().agents.find((item) => item.id === runId)?.lastActivityAt, activityAt);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows raw change tolerates a null filename and uses a file watchedPath', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-raw-null-'));
  const runId = 'raw-null';
  const filePath = path.join(root, `${runId}.jsonl`);
  const stale = Date.now() - 120_000;
  await writeFile(filePath, `${line(header(runId))}${line(message('before null append'))}`);
  await setFileTimes(filePath, stale, stale);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    await monitor.loadRun(runId);
    await withFileChangeEventsMuted(monitor, async () => {
      await appendFile(filePath, line(message('null filename append')));
      await setFileTimes(filePath, Date.now(), stale);
    });
    const watcher = watcherFor(monitor);
    assert.doesNotThrow(() => watcher.emit('raw', 'change', null, { watchedPath: filePath }));
    await waitFor(() => monitor.getTrace(runId).then((entries) => entries.some((entry) => entry.text.includes('null filename append'))));

    assert.doesNotThrow(() => watcher.emit('raw', 'change', null, { watchedPath: root }));
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows raw event retries a partial header when the record is completed', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-live-header-'));
  const runId = 'partial-header';
  const filePath = path.join(root, `${runId}.jsonl`);
  const complete = line(header(runId));
  const split = complete.length - 2;
  await writeFile(filePath, complete.slice(0, split));
  const monitor = new TraceMonitor({ roots: [root], idleMs: 10_000 });
  try {
    await monitor.start();
    assert.equal(monitor.snapshot().runs.some((run) => run.id === runId), false);
    await withFileChangeEventsMuted(monitor, async () => {
      await appendFile(filePath, complete.slice(split));
    });
    emitRawChange(monitor, root, filePath);
    await waitFor(() => monitor.snapshot().runs.some((run) => run.id === runId));
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});
