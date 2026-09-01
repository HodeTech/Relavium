import { execFileSync } from 'node:child_process';
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

/** A child that spawns and never completes `initialize` — holds the CONNECT window open. */
const SILENT = fileURLToPath(
  new URL('../../../../packages/mcp/test-fixtures/silent-mcp-server.mjs', import.meta.url),
);

const silentServer = (id = 'silent'): McpServerRef => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [SILENT],
});

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

/**
 * The pids of live children running `fixture`, read from the process table.
 *
 * Needed because a cancelled connect never returns a client, so there is no `childPids` to read — the only
 * source of truth for "did the host reap what it spawned" is the table itself, which is also what ADR-0088
 * §11 asks for.
 */
function childPidsOf(fixture: string): number[] {
  // `-A`: the whole table, not just this terminal's session — the child is spawned detached from any tty.
  const listing = execFileSync('ps', ['-A', '-o', 'pid=,args=']).toString();
  const needle = fixture.slice(fixture.lastIndexOf('/') + 1);
  return listing
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

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
    // **Everything after the connect runs under a `finally`.** A failing assertion here used to leave a live
    // `SIGTERM`-trapping child behind, and this file's own later test filters the process table by fixture
    // name — so one red run seeded orphans that made the next run red for a different reason. The first test
    // in this file already had the guard; these two did not.
    try {
      const pid = client?.childPids[0];
      expect(typeof pid).toBe('number');

      // Drive the net directly rather than exiting this test process: the mechanism under test is the
      // callback, and a real `process.exit` here would take the runner with it.
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
      try {
        fireExitNet();
        // `kill` returns immediately; the process leaves the table a moment later.
        expect(await until(() => !alive(pid as number))).toBe(true);
      } finally {
        unguard();
      }
    } finally {
      await client?.close();
    }
  }, 30_000);

  it('the COOPERATIVE half reaps on a signal, and the run’s own teardown is not what did it', async () => {
    // The ordinary path: a signal arrives, `close()` runs, the child dies. Asserted with a `reapOnly` guard —
    // the shape `relavium run` uses — so a regression that made `reapOnly` skip the teardown as well as the
    // exit would redden here.
    const client = await connectAgentMcp([stubbornServer()], {
      cwd: process.cwd(),
      consentGate: allowAll,
    });
    try {
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
      try {
        fireSignal(2);
        expect(signalsSeen).toEqual([]); // the guard replaced the placeholder, so the guard is what ran
        // The SDK ladder takes up to ~4 s against a trapping child (stdin.end → 2 s → SIGTERM → 2 s →
        // SIGKILL), which is why the budget is generous and why the guard's own 3 s grace is NOT measured.
        expect(await until(() => !alive(pid as number))).toBe(true);
      } finally {
        unguard();
      }
    } finally {
      await client?.close();
    }
  }, 30_000);

  it('cancels an IN-FLIGHT connect and reaps the child spawned inside it', async () => {
    // **The branch a review found uncovered, and it is the one the whole ordering exists for.** The SDK spawns
    // the child inside `transport.start()`, so between the spawn and a completed `initialize` there is a live
    // process and no client — `McpClient.childPids` is still empty, so neither reaper has a pid, and the only
    // thing that can stop it is the connect signal itself.
    //
    // It was broken in a way that type-checked: the adapters took a `signal`, `startMcpClient` passed one, and
    // the CLI's own `open` closure was written `open: () => …`, which accepts the call and drops the argument.
    // A Ctrl-C during a cold `npx` therefore stopped nothing. The unit test asserts the signal's IDENTITY
    // reaches the opener; this one asserts what that buys — a real child, gone.
    const before = childPidsOf(SILENT);
    const cancel = new AbortController();
    const connecting = connectAgentMcp([silentServer()], {
      cwd: process.cwd(),
      consentGate: allowAll,
      connectSignal: cancel.signal,
    });
    // Wait for the spawn rather than assuming it — cancelling before it would prove nothing, and a fixed
    // 500 ms sleep is a bet on the runner. A cold `npx` on a loaded CI box loses that bet, and the failure
    // reads as "the cancel did not reap" when in fact nothing had been spawned yet.
    //
    // Only the pids THIS test spawned. Scanning the whole table for the fixture name also picks up orphans a
    // previous failing run left behind, which nothing will ever reap — a self-poisoning assertion that fails
    // for the wrong reason and then keeps failing.
    const newPids = (): number[] => childPidsOf(SILENT).filter((pid) => !before.includes(pid));
    expect(await until(() => newPids().length > 0)).toBe(true);
    const spawned = newPids();

    cancel.abort();
    await expect(connecting).rejects.toThrow();
    // The connect's own teardown reaps what it spawned; nothing else can, because no client was ever returned
    // and `childPids` is therefore empty. Budgeted well above the SDK's ~4.6 s ladder against a trapping child.
    expect(await until(() => spawned.every((pid) => !alive(pid)), 20_000)).toBe(true);
  }, 30_000);
});
