// Regenerates the README screenshots from synthetic Codex sessions.
// Usage: npm run screenshots
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(projectRoot, 'docs', 'images');
const CWD = '/Users/demo/projects/demo-project';
const WINDOW = { width: 1440, height: 900 };
const MINUTE = 60_000;

const at = minutes => new Date(START + minutes * MINUTE).toISOString();
const START = Date.now() - 26 * MINUTE;

function record(minutes, type, payload) {
  return { timestamp: at(minutes), type, payload };
}

/** Builds one Codex rollout with cumulative token_count records. */
function session({ id, parent, model, effort, role, nickname, agentPath, steps, complete }) {
  const records = [
    record(steps[0]?.at ?? 0, 'session_meta', {
      id, cwd: CWD, model_provider: 'openai', model,
      thread_source: parent ? 'subagent' : 'user',
      ...(parent ? { parent_thread_id: parent, agent_role: role, agent_nickname: nickname, agent_path: agentPath } : {}),
    }),
    record(steps[0]?.at ?? 0, 'turn_context', { model, effort, collaboration_mode: { settings: { model, reasoning_effort: effort } } }),
  ];
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
  let call = 0;
  for (const step of steps) {
    if (step.user) records.push(record(step.at, 'event_msg', { type: 'user_message', message: step.user }));
    if (step.thinking) records.push(record(step.at, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: step.thinking }] }));
    if (step.say) records.push(record(step.at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step.say }] }));
    for (const tool of step.tools ?? []) {
      const callId = `${id}-call-${call += 1}`;
      records.push(record(step.at, 'response_item', { type: 'function_call', name: tool.name, call_id: callId, arguments: JSON.stringify(tool.args) }));
      records.push(record(step.at + (tool.seconds ?? 4) / 60, 'response_item', { type: 'function_call_output', call_id: callId, output: tool.output }));
    }
    if (step.usage) {
      const [input, cached, output] = step.usage;
      total.input_tokens += input;
      total.cached_input_tokens += cached;
      total.output_tokens += output;
      records.push(record(step.at + 0.2, 'event_msg', { type: 'token_count', info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output },
        total_token_usage: { ...total },
      } }));
    }
  }
  if (complete) records.push(record(complete, 'event_msg', { type: 'task_complete', message: 'Task completed' }));
  return records;
}

/** Evenly spaced usage steps so the charts show a steady working rhythm. */
function work(from, to, every, [input, cached, output], extra = {}) {
  const steps = [];
  for (let minute = from, index = 0; minute <= to; minute += every, index += 1) {
    const wobble = 1 + ((index * 37) % 11 - 5) / 25;
    steps.push({ at: minute, usage: [Math.round(input * wobble), Math.round(cached * wobble), Math.round(output * wobble)], ...(extra[index] ?? {}) });
  }
  return steps;
}

const ROOT = 'demo-root';
const subagents = [
  { id: 'demo-explorer', role: 'explorer', nickname: 'Repository explorer', model: 'gpt-5.6-luna', effort: 'medium', agentPath: '/root/explore', window: [2, 9], usage: [26000, 21000, 900], complete: 10,
    say: 'Mapped the dashboard entry points: `src/renderer/App.tsx` owns the graph and `src/renderer/TraceWorkspace.tsx` owns the trace reader.' },
  { id: 'demo-worker', role: 'worker', nickname: 'Feature implementation', model: 'gpt-5.6-terra', effort: 'high', agentPath: '/root/implement', window: [5, 21], usage: [34000, 27000, 1500], complete: 22,
    say: 'Implemented keyboard navigation for the run list and added filtering by provider.' },
  { id: 'demo-tester', role: 'tester', nickname: 'Test runner', model: 'gpt-5.6-luna', effort: 'medium', agentPath: '/root/test', window: [12, 24], usage: [22000, 18500, 700],
    say: 'Running the renderer and backend suites against the new filters.' },
  { id: 'demo-reviewer', role: 'reviewer', nickname: 'Code review', model: 'gpt-6-astra', effort: 'medium', agentPath: '/root/review', window: [14, 23], usage: [30000, 25500, 1100], complete: 24,
    say: 'Review complete. One suggestion: debounce the provider filter so fast typing does not refetch runs.' },
];

const rootSteps = work(0, 25, 1, [42000, 36000, 700], {
  0: {
    user: 'Add keyboard navigation and provider filtering to the run list, with tests.',
    thinking: 'Split the work: explore the renderer first, then implement, test, and review in parallel where possible.',
    say: 'I\'ll split this into four parallel tasks:\n\n1. **Explore** the renderer to find where runs are listed.\n2. **Implement** keyboard navigation and a provider filter.\n3. **Test** the new behavior.\n4. **Review** the change before merging.',
    tools: [
      { name: 'exec', args: { cmd: 'rg -n "run-item" src/renderer' }, output: 'src/renderer/App.tsx:855:            return <button key={run.id} type="button" className={`run-item ...`}\nsrc/renderer/styles.css:293:.run-item { position: relative; display: flex; ... }' },
      { name: 'spawn_agent', args: { role: 'explorer', task: 'Map the dashboard entry points' }, output: 'Spawned Repository explorer', seconds: 2 },
    ],
  },
  5: { say: 'The explorer found the run list in `App.tsx`. Starting the implementation.', tools: [{ name: 'spawn_agent', args: { role: 'worker', task: 'Implement keyboard navigation and provider filtering' }, output: 'Spawned Feature implementation', seconds: 2 }] },
  12: { say: 'Implementation is underway. Spawning a tester and checking types.', tools: [
    { name: 'spawn_agent', args: { role: 'tester', task: 'Run the test suites against the new filters' }, output: 'Spawned Test runner', seconds: 2 },
    { name: 'exec', args: { cmd: 'npm run typecheck' }, output: '> agent-monitor@0.1.0 typecheck\n> tsc --noEmit', seconds: 6 },
  ] },
  14: { say: 'Requesting a code review in parallel with testing.', tools: [{ name: 'spawn_agent', args: { role: 'reviewer', task: 'Review the change' }, output: 'Spawned Code review', seconds: 2 }] },
  24: {
    say: 'Implementation is ready:\n\n- Arrow keys move through runs; `Enter` loads the selected run.\n- The provider filter narrows runs without reloading traces.\n- `npm test` passes; review feedback on debouncing is applied.',
    tools: [{ name: 'exec', args: { cmd: 'npm test' }, output: '# tests 43\n# pass 43\n# fail 0', seconds: 9 }],
  },
});

const files = [
  { id: ROOT, records: session({ id: ROOT, model: 'gpt-6-astra', effort: 'medium', steps: rootSteps }) },
  ...subagents.map(agent => ({
    id: agent.id,
    records: session({
      ...agent,
      parent: ROOT,
      steps: work(agent.window[0], agent.window[1], 1, agent.usage, {
        0: { user: `Task from Build coordinator: ${agent.nickname.toLowerCase()}.`, say: agent.say, tools: [{ name: 'exec', args: { cmd: 'git status --short' }, output: ' M src/renderer/App.tsx' }] },
      }),
    }),
  })),
];

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-screenshots-'));
  let app;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    const dayDir = path.join(traceRoot, '2026', '09', '16');
    await mkdir(dayDir, { recursive: true });
    for (const file of files) {
      await writeFile(path.join(dayDir, `rollout-${file.id}.jsonl`), `${file.records.map(item => JSON.stringify(item)).join('\n')}\n`);
    }

    app = await electron.launch({
      executablePath: require('electron'),
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'user-data')}`],
      env: {
        ...process.env,
        AGENT_MONITOR_TRACE_ROOT: traceRoot,
        CODEX_HOME: path.join(tempRoot, 'codex-home'),
        HOME: path.join(tempRoot, 'home'),
        // Keep the root agent active while screenshots are taken.
        AGENT_MONITOR_IDLE_MS: String(60 * MINUTE),
      },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.run-item', { timeout: 30_000 });
    await page.waitForTimeout(800);
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setContentSize(size.width, size.height);
      window.center();
    }, WINDOW);
    await page.waitForTimeout(600);

    await page.locator('.run-item').first().click();
    await page.waitForSelector('.agent-node', { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: path.join(imagesDir, 'agent-graph.png') });

    await page.locator('.run-token-details summary').click();
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: path.join(imagesDir, 'token-usage.png') });
    await page.getByRole('tab', { name: /By model/ }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(imagesDir, 'token-usage-by-model.png') });
    await page.keyboard.press('Escape');

    const root = page.locator('.agent-node').filter({ hasText: 'Main agent' }).first();
    await root.locator('.agent-node__open').click();
    await page.waitForSelector('.trace-card', { timeout: 30_000 });
    await page.locator('.trace-tool__summary').first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(imagesDir, 'trace-view.png') });
    console.log(`Screenshots written to ${path.relative(projectRoot, imagesDir)}`);
  } finally {
    await app?.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
