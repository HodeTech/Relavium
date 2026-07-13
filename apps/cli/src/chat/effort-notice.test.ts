import { describe, expect, it } from 'vitest';

import {
  capUsd,
  effortRejectedNote,
  effortUnavailableNote,
  onceEffortNotice,
  unpricedModelNote,
} from './effort-notice.js';

/**
 * The withheld-tier notice channel (ADR-0071 §6) — the sentence, and the promise that it is said EXACTLY once.
 *
 * The gate turned a loud provider 400 into a quiet no-op. That is the better failure only if it is not quiet, and
 * an adversarial review found this channel wired at two of the nine places that build a session or an engine: a
 * `/clear`, a `/models` reseat, the bare Home, `agent run`, and `gate` all withheld in perfect silence.
 */
describe('effortRejectedNote — what the model refused, and what it would take', () => {
  it('names the refused tier AND the accepted ones, in canonical order', () => {
    const note = effortRejectedNote('gpt-5.4-pro', 'low', ['medium', 'high', 'max']);
    expect(note).toContain("does not accept reasoning effort 'low'");
    expect(note).toContain('it takes medium, high, max');
    expect(note).toContain('No tier is sent.'); // the consequence, stated — not left for the bill to reveal
  });

  it("re-sorts the gate's own list — its Set puts `off` LAST, the rows must not", () => {
    // `EffortGateResult.rejected.accepted` is `[...acceptedTiers(...)]`, and that Set adds `off` after the graded
    // tiers (it rides a different axis on three of the four providers). Printed raw it would read "high, off".
    expect(effortRejectedNote('claude-opus-4-8', 'max', ['high', 'off', 'low'])).toContain(
      'it takes off, low, high',
    );
  });

  it('degrades to the unavailable note when NOTHING is accepted — never "it takes " with an empty list', () => {
    expect(effortRejectedNote('deepseek-reasoner', 'high', [])).toBe(
      effortUnavailableNote('deepseek-reasoner'),
    );
  });

  it('SANITIZES the model id — it comes from an authored YAML, which only checks it is non-empty', () => {
    // `agent.model` is a bare `nonEmptyString` in the schema: no charset restriction. Two of the sinks write this
    // note RAW to a terminal (`relavium run` / `agent run` → stderr; a non-interactive `chat` → stderr), so an
    // escape sequence in a crafted workflow's model id would reach the terminal uninterpreted. `models.ts` already
    // guards the same class of input for the same reason (CWE-150).
    const note = effortRejectedNote('evil\u001b[31m\u0007model\nsecond-line', 'low', ['high']);
    expect(note).not.toContain('\u001b'); // no ESC — the CSI that would recolour the user's terminal
    expect(note).not.toContain('\u0007'); // no BEL
    expect(note).not.toContain('\n'); // and no newline, which would forge a second warning line of its own
    // ...and the LEGIBLE content survives (only control bytes are stripped), so it still names the model.
    expect(note).toContain('evil');
    expect(note).toContain('second-line');
  });
});

describe('effortUnavailableNote — the two empty lists are NOT the same sentence', () => {
  it('a model with no published knob will never have one — say so', () => {
    // `deepseek-reasoner` ships `reasoning: {}`: it reasons, and upstream describes no controllable tier.
    expect(effortUnavailableNote('deepseek-reasoner')).toContain(
      'publishes no controllable reasoning tier',
    );
  });

  it('a model MISSING from the catalog might just be newer than the snapshot — offer the fix', () => {
    // Same empty tier list, a different ACTION. The old id heuristic said "no reasoning control" for both, which
    // tells a user running a brand-new model nothing they can do about it.
    const note = effortUnavailableNote('some-custom-endpoint-model');
    expect(note).toContain('not in Relavium');
    expect(note).toContain('models refresh');
  });
});

describe('onceEffortNotice — a standing condition is not an event', () => {
  it('says it ONCE, however many turns consult the gate', () => {
    // The gate runs on every turn and every agent-node execution. A stale `off` bound on `gemini-2.5-pro` (which
    // cannot disable thinking at all) is withheld on turn one and on turn fifty — without this the transcript grows
    // a fresh copy of the same sentence every turn, and a workflow agent inside a `loop` prints it per iteration.
    const said: string[] = [];
    const sink = onceEffortNotice((note) => said.push(note));
    const note = effortUnavailableNote('gemini-2.5-pro');
    sink(note);
    sink(note);
    sink(note);
    expect(said).toEqual([note]);
  });

  it('…but a DIFFERENT condition still speaks up — it is a de-dup, not a mute', () => {
    // A `/models` reseat binds a new model; the tier that was fine a moment ago may not be. Suppressing that would
    // reintroduce the silence this whole channel exists to remove.
    const said: string[] = [];
    const sink = onceEffortNotice((note) => said.push(note));
    sink(effortRejectedNote('gpt-5.4-pro', 'low', ['medium', 'high']));
    sink(effortRejectedNote('gpt-5.4-pro', 'low', ['medium', 'high'])); // same → suppressed
    sink(effortRejectedNote('gpt-5-pro', 'low', ['high'])); // different model → spoken
    sink(effortRejectedNote('gpt-5.4-pro', 'off', ['medium', 'high'])); // different tier → spoken
    expect(said).toHaveLength(3);
  });
});

describe('capUsd + unpricedModelNote — the cost-cap notice (ADR-0071 §K7)', () => {
  it('formats a cap as fixed-decimal USD, never scientific notation', () => {
    expect(capUsd(5_000_000)).toBe('$0.05'); // the workflow-yaml-spec's own example cap
    expect(capUsd(1_000_000_000)).toBe('$10.00');
    expect(capUsd(1)).toBe('$0.00'); // a sub-cent cap rounds to $0.00 — NOT `$1e-8`, the bug this fixed
  });

  it('names the model, the cap, the fix, AND the surface-specific strict setting', () => {
    const chat = unpricedModelNote('my-local-model', 5_000_000, '[chat] strict_cost_cap');
    expect(chat).toContain('my-local-model');
    expect(chat).toContain('$0.05');
    expect(chat).toContain('models pricing my-local-model');
    expect(chat).toContain('[chat] strict_cost_cap'); // a chat user edits config.toml…

    const workflow = unpricedModelNote('my-local-model', 5_000_000, 'budget.strict_cost_cap');
    expect(workflow).toContain('budget.strict_cost_cap'); // …a workflow user edits the YAML
  });
});
