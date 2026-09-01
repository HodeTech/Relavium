import { describe, expect, it, vi } from 'vitest';

import {
  collectAllTools,
  MAX_TOOL_PAGES,
  openStdioConnection,
  type ToolListPage,
} from './sdk-stdio.js';

describe('collectAllTools (tools/list pagination)', () => {
  it('follows nextCursor across pages and aggregates every tool (not just page 1)', async () => {
    const pages: Record<string, ToolListPage> = {
      undefined: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'c1' },
      c1: {
        tools: [
          { name: 'b', inputSchema: {} },
          { name: 'c', inputSchema: {} },
        ],
        nextCursor: 'c2',
      },
      c2: { tools: [{ name: 'd', inputSchema: {} }] }, // no nextCursor ⇒ the last page
    };
    const tools = await collectAllTools((cursor) => Promise.resolve(pages[String(cursor)]!));
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('maps description (omitted when absent) + inputSchema', async () => {
    const tools = await collectAllTools(() =>
      Promise.resolve({
        tools: [{ name: 'x', description: 'hi', inputSchema: { type: 'object' } }],
      }),
    );
    expect(tools).toEqual([{ name: 'x', description: 'hi', inputSchema: { type: 'object' } }]);
  });

  it('fails closed when a hostile server never exhausts the cursor (bounded by MAX_TOOL_PAGES)', async () => {
    await expect(
      collectAllTools(() =>
        Promise.resolve({ tools: [{ name: 'loop', inputSchema: {} }], nextCursor: 'again' }),
      ),
    ).rejects.toThrow(String(MAX_TOOL_PAGES));
  });
});

describe('the pid latch stops looking when its registration is released (ADR-0088 §1.3)', () => {
  /**
   * **The poll had no owner, and unref'd is what hid it.** `latchPid` clears its own interval once a pid
   * appears — but a spawn that FAILS never produces one, and `ENOENT` on a typo'd `command` is the ordinary
   * case. So a failed connect left a 20 ms poller running for the life of the process, once per attempt.
   * Measured before the fix: three failed spawns, 42 poll invocations in the following 300 ms, still climbing.
   *
   * `process.getActiveResourcesInfo()` does NOT report unref'd handles, which is why the first attempt at
   * this test saw a delta of zero and looked clean. Counting the interval's own work is the observation that
   * distinguishes "stopped" from "invisible".
   */
  it('stops polling after a spawn that never produced a pid', async () => {
    vi.useFakeTimers();
    try {
      await openStdioConnection('nope', {
        command: '/nonexistent/relavium-latch-probe',
        env: {},
      }).catch(() => undefined);
      // Past `releaseAfterTeardown`'s window, so the registration — and with it the poll — is released.
      await vi.advanceTimersByTimeAsync(10_000);
      const before = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(1_000);
      // A live 20 ms interval re-arms itself forever, so it is still counted after any advance.
      expect(before).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
