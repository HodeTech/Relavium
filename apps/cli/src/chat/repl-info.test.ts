import { LEGACY_COST_SENTINEL, type SessionCostRow } from '@relavium/db';
import type { CompactionResult, TrimResult } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import {
  catalogNotice,
  clearedNotice,
  compactionNotice,
  costNotice,
  trimNotice,
  modelSwitchNotice,
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
    expect(costNotice(0, [])).toBe('Session cost: $0.0000');
    expect(costNotice(5_000_000, [])).toBe('Session cost: $0.0500');
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
    const notice = clearedNotice(
      `evil${String.fromCharCode(27)}]0;x${String.fromCharCode(7)}\nFAKE`,
    );
    expect(notice).not.toContain(String.fromCharCode(27)); // no ESC survives
    expect(notice).not.toContain(String.fromCharCode(7)); // no BEL survives
    expect(notice).not.toContain('\n'); // the smuggled newline is collapsed — the notice stays one line
    expect(notice).toContain('relavium chat-resume'); // the static recovery text is intact
  });
});

/**
 * The `/models` switch MARKER (2.6.C — reshaped from ADR-0059's intro line).
 *
 * It used to introduce a reseated session that opened on a BLANK screen, so it announced the new model and told the
 * user what to do next. Now the conversation carries across the swap (F1) and the marker lands beneath it — so it
 * says what actually changed.
 *
 * The disclosure clause is the part ADR-0059 BINDS: a host-side reseat carries the transcript **text-only**, so the
 * new model does not see prior tool calls or file contents. Its Decision and Consequences both rest on that, so
 * dropping it is a superseding-ADR change, not a wording change. Pinned here so a future tidy-up cannot quietly
 * delete it.
 */
describe('modelSwitchNotice — the mid-session /models marker', () => {
  it('names BOTH ends of the switch', () => {
    expect(modelSwitchNotice('claude-sonnet-4-6', 'claude-opus-4-8')).toContain(
      'claude-sonnet-4-6 \u2192 claude-opus-4-8',
    );
  });

  it("RETAINS ADR-0059's bound disclosure (text-only transcript; no prior tool calls or file contents)", () => {
    const marker = modelSwitchNotice('a', 'b');
    expect(marker).toContain('text transcript only');
    expect(marker).toContain('not prior tool calls or file contents');
  });

  it('drops what the carried conversation makes redundant — the turn count and the intro tail', () => {
    const marker = modelSwitchNotice('a', 'b');
    expect(marker).not.toMatch(/prior turns? carried/);
    expect(marker).not.toContain('Type a message');
  });

  it('sanitizes BOTH ids — a live-catalog id is provider-sourced and history.db is shared across surfaces', () => {
    const marker = modelSwitchNotice(`old\u001b[31m`, `new\u001b]0;pwned`);
    expect(marker).not.toContain('\u001b');
  });
});

/**
 * THE `/cost` PER-MODEL BREAKDOWN (ADR-0070 §7).
 *
 * `/cost` is a money surface, and the one guarantee it makes is that the rows sum to the total. The table's invariant
 * (`SUM(session_costs) == agent_sessions.total_cost_microcents`) is what makes that guarantee real; these tests pin
 * the panel's half of it — and the two honesties it must carry: an unpriced model is not a free one, and a legacy
 * session predates attribution rather than having used a single model.
 */
describe('costNotice — the per-model breakdown', () => {
  const row = (over: Partial<SessionCostRow> & { model: string }): SessionCostRow => ({
    modelCatalogId: undefined,
    inputTokens: 100,
    outputTokens: 200,
    costMicrocents: 0,
    callCount: 1,
    unpricedCalls: 0,
    isLegacy: false,
    ...over,
  });

  it('with no rows it is the total alone — a session that has not spent says so in one line', () => {
    expect(costNotice(0, [])).toBe('Session cost: $0.0000');
  });

  it('renders one line per model, and the ROWS SUM TO THE TOTAL the panel shows', () => {
    const rows = [
      row({ model: 'claude-opus-4-8', costMicrocents: 7500, callCount: 3 }),
      row({ model: 'claude-sonnet-4-6', costMicrocents: 2500, callCount: 1 }),
    ];
    const out = costNotice(10_000, rows);
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('75%'); // the share is of the authoritative total
    expect(out).toContain('25%');
    // The invariant, restated at the surface: what the rows add up to is what the total says.
    const summed = rows.reduce((n, r) => n + r.costMicrocents, 0);
    expect(summed).toBe(10_000);
  });

  it('an UNPRICED row says so — a $0.0000 row with real tokens must never read as a free model', () => {
    const out = costNotice(0, [
      row({ model: 'gpt-5.4-pro', costMicrocents: 0, callCount: 2, unpricedCalls: 2 }),
    ]);
    expect(out).toContain('price unknown for 2 of 2 calls');
    expect(out).toContain('300 tok'); // the tokens were real, even though the money is unknown
  });

  it('a PARTIALLY unpriced row still flags the unpriced calls (2.6.Q can price a model mid-session)', () => {
    const out = costNotice(500, [
      row({ model: 'gpt-5.4-pro', costMicrocents: 500, callCount: 5, unpricedCalls: 2 }),
    ]);
    expect(out).toContain('price unknown for 2 of 5 calls');
  });

  it('a LEGACY session renders its aggregate honestly — not as a single-model session', () => {
    const out = costNotice(4200, [
      row({
        model: LEGACY_COST_SENTINEL,
        isLegacy: true,
        costMicrocents: 4200,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(out).toContain('breakdown unavailable');
    expect(out).not.toContain('calls'); // its counts are structurally 0 — it must never claim them
  });

  it('a CUSTOM model named exactly like the sentinel is a REAL row — the flag identifies legacy, not the string', () => {
    // `model` is the raw provider id, and a custom/self-hosted model may be named anything — so no string can be
    // reserved. If the panel branched on the string, this user's real spend would render as "breakdown unavailable"
    // and their calls and tokens would vanish from a money surface. The row carries `isLegacy: false`; that decides.
    const out = costNotice(3000, [
      row({ model: LEGACY_COST_SENTINEL, isLegacy: false, costMicrocents: 3000, callCount: 4 }),
    ]);
    expect(out).not.toContain('breakdown unavailable');
    expect(out).toContain('(4 calls, 300 tok)'); // its real work, attributed to it
  });

  it('a RESUMED legacy session that spends AGAIN keeps the sentinel honest beside its real model rows', () => {
    // The likeliest way a user meets this table — and the case a panel-level (rows.length === 1) special case misses.
    // Rendered through the normal path the sentinel would print `$0.0420  40%  …  (0 calls, 0 tok)`: real money, zero
    // calls, zero tokens, with the "unavailable" disclosure gone from the panel entirely.
    const out = costNotice(10_000, [
      row({ model: 'claude-opus-4-8', costMicrocents: 6000, callCount: 3 }),
      row({
        model: LEGACY_COST_SENTINEL,
        isLegacy: true,
        costMicrocents: 4000,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('(3 calls'); // the REAL row keeps its counts
    expect(out).toContain('breakdown unavailable'); // …and the sentinel still discloses, even beside real rows
    expect(out).not.toContain('0 calls, 0 tok'); // it never claims counts it structurally cannot have
  });

  it('sanitizes the model id — it is provider-sourced and history.db is shared across surfaces', () => {
    const out = costNotice(100, [row({ model: `evil[31m`, costMicrocents: 100 })]);
    expect(out).not.toContain('');
  });
});
