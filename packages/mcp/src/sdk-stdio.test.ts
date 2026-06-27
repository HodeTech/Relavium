import { describe, expect, it } from 'vitest';

import { collectAllTools, MAX_TOOL_PAGES, type ToolListPage } from './sdk-stdio.js';

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
