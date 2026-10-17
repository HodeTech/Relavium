import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const register = fileURLToPath(
  new URL('../engine/fixtures/usage-coverage-crash-register.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./fixtures/native-invocation-child.ts', import.meta.url));

async function run(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-native-invocation-'));
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', '--import', register, fixture, mode, root],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, RELAVIUM_DEBUG: '1' },
    },
  );
  const input = child.stdin;
  const output = child.stdout;
  const errorOutput = child.stderr;
  if (input === null || output === null || errorOutput === null)
    throw new Error('fixture pipes missing');
  let stdout = '';
  let stderr = '';
  let watchdogFired = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    child.kill('SIGKILL');
  }, 9000);
  const collect = (sink: 'stdout' | 'stderr', chunk: Buffer) => {
    if (sink === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
    if (stdout.length + stderr.length > 32_768) child.kill('SIGKILL');
  };
  output.on('data', (chunk: Buffer) => collect('stdout', chunk));
  errorOutput.on('data', (chunk: Buffer) => collect('stderr', chunk));
  try {
    const ready = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once('message', () => resolve(true));
      }),
      closed.then(() => false),
    ]);
    expect(ready, stderr).toBe(true);
    if (mode === 'stdout-pipe') output.destroy();
    if (mode === 'stderr-pipe') errorOutput.destroy();
    child.send({ type: 'go' });
    const exit = await closed; // Native close joins the process and all inherited pipes.
    expect(watchdogFired, stderr).toBe(false);
    expect(exit.signal, stderr).toBeNull();
    expect(exit.code, stderr).toBe(9);
    const witness: unknown = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'));
    return { stdout, stderr, witness, touched: existsSync(join(root, 'getter-touched')) };
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    input.destroy();
    output.destroy();
    errorOutput.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('native coordinator fixture processes (explicit foundation installation)', () => {
  it('autonomous owner fault exits hung main at the common deadline without closing its actual owned SQLite DB', async () => {
    const result = await run('autonomous-db');
    expect(result.witness).toMatchObject({
      activeOwners: 1,
      stops: 1,
      dbOpen: true,
    });
    expect(result.witness).toHaveProperty('elapsed', expect.any(Number));
    const elapsed: unknown =
      typeof result.witness === 'object' && result.witness !== null
        ? Object.getOwnPropertyDescriptor(result.witness, 'elapsed')?.value
        : undefined;
    expect(elapsed).toBeGreaterThanOrEqual(2700);
    expect(elapsed).toBeLessThan(4100);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(''); // No async diagnosis starts at expiry.
  }, 12_000);

  it('does not renew three seconds after owner retirement while a synthetic diagnostic ACK stays held', async () => {
    const result = await run('held-ack');
    expect(result.witness).toMatchObject({ activeOwners: 0, stops: 1 });
    const elapsed: unknown =
      typeof result.witness === 'object' && result.witness !== null
        ? Object.getOwnPropertyDescriptor(result.witness, 'elapsed')?.value
        : undefined;
    expect(elapsed).toBeGreaterThanOrEqual(2700);
    expect(elapsed).toBeLessThan(4000); // A renewed budget after 1200ms retirement exits after 4200ms.
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: 'error', code: 'cli_internal' });
  }, 12_000);

  it('ACKs real restoration bytes before the one fixed final diagnostic', async () => {
    const result = await run('restoration');
    const restoration = '\u001b[?25h\u001b[?1049l';
    expect(result.witness).toMatchObject({ activeOwners: 0, stops: 1, restored: true });
    expect(result.stderr.startsWith(restoration)).toBe(true);
    const diagnostic = result.stderr.slice(restoration.length);
    expect(diagnostic.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(diagnostic)).toMatchObject({ type: 'error', code: 'cli_internal' });
    expect(result.stdout).toBe('');
  }, 12_000);

  it.each(['stdout-pipe', 'stderr-pipe'])(
    'observes actual %s EPIPE without diagnostic fallback to stdout',
    async (mode) => {
      const result = await run(mode);
      expect(result.stdout).toBe('');
      if (mode === 'stderr-pipe') expect(result.stderr).toBe('');
      else
        expect(JSON.parse(result.stderr)).toMatchObject({
          type: 'error',
          code: 'output_unavailable',
        });
    },
    12_000,
  );

  it('native uncaughtException hook ignores hostile message, cause, stack and coercion getters', async () => {
    const result = await run('fatal-opaque');
    expect(result.touched).toBe(false);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ type: 'error', code: 'cli_internal' });
    expect(result.stderr).not.toContain('secret');
  }, 12_000);
});
