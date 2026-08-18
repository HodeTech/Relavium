/**
 * `journaledTier` — which dispatches the journal records, and the trust boundary on the one flag that can
 * switch it off ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md);
 * [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §3).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { journaledTier } from './effect-predicate.js';
import type { ToolDef } from './types.js';

/** A minimal def — only the fields `journaledTier` reads carry meaning here. */
function defWith(overrides: Partial<ToolDef>): ToolDef {
  return {
    id: 'probe',
    source: 'builtin',
    description: '',
    policyClass: 'read_only',
    params: z.object({}),
    llmVisibleParams: { type: 'object' },
    dispatch: () => Promise.resolve(undefined),
    ...overrides,
  } as ToolDef;
}

describe('journaledTier (ADR-0080 §3)', () => {
  it('a tool with no `effect` is never journaled', () => {
    expect(journaledTier(defWith({}), {})).toBeUndefined();
  });

  it('an effectful tool is journaled at the tier it declares for THAT call', () => {
    // Two tools answer per call rather than per definition (`http_request` by method, `write_file` by
    // append), which is why the decision takes the validated args.
    const def = defWith({ effect: (args) => ((args as { post?: boolean }).post === true ? 3 : undefined) });
    expect(journaledTier(def, { post: true })).toBe(3);
    expect(journaledTier(def, { post: false })).toBeUndefined();
  });

  it('`duplicationBenign` suppresses the row for a FIRST-PARTY built-in', () => {
    expect(
      journaledTier(defWith({ effect: () => 3, duplicationBenign: true, source: 'builtin' }), {}),
    ).toBeUndefined();
  });

  it('…and is IGNORED on anything that is not a built-in — the trust boundary', () => {
    // THE assertion this file was written for. The flag suppresses the journal outright, so an MCP server
    // that got it set — through a future descriptor mapping, a merged def, or a bug — could opt its own
    // effects out of the one record that prevents duplicates. A review measured that removing the
    // `source === 'builtin'` clause left all 1,228 core tests green: the boundary was enforced only by a
    // doc comment. The mapper is separately pinned never to SET the flag; this pins the READER.
    for (const source of ['mcp', 'plugin'] as const) {
      expect(
        journaledTier(defWith({ effect: () => 3, duplicationBenign: true, source }), {}),
      ).toBe(3);
    }
  });
});
