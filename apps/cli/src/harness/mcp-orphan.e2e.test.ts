import { fileURLToPath } from 'node:url';

import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { connectAgentMcp } from '../engine/mcp-servers.js';
import { guardMcpTeardown } from '../engine/mcp-signal-teardown.js';
import type { ResolvedStdioSpawn } from '../engine/mcp-consent.js';

/**
 * `#21` / [ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3 and §11 — **no orphan
 * process**, asserted against the actual child-process table rather than against a promise.
 *
 * A review of the first implementation made exactly this point: every test in
 * `engine/mcp-signal-teardown.test.ts` injects its signal source, its `exit` and its `kill`, so the suite
 * proves the guard's *wiring* and nothing about a real child. That is the test that would have stayed green
 * against the two defects this file now pins.
 *
 * The fixture is a server that **ignores stdin EOF and traps `SIGTERM`** — the class this guard's own header
 * names. It matters because the SDK's close ladder is `stdin.end()` → race(exit, 2 s) → `SIGTERM` →
 * race(exit, 2 s) → `SIGKILL`, so a well-behaved server dies on the first rung whatever the host does, and
 * cannot distinguish "the host reaped it" from "it was leaving anyway". This one survives every rung but the
 * last, so the assertion below is about the host.
 *
 * Deterministic and offline: a local Node child, no LLM, no provider key, no network.
 */
const STUBBORN = fileURLToPath(
  new URL('../../../../packages/mcp/test-fixtures/stubborn-mcp-server.mjs', import.meta.url),
);

const stubbornServer = (id = 'stubborn'): McpServerRef => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [STUBBORN],
});

/** A gate that consents to everything — the consent decision is ADR-0084's subject, not this file's. */
const allowAll = (
  refs: readonly McpServerRef[],
): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> => {
  const grants = new Map<string, ResolvedStdioSpawn>();
  for (const ref of refs) {
    if (ref.transport !== 'stdio') continue;
    grants.set(ref.id ?? '', {
      serverId: ref.id ?? '',
      provenance: { kind: 'inline' },
      command: ref.command ?? '',
      resolvedCommand: ref.command ?? '',
      args: [...(ref.args ?? [])],
      env: {},
      cwd: process.cwd(),
    });
  }
  return Promise.resolve(grants);
};

/** Is this pid still alive? `kill(pid, 0)` sends nothing and throws `ESRCH` once the process is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `predicate` holds, or give up — a reaped process leaves the table asynchronously. */
async function until(predicate: () => boolean, budgetMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('MCP orphan reaping — against the real child-process table', () => {
  it('surfaces the spawned child pid, so a host has something to reap', async () => {
    // The precondition for everything below, and a claim worth pinning on its own: before ADR-0088 the pid
    // never left `@relavium/mcp`, so a synchronous reap was not expressible at all.
    const client = await connectAgentMcp([stubbornServer()], {
      cwd: process.cwd(),
      consentGate: allowAll,
    });
    expect(client).toBeDefined();
    try {
      expect(client?.childPids).toHaveLength(1);
      const pid = client?.childPids[0];
      expect(typeof pid).toBe('number');
      expect(alive(pid as number)).toBe(true);
    } finally {
      await client?.close();
    }
  }, 30_000);

  it('the SYNCHRONOUS exit net kills a SIGTERM-trapping child — the path nobody awaits', async () => {
    // **The assertion the guard exists for.** `driveRun`'s second-Ctrl-C force-quit, the outermost crash net,
    // and any `process.exit` in the tree all terminate without awaiting `close()`. The cooperative half cannot
    // cover them; this one runs on `process.on('exit')` and must be synchronous, which is why it SIGKILLs a
    // pid rather than awaiting a transport.
    const client = await connectAgentMcp([stubbornServer()], {
      cwd: process.cwd(),
      consentGate: allowAll,
    });
    const pid = client?.childPids[0];
    expect(typeof pid).toBe('number');

    // Drive the net directly rather than exiting this test process: the mechanism under test is the callback,
    // and a real `process.exit` here would take the runner with it.
    let fireExitNet = (): void => undefined;
    const unguard = guardMcpTeardown(
      () => client?.close() ?? Promise.resolve(),
      () => client?.childPids ?? [],
      {
        subscribeSignals: () => () => undefined, // the cooperative half is the other test's subject
        subscribeProcessExit: (onExit) => {
          fireExitNet = onExit;
          return () => undefined;
        },
      },
    );

    fireExitNet();
    // `kill` returns immediately; the process leaves the table a moment later.
    expect(await until(() => !alive(pid as number))).toBe(true);
    unguard();
  }, 30_000);

  it('the COOPERATIVE half reaps on a signal, and the run’s own teardown is not what did it', async () => {
    // The ordinary path: a signal arrives, `close()` runs, the child dies. Asserted with a `reapOnly` guard —
    // the shape `relavium run` uses — so a regression that made `reapOnly` skip the teardown as well as the
    // exit would redden here.
    const client = await connectAgentMcp([stubbornServer()], {
      cwd: process.cwd(),
      consentGate: allowAll,
    });
    const pid = client?.childPids[0];
    expect(typeof pid).toBe('number');

    const signalsSeen: number[] = [];
    let fireSignal = (signo: number): void => {
      signalsSeen.push(signo);
    };
    const unguard = guardMcpTeardown(
      () => client?.close() ?? Promise.resolve(),
      () => client?.childPids ?? [],
      {
        subscribeSignals: (onSignal) => {
          fireSignal = onSignal;
          return () => undefined;
        },
        subscribeProcessExit: () => () => undefined, // the OTHER half must not be what reaps here
        reapOnly: true,
        exit: () => {
          throw new Error('reapOnly must not exit — driveRun owns this surface’s exit code');
        },
      },
    );

    fireSignal(2);
    expect(signalsSeen).toEqual([]); // the guard replaced the placeholder, so the guard is what ran
    // The SDK ladder takes up to ~4 s against a trapping child (stdin.end → 2 s → SIGTERM → 2 s → SIGKILL),
    // which is why the budget is generous and why the guard's own 3 s grace is NOT what is being measured.
    expect(await until(() => !alive(pid as number))).toBe(true);
    unguard();
  }, 30_000);
});
