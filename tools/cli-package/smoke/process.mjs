import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_OUTPUT_BYTES = 524288;
export function explicitEnvironment(home, temporary, extra = {}) {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  };
}

export function startOwned(args, { cwd, env, timeout = 30000 }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '',
    bytes = 0,
    failure;
  let settled = false;
  const done = new Promise((resolve) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  const capture = (kind, chunk) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) {
      failure ??= new Error('Installed smoke output byte ceiling exceeded');
      child.kill('SIGKILL');
      return;
    }
    if (kind === 'stdout') stdout += chunk.toString();
    else stderr += chunk.toString();
  };
  child.stdout.on('data', (chunk) => capture('stdout', chunk));
  child.stderr.on('data', (chunk) => capture('stderr', chunk));
  child.stdin.on('error', (error) => {
    failure ??= error;
  });
  const timer = setTimeout(() => {
    failure ??= new Error('Installed smoke child deadline exceeded');
    child.kill('SIGKILL');
  }, timeout);
  const joined = done.then((exit) => {
    clearTimeout(timer);
    return { ...exit, stdout, stderr, bytes };
  });
  return {
    child,
    output: () => ({ stdout, stderr, bytes }),
    isSettled: () => settled,
    async result() {
      const result = await joined;
      if (failure) throw new Error(`${failure.message}\n${stderr}`, { cause: failure });
      return result;
    },
    async close() {
      if (!settled) child.kill('SIGKILL');
      await joined;
      clearTimeout(timer);
    },
  };
}

export async function invoke(args, options, input = '') {
  const owned = startOwned(args, options);
  try {
    owned.child.stdin.end(input);
    return await owned.result();
  } finally {
    await owned.close();
  }
}
export function assertExit(result, code) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, code, result.stderr);
}
export function ndjson(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export async function poll(predicate, milliseconds, explanation) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.ok(await predicate(), explanation);
}
