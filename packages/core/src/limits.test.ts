/**
 * ADR-0086's admission ceilings, tested where the decision put them.
 *
 * The two properties that carry the whole item, and the ones every case below is really about: a breach is a
 * REJECTION rather than a clamp, and the SAME validator answers for a workflow and for a standalone session.
 * A test that only checked "the number is enforced" would pass against an implementation that clamped, and
 * against one that enforced the agent ceilings on the workflow path alone — which is the shape this item was
 * one review away from shipping.
 */

import { describe, expect, it } from 'vitest';

import { buildRunPlan } from './dag.js';
import { WorkflowGraphError } from './errors.js';
import { ADMISSION_CEILINGS, DEFAULT_MAX_PARALLEL } from './limits.js';
import { parseWorkflow } from './parser.js';

/** A workflow with `count` trivially-connected nodes — the cheapest way to cross the node/edge ceilings. */
function chainOf(count: number, extra = ''): string {
  const nodes = Array.from({ length: count }, (_, i) =>
    i === 0
      ? `    - { id: n0, type: input }`
      : `    - { id: n${i}, type: transform, transform: 'g' }`,
  ).join('\n');
  const edges = Array.from(
    { length: count - 1 },
    (_, i) => `    - { from: n${i}, to: n${i + 1} }`,
  ).join('\n');
  return `schema_version: '1.0'
workflow:
  id: chain
${extra}  nodes:
${nodes}
  edges:
${edges}
`;
}

function issuesOf(yaml: string): { field: string; message: string; kind: string }[] {
  try {
    buildRunPlan(parseWorkflow(yaml));
    return [];
  } catch (error) {
    if (!(error instanceof WorkflowGraphError)) throw error;
    return [...error.issues];
  }
}

describe('ADR-0086 — admission ceilings on the workflow path', () => {
  it('admits a workflow at exactly the node ceiling and rejects the one past it', () => {
    // The boundary in both directions, because an off-by-one here is the difference between a limit and a
    // limit-minus-one that nobody notices until an author hits it.
    expect(issuesOf(chainOf(ADMISSION_CEILINGS.nodes))).toEqual([]);

    const over = issuesOf(chainOf(ADMISSION_CEILINGS.nodes + 1));
    const nodeIssue = over.find((i) => i.field === 'workflow.nodes');
    expect(nodeIssue?.kind).toBe('ceiling_exceeded');
    // The message carries the authored value AND the ceiling — a rejection that hides the number leaves the
    // author guessing which of their values tripped.
    expect(nodeIssue?.message).toContain(String(ADMISSION_CEILINGS.nodes + 1));
    expect(nodeIssue?.message).toContain(String(ADMISSION_CEILINGS.nodes));
  });

  it('rejects an over-ceiling `max_parallel` rather than clamping it (ADR-0086 §1)', () => {
    const over = issuesOf(chainOf(3, `  max_parallel: ${ADMISSION_CEILINGS.maxParallel + 1}\n`));
    const issue = over.find((i) => i.field === 'workflow.max_parallel');
    expect(issue?.kind).toBe('ceiling_exceeded');
    // **The load-bearing half.** A clamp would leave `issuesOf` empty and run the workflow at 64 — silently
    // running a committed file as something other than what it says, which is the behaviour ADR-0023 forbids
    // and which this assertion is the only thing standing between us and.
    expect(over).not.toEqual([]);
  });

  it('reports a node whose fan-out is too wide, naming the node', () => {
    const targets = Array.from(
      { length: ADMISSION_CEILINGS.fanOut + 1 },
      (_, i) => `    - { id: t${i}, type: transform, transform: 'g' }`,
    ).join('\n');
    const edges = Array.from(
      { length: ADMISSION_CEILINGS.fanOut + 1 },
      (_, i) => `    - { from: wide, to: t${i} }`,
    ).join('\n');
    const yaml = `schema_version: '1.0'
workflow:
  id: fan
  nodes:
    - { id: wide, type: input }
${targets}
  edges:
${edges}
`;
    const issue = issuesOf(yaml).find((i) => i.kind === 'ceiling_exceeded');
    expect(issue?.field).toContain('wide');
    expect(issue?.message).toContain(String(ADMISSION_CEILINGS.fanOut));
  });

  it('counts `parallel_of` members as fan-out — the same width authored a different way', () => {
    // **A bypass this implementation shipped with and a self-review caught before the round did.**
    // `parallel_of` materialises one fan-out edge per member inside the builder, with no `edges[]` entry, so
    // a fan-out check reading only `edges[]` saw a width of ZERO. Measured against the first version: a
    // 200-member split built a plan without tripping a ceiling of 50.
    const members = Array.from({ length: ADMISSION_CEILINGS.fanOut + 1 }, (_, i) => `m${i}`);
    const nodes = [
      `    - { id: start, type: input }`,
      `    - { id: split, type: parallel, parallel_of: [${members.join(', ')}] }`,
      ...members.map((m) => `    - { id: ${m}, type: transform, transform: 'g' }`),
    ].join('\n');
    const yaml = `schema_version: '1.0'
workflow:
  id: wide
  nodes:
${nodes}
  edges:
    - { from: start, to: split }
`;
    const issue = issuesOf(yaml).find((i) => i.kind === 'ceiling_exceeded');
    expect(issue?.field).toContain('split');
    expect(issue?.message).toContain(String(ADMISSION_CEILINGS.fanOut));
  });

  it("does NOT count a condition's branches as fan-out — they are alternatives, not width", () => {
    // The asymmetry with `parallel_of` above is deliberate and worth pinning: exactly one branch is taken,
    // so counting them as concurrent width would reject a wide `switch` that never runs more than one
    // target. A future reader tempted to "fix the inconsistency" should fail this test first.
    const branches = Array.from(
      { length: ADMISSION_CEILINGS.fanOut + 5 },
      (_, i) => `{ when: '${i}', target_node: b${i} }`,
    ).join(', ');
    const targets = Array.from(
      { length: ADMISSION_CEILINGS.fanOut + 5 },
      (_, i) => `    - { id: b${i}, type: transform, transform: 'g' }`,
    ).join('\n');
    const yaml = `schema_version: '1.0'
workflow:
  id: switchy
  nodes:
    - { id: start, type: input }
    - { id: pick, type: condition, expression_type: js, expression: 'x', branches: [${branches}] }
${targets}
  edges:
    - { from: start, to: pick }
`;
    expect(issuesOf(yaml).filter((i) => i.kind === 'ceiling_exceeded')).toEqual([]);
  });

  it('batches every ceiling breach instead of reporting the first', () => {
    // Admission faults are collected and thrown together, so an author fixes them in one pass. A validator
    // that returned early would satisfy every other test in this file.
    const yaml = chainOf(
      ADMISSION_CEILINGS.nodes + 1,
      `  max_parallel: ${ADMISSION_CEILINGS.maxParallel + 1}\n`,
    );
    const fields = issuesOf(yaml)
      .filter((i) => i.kind === 'ceiling_exceeded')
      .map((i) => i.field);
    expect(fields).toContain('workflow.nodes');
    expect(fields).toContain('workflow.max_parallel');
  });
});

describe('ADR-0086 — the NODE retry budget, which is the one the engine spends', () => {
  // **The bypass the first implementation shipped.** `#retryConfig` reads `node.retry ?? agent.retry` for an
  // agent node and `node.retry` alone for `condition`/`transform`/`merge`, so an agent-only check was
  // avoidable with one line of YAML — and the three non-agent types had no enforcement path at all.
  // Measured against that version: every case below was ADMITTED.
  const over = ADMISSION_CEILINGS.retryMax + 1;

  it.each([
    [
      'transform',
      `    - { id: n1, type: transform, transform: 'g', retry: { max: ${over}, backoff: exponential } }`,
    ],
    [
      'condition',
      `    - { id: n1, type: condition, expression_type: js, expression: 'x', branches: [{ when: true, target_node: n0 }], retry: { max: ${over}, backoff: exponential } }`,
    ],
  ])(
    'rejects an over-ceiling `retry.max` on a %s node, which has no agent at all',
    (_kind, node) => {
      const yaml = `schema_version: '1.0'
workflow:
  id: nodes-retry
  nodes:
    - { id: n0, type: input }
${node}
  edges:
    - { from: n0, to: n1 }
`;
      const issue = issuesOf(yaml).find((i) => i.kind === 'ceiling_exceeded');
      expect(issue?.field).toContain('n1');
      expect(issue?.field).toContain('retry.max');
    },
  );

  it('rejects an agent NODE that overrides an at-ceiling agent — the one-line bypass', () => {
    const yaml = `schema_version: '1.0'
workflow:
  id: override
  agents:
    - { id: a, model: m, provider: anthropic, system_prompt: hi, retry: { max: ${ADMISSION_CEILINGS.retryMax}, backoff: exponential } }
  nodes:
    - { id: n0, type: input }
    - { id: n1, type: agent, agent_ref: a, prompt_template: 'go', retry: { max: ${over}, backoff: exponential } }
  edges:
    - { from: n0, to: n1 }
`;
    // The agent is exactly AT the ceiling, so only the node-level check can catch this — which is the whole
    // point: an author who trips the agent ceiling would otherwise "fix" it by moving the value to the node.
    const issue = issuesOf(yaml).find((i) => i.kind === 'ceiling_exceeded');
    expect(issue?.field).toBe('node `n1`.retry.max');
  });
});

describe('ADR-0086 §3 — an omitted `max_parallel`', () => {
  it('is a finite constant, not Infinity', () => {
    // The value itself is the assertion: `Infinity` is the one number at which a concurrency cap governs
    // nothing, and it was the default. The engine reads this constant; the boundary case is covered by the
    // engine's own scheduling tests.
    expect(Number.isFinite(DEFAULT_MAX_PARALLEL)).toBe(true);
    expect(DEFAULT_MAX_PARALLEL).toBeLessThanOrEqual(ADMISSION_CEILINGS.maxParallel);
  });
});

describe('ADR-0086 §6 — one validator, two entry points', () => {
  // The session half of this pair lives in `agent-session.test.ts`, where the deps harness is — see
  // *"rejects an over-ceiling agent before any turn runs"*. Both halves must exist or neither proves the
  // shared validator: one path passing is exactly the drift ADR-0086 §6 is about.

  it('rejects the SAME agent on the workflow path, with the same kind', () => {
    // The pair is the assertion, not either half: an agent file admitted by `chat` and rejected by a
    // workflow that references it (or the reverse) is the drift one shared validator exists to prevent.
    const yaml = `schema_version: '1.0'
workflow:
  id: uses-greedy
  agents:
    - { id: greedy, model: claude-opus-4-8, provider: anthropic, system_prompt: hi, retry: { max: ${ADMISSION_CEILINGS.retryMax + 1}, backoff: exponential } }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: greedy, prompt_template: 'go' }
  edges:
    - { from: start, to: work }
`;
    const issue = issuesOf(yaml).find((i) => i.kind === 'ceiling_exceeded');
    expect(issue?.field).toContain('retry.max');
    // The workflow form names WHICH agent tripped; the session form does not, because it has only one.
    expect(issue?.field).toContain('greedy');
  });

  it('rejects an over-long fallback chain and every over-budget entry in it, not just the first', () => {
    const entries = Array.from(
      { length: ADMISSION_CEILINGS.fallbackChainEntries + 1 },
      () =>
        `{ model: m, provider: anthropic, max_attempts: ${ADMISSION_CEILINGS.chainEntryMaxAttempts + 1} }`,
    ).join(', ');
    const yaml = `schema_version: '1.0'
workflow:
  id: long-chain
  agents:
    - { id: laddered, model: claude-opus-4-8, provider: anthropic, system_prompt: hi, fallback_chain: [${entries}] }
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: laddered, prompt_template: 'go' }
  edges:
    - { from: start, to: work }
`;
    const fields = issuesOf(yaml)
      .filter((i) => i.kind === 'ceiling_exceeded')
      .map((i) => i.field);
    expect(fields.some((f) => f.endsWith('.fallback_chain'))).toBe(true);
    // Every entry, because an author fixing one per run is what batching exists to avoid.
    expect(fields.filter((f) => f.includes('max_attempts'))).toHaveLength(
      ADMISSION_CEILINGS.fallbackChainEntries + 1,
    );
  });
});
