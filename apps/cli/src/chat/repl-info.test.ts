import type { CompactionResult, TrimResult } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import {
  catalogNotice,
  clearedNotice,
  compactionNotice,
  costNotice,
  trimNotice,
} from './repl-info.js';

const entry = (slug: string, valid = true): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `${slug}.relavium.yaml`,
  valid,
});

describe('costNotice', () => {
  it('formats the cumulative spend in USD (micro-cents → $X.XXXX)', () => {
    expect(costNotice(0)).toBe('Session cost: $0.0000');
    expect(costNotice(5_000_000)).toBe('Session cost: $0.0500');
  });
});

describe('catalogNotice', () => {
  it('groups workflows + agents with counts; flags invalid entries (never drops them)', () => {
    const notice = catalogNotice([entry('deploy'), entry('broken', false)], [entry('coder')]);
    expect(notice).toContain('Workflows (2):');
    expect(notice).toContain('  deploy');
    expect(notice).toContain('  broken (invalid)');
    expect(notice).toContain('Agents (1):');
    expect(notice).toContain('  coder');
  });

  it('a single empty kind reads "none" (the other kind still lists)', () => {
    expect(catalogNotice([entry('deploy')], [])).toBe('Workflows (1):\n  deploy\nAgents: none');
  });

  it('an EMPTY project (both kinds empty) reads one clear, path-free line — distinct from "no project"', () => {
    expect(catalogNotice([], [])).toBe('No workflows or agents found in this project.');
  });

  it('sanitizes a slug so a crafted entry cannot inject control sequences into the notice', () => {
    const notice = catalogNotice([entry(`evil${String.fromCharCode(27)}[31m`)], []);
    expect(notice).not.toContain(String.fromCharCode(27)); // ESC stripped at the display boundary
  });
});

describe('compactionNotice / trimNotice (ADR-0062)', () => {
  it('reports the token deltas, the summariser spend, and the (sanitized) summary text', () => {
    const result: CompactionResult = {
      kind: 'compacted',
      reason: 'manual',
      summary: `we set up the db${String.fromCharCode(27)}[31m and the ipc bridge`,
      keptMessageCount: 2,
      tokensBefore: 14200,
      tokensAfter: 900,
      summaryTokens: { input: 14000, output: 340 },
    };
    const notice = compactionNotice(result);
    expect(notice).toContain('14,200'); // grouped token counts
    expect(notice).toContain('900');
    expect(notice).toContain('14,000 in / 340 out');
    expect(notice).toContain('we set up the db'); // the summary is inspectable (§7)
    expect(notice).not.toContain(String.fromCharCode(27)); // model output is control-sanitized
  });

  it('renders the non-compacted cases distinctly', () => {
    expect(compactionNotice({ kind: 'nothing_to_compact' })).toContain('already short');
    expect(compactionNotice({ kind: 'failed', message: 'no summary' })).toContain('Try /trim');
    expect(compactionNotice({ kind: 'cancelled' })).toContain('unchanged');
  });

  it('trimNotice reports the dropped/kept counts or a no-op', () => {
    const trimmed: TrimResult = { kind: 'trimmed', keptMessageCount: 20, droppedMessageCount: 8 };
    expect(trimNotice(trimmed)).toContain('Trimmed 8');
    expect(trimNotice(trimmed)).toContain('last 20');
    expect(trimNotice({ kind: 'nothing_to_trim', messageCount: 5 })).toContain('already within');
  });
});

describe('clearedNotice (ADR-0062 §7)', () => {
  it('names the prior session + the exact chat-resume command so it is discoverable', () => {
    const notice = clearedNotice('sess-42');
    expect(notice).toContain('fresh conversation');
    expect(notice).toContain('relavium chat-resume sess-42'); // the exact recovery command, not just the id
  });

  it('sanitizes a crafted session id (no terminal escape reaches the TTY)', () => {
    // `history.db` is shared with other surfaces whose ids are only non-empty strings, so a row may carry control
    // bytes — the notice must strip them (parity with the resume banner), never let one inject into the terminal.
    const notice = clearedNotice(`evil${String.fromCharCode(27)}]0;x${String.fromCharCode(7)}\nFAKE`);
    expect(notice).not.toContain(String.fromCharCode(27)); // no ESC survives
    expect(notice).not.toContain(String.fromCharCode(7)); // no BEL survives
    expect(notice).not.toContain('\n'); // the smuggled newline is collapsed — the notice stays one line
    expect(notice).toContain('relavium chat-resume'); // the static recovery text is intact
  });
});
