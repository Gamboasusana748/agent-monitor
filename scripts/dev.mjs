// Starts the Vite dev server, then Electron pointed at the exact URL Vite bound.
// Vite falls back to the next free port when 5173 is taken, and Electron never
// connects to a different project's server that happens to own the default port.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const electronPath = createRequire(import.meta.url)('electron');

const server = await createServer({ server: { strictPort: false } });
await server.listen();
server.printUrls();

const url = server.resolvedUrls?.local[0];
if (!url) {
  await server.close();
  throw new Error('Vite did not report a local URL.');
}

// Extra CLI arguments pass through to Electron, e.g. `npm run dev -- --inspect`.
const electron = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (electron.exitCode === null && electron.signalCode === null) {
    electron.kill();
    // Electron shuts down gracefully; force it if it has not exited shortly after.
    const forced = setTimeout(() => electron.kill('SIGKILL'), 5000);
    await new Promise((resolve) => electron.once('exit', resolve));
    clearTimeout(forced);
  }
  await server.close();
  process.exit(code);
}

electron.on('exit', (code) => void stop(code ?? 0));
electron.on('error', (error) => {
  console.error(error);
  void stop(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0));
