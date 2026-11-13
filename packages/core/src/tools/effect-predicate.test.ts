/**
 * `journaledTier` — which dispatches the journal records, and the trust boundary on the one flag that can
 * switch it off ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md);
 * [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §3).
 */

import { describe, expect, it } from 'vitest';

import { journaledTier } from './effect-predicate.js';
import { BUILTIN_TOOLS } from './builtins.js';
import type { ToolDef } from './types.js';

/** A minimal def — only the fields `journaledTier` reads carry meaning here. */
function defWith(overrides: Partial<ToolDef>): ToolDef {
  return {
    id: 'probe',
    source: 'builtin',
    description: '',
    parseArgs: (raw) => raw,
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    llmVisibleParams: { type: 'object' },
    dispatch: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe('journaledTier (ADR-0080 §3)', () => {
  it('a tool with no `effect` is never journaled', () => {
    expect(journaledTier(defWith({}), {})).toBeUndefined();
  });

  it('an effectful tool is journaled at the tier it declares for THAT call', () => {
    // A tool such as http_request can classify each validated call separately.
    const def = defWith({
      effect: (args) =>
        typeof args === 'object' && args !== null && 'post' in args && args.post === true
          ? 3
          : undefined,
    });
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
      expect(journaledTier(defWith({ effect: () => 3, duplicationBenign: true, source }), {})).toBe(
        3,
      );
    }
  });
});

function builtin(id: string): ToolDef {
  const found = BUILTIN_TOOLS.find((tool) => tool.id === id);
  if (found === undefined) throw new Error('missing builtin effect fixture');
  return found;
}
describe('ADR-0125 actual built-in effect assignments', () => {
  it.each([
    { path: 'new.txt', content: 'new' },
    { path: 'existing.txt', content: 'replacement', append: false },
    { path: 'existing.txt', content: 'replacement' },
    { path: 'existing.txt', content: 'tail', append: true },
    { path: 'existing.txt', content: '' },
    { path: 'existing.txt', content: 'unchanged', append: false },
    { path: 'parent/new.txt', content: '', createDirs: true },
  ])('journals every write_file variant %# at tier3', (args) => {
    const def = builtin('write_file');
    expect(journaledTier(def, def.parseArgs(args))).toBe(3);
  });
  it('keeps every edit tier3 and read-only file/GET calls unjournaled', () => {
    const cases = [
      { id: 'edit_file', args: { path: 'a', old_string: 'old', new_string: 'new' }, tier: 3 },
      { id: 'read_file', args: { path: 'a' }, tier: undefined },
      { id: 'list_directory', args: { path: '.' }, tier: undefined },
      { id: 'find_files', args: { glob: '*' }, tier: undefined },
      { id: 'search_files', args: { pattern: 'x' }, tier: undefined },
      { id: 'http_request', args: { url: 'https://api.example/x' }, tier: undefined },
      {
        id: 'http_request',
        args: { url: 'https://api.example/x', method: 'GET' },
        tier: undefined,
      },
      { id: 'http_request', args: { url: 'https://api.example/x', method: 'POST' }, tier: 3 },
    ];
    for (const entry of cases) {
      const def = builtin(entry.id);
      expect(journaledTier(def, def.parseArgs(entry.args))).toBe(entry.tier);
    }
  });
});
