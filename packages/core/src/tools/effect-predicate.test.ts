import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from './builtins.js';
import { journaledTier } from './effect-predicate.js';
import type { ToolDef } from './types.js';

/**
 * The journaling predicate (ADR-0080 §3). What matters here is the BOUNDARY: journaling too little loses the
 * guarantee, and journaling too much puts two durable writes on every read and halts runs on crashed GETs.
 */
const byId = (id: string): ToolDef => {
  const def = BUILTIN_TOOLS.find((t) => t.id === id);
  if (def === undefined) throw new Error(`no built-in ${id}`);
  return def;
};

describe('journaledTier — which dispatches are recorded', () => {
  it('a GET is NOT journaled; any other http method is', () => {
    // The per-call half of the predicate. A GET mutates nothing, and journaling it would cost two durable
    // writes per read and stop a run on a crashed fetch — an interruption rate paid for no guarantee.
    const http = byId('http_request');
    expect(journaledTier(http, { url: 'https://x/y' })).toBeUndefined(); // method defaults to GET
    expect(journaledTier(http, { url: 'https://x/y', method: 'GET' })).toBeUndefined();
    expect(journaledTier(http, { url: 'https://x/y', method: 'POST' })).toBe(3);
    expect(journaledTier(http, { url: 'https://x/y', method: 'DELETE' })).toBe(3);
  });

  it('an APPEND is journaled; a whole-file overwrite is not', () => {
    // Appends compose, so a replay doubles the content. An overwrite is naturally idempotent — the same
    // bytes twice leave the same file, and the file IS the receipt.
    const write = byId('write_file');
    expect(journaledTier(write, { path: 'a', content: 'x' })).toBeUndefined();
    expect(journaledTier(write, { path: 'a', content: 'x', append: true })).toBe(3);
  });

  it('notify is an effect but NOT journaled — benign under duplication', () => {
    // Declared, not excepted. The distinction matters: `notify` DOES mutate (it reaches the OS), so a
    // predicate that simply omitted it would be saying something false about the tool.
    const notify = byId('notify');
    expect(notify.effect?.({})).toBe(3); // it really is an effect…
    expect(notify.duplicationBenign).toBe(true);
    expect(journaledTier(notify, {})).toBeUndefined(); // …and still not worth a row
  });

  it('read-only tools declare no effect at all', () => {
    // The other side of the boundary. These are `governedAction` for SECURITY reasons — a clipboard read is
    // an exfiltration sink — but they mutate nothing, and the journal must not follow the security class.
    for (const id of ['read_file', 'list_directory']) {
      expect(byId(id).effect).toBeUndefined();
      expect(journaledTier(byId(id), { path: 'a' })).toBeUndefined();
    }
  });

  it('every mutating built-in is journaled, and nothing else is', () => {
    // The drift guard. A new side-effecting built-in that forgets `effect` would silently escape the journal
    // — exactly the gap CR-12 exists to close — and this list is what makes that a failing test rather than
    // a discovery in production.
    const journaled = BUILTIN_TOOLS.filter((t) => t.effect !== undefined)
      .map((t) => t.id)
      .sort();
    expect(journaled).toEqual(
      ['git_commit', 'http_request', 'mcp_call', 'notify', 'run_command', 'write_file'].sort(),
    );
  });

  it('duplicationBenign is claimed by exactly one tool', () => {
    // It is a trust-bearing declaration (first-party only, never from MCP metadata), so its membership is
    // pinned rather than left to grow quietly.
    expect(BUILTIN_TOOLS.filter((t) => t.duplicationBenign === true).map((t) => t.id)).toEqual([
      'notify',
    ]);
  });
});
