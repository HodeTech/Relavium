import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createNodeProcessCapability,
  ProcessCapabilityError,
  ProcessDeniedError,
  type NodeProcessCapabilityConfig,
} from './process.js';

/**
 * The node `process` capability is a 2.5.A security surface — the tests focus on the subprocess ENVIRONMENT
 * (no ambient-secret leak; declared-env merge; PATH-independent executable resolution), `shell:false`, and the
 * bounds (timeout, output cap, abort). Every test spawns the real `node` binary for cross-platform fidelity.
 */

const NODE = process.execPath;
let workspace: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'relavium-proc-')));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

function proc(over: Partial<NodeProcessCapabilityConfig> = {}): ReturnType<typeof createNodeProcessCapability> {
  return createNodeProcessCapability({ workspaceDir: workspace, ...over });
}

/** A signal whose `abort()` flips `aborted` and fires registered listeners (for mid-run abort tests). */
function controllableSignal(): {
  signal: { aborted: boolean; addEventListener: (t: 'abort', l: () => void) => void; removeEventListener: (t: 'abort', l: () => void) => void };
  abort: () => void;
} {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    signal: {
      get aborted() {
        return aborted;
      },
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
    },
    abort: () => {
      aborted = true;
      for (const l of [...listeners]) l();
    },
  };
}

describe('createNodeProcessCapability — execution', () => {
  it('runs a command and captures stdout + exit code', async () => {
    const r = await proc().spawn(NODE, ['-e', 'process.stdout.write("hello")'], {}, {});
    expect(r.stdout).toBe('hello');
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures a non-zero exit code (not a throw)', async () => {
    const r = await proc().spawn(NODE, ['-e', 'process.exit(3)'], {}, {});
    expect(r.exitCode).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await proc().spawn(NODE, ['-e', 'process.stderr.write("oops")'], {}, {});
    expect(r.stderr).toBe('oops');
  });

  it('passes args literally — shell:false, no metacharacter interpretation', async () => {
    // `&&` / `whoami` are inert literal argv entries, not shell operators (with `-e`, extra args start at argv[1]).
    const r = await proc().spawn(NODE, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '&&', 'whoami'], {}, {});
    expect(r.stdout).toBe('&&|whoami');
  });

  it('runs in the workspace dir by default', async () => {
    const r = await proc().spawn(NODE, ['-e', 'process.stdout.write(process.cwd())'], {}, {});
    expect(await realpath(r.stdout)).toBe(workspace);
  });
});

describe('createNodeProcessCapability — environment (no secret leak)', () => {
  it('does NOT pass an ambient secret env var to the subprocess, but DOES pass PATH', async () => {
    process.env['RELAVIUM_TEST_SECRET'] = 'do-not-leak';
    try {
      const r = await proc().spawn(
        NODE,
        ['-e', 'process.stdout.write(`${process.env.RELAVIUM_TEST_SECRET ?? "absent"}:${process.env.PATH ? "has-path" : "no-path"}`)'],
        {},
        {},
      );
      expect(r.stdout).toBe('absent:has-path'); // secret stripped, PATH (a non-secret essential) kept
    } finally {
      delete process.env['RELAVIUM_TEST_SECRET'];
    }
  });

  it('merges a SAFE engine-declared env var on top of the base env', async () => {
    const r = await proc().spawn(
      NODE,
      ['-e', 'process.stdout.write(process.env.MY_DECLARED ?? "none")'],
      { MY_DECLARED: 'declared-value' },
      {},
    );
    expect(r.stdout).toBe('declared-value');
  });

  it('resolves the executable via the AMBIENT PATH by bare name', async () => {
    // `node` is resolved to an absolute path against the ambient PATH, independent of any declared env.
    const r = await proc().spawn('node', ['-e', 'process.stdout.write("ran")'], {}, {});
    expect(r.stdout).toBe('ran');
  });

  it('REJECTS a forbidden declared env var (injection vectors + PATH) — fatal tool_denied', async () => {
    const fs = proc();
    for (const env of [{ NODE_OPTIONS: '--require /tmp/evil.js' }, { LD_PRELOAD: '/tmp/evil.so' }, { DYLD_INSERT_LIBRARIES: '/tmp/x' }, { PATH: '/nonexistent' }, { GIT_SSH_COMMAND: 'evil' }]) {
      await expect(fs.spawn(NODE, ['-e', '1'], env, {})).rejects.toBeInstanceOf(ProcessDeniedError);
    }
  });

  it('fails closed (FATAL tool_denied) when the command is not found on PATH', async () => {
    const err: unknown = await proc()
      .spawn('definitely-not-a-real-command-xyz', [], {}, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessDeniedError);
    if (err instanceof ProcessDeniedError) {
      expect(err.code).toBe('tool_denied');
      expect(err.retryable).toBe(false);
    }
  });

  it('rejects an empty command', async () => {
    await expect(proc().spawn('', [], {}, {})).rejects.toBeInstanceOf(ProcessDeniedError);
  });
});

describe('createNodeProcessCapability — bounds', () => {
  it('kills a command that exceeds the timeout (retryable ProcessCapabilityError, not a fatal denial)', async () => {
    const err: unknown = await proc()
      .spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], {}, { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessCapabilityError); // a timeout is transient → tool_failed (retryable)
    if (err instanceof ProcessCapabilityError) expect(err.message).toMatch(/timed out/);
  });

  it('caps the timeout at the configured ceiling', async () => {
    // maxTimeoutMs 100 clamps a tool-supplied 10s timeout, so the long process is still killed promptly.
    await expect(
      proc({ maxTimeoutMs: 100 }).spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], {}, { timeoutMs: 10_000 }),
    ).rejects.toThrow(/timed out/);
  });

  it('truncates output past the per-stream cap', async () => {
    const r = await proc({ maxBufferBytes: 10 }).spawn(
      NODE,
      ['-e', 'process.stdout.write("x".repeat(1000))'],
      {},
      {},
    );
    expect(r.stdout).toMatch(/truncated/);
    expect(r.stdout.startsWith('xxxxxxxxxx')).toBe(true); // the first 10 bytes survive
  });

  it('rejects on an already-aborted signal (no spawn)', async () => {
    const aborted = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };
    await expect(proc().spawn(NODE, ['-e', '1'], {}, {}, aborted)).rejects.toThrow(/abort/);
  });

  it('kills the process on a mid-run abort — rejects promptly, proving the kill landed', async () => {
    const { signal, abort } = controllableSignal();
    const started = Date.now();
    const pending = proc().spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], {}, {}, signal);
    setTimeout(abort, 50);
    await expect(pending).rejects.toThrow(/abort/);
    // If the child were NOT actually killed, `close` would not fire until the child's 10s timer — the prompt
    // rejection is the evidence the SIGKILL (of the whole process group) landed.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('truncates stderr past the per-stream cap (symmetric with stdout)', async () => {
    const r = await proc({ maxBufferBytes: 10 }).spawn(
      NODE,
      ['-e', 'process.stderr.write("y".repeat(1000))'],
      {},
      {},
    );
    expect(r.stderr).toMatch(/truncated/);
  });

  it('applies the configured defaultTimeoutMs when the call pins none', async () => {
    await expect(
      proc({ defaultTimeoutMs: 100 }).spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], {}, {}),
    ).rejects.toThrow(/timed out/);
  });
});

describe('createNodeProcessCapability — cwd + streams + signal exit', () => {
  it('resolves opts.cwd relative to the workspace', async () => {
    await mkdir(join(workspace, 'sub'), { recursive: true });
    const r = await proc().spawn(NODE, ['-e', 'process.stdout.write(process.cwd())'], {}, { cwd: 'sub' });
    expect(await realpath(r.stdout)).toBe(await realpath(join(workspace, 'sub')));
  });

  it('rejects a cwd that escapes the workspace — fatal tool_denied', async () => {
    await expect(proc().spawn(NODE, ['-e', '1'], {}, { cwd: '../../..' })).rejects.toBeInstanceOf(
      ProcessDeniedError,
    );
  });

  it('captures stdout and stderr independently in one run', async () => {
    const r = await proc().spawn(
      NODE,
      ['-e', 'process.stdout.write("OUT"); process.stderr.write("ERR")'],
      {},
      {},
    );
    expect(r.stdout).toBe('OUT');
    expect(r.stderr).toBe('ERR');
  });

  it('reports a non-zero exit for a process killed by an EXTERNAL signal (code null)', async () => {
    // The child SIGTERMs itself — our timer/abort never fire, so `close(null, "SIGTERM")` resolves with the
    // `code ?? 1` fallback (a signal-kill has a null exit code), never a misleading 0.
    const r = await proc().spawn(NODE, ['-e', 'process.kill(process.pid, "SIGTERM")'], {}, {});
    expect(r.exitCode).toBe(1);
  });
});
