import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from './sandbox.js';
import { literalOutputReads } from './literal-output-reads.js';

/**
 * The soundness invariant, paired with the only witness that can settle it.
 *
 * ADR-0093 §2 justifies a regex scan over a parser with one property: it never produces a FALSE REFUSAL.
 * That claim was asserted in the ADR, in the module docblock, and in a commit message, and pinned by no
 * test that could fail — and two review rounds then found SEVEN shapes that violated it.
 *
 * A false refusal is not a property of the scanner alone: it is a DISAGREEMENT between the scanner and the
 * sandbox. So each case below is checked twice — the scanner must name nothing, and the same expression
 * must evaluate in the REAL sandbox with an EMPTY `run.outputs`, which is what proves the read is not
 * there. A scanner-only assertion would just be restating the scanner's behaviour back to itself.
 */
let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

const NOT_SCOPE_READS: ReadonlyArray<{ readonly why: string; readonly expression: string }> = [
  { why: 'a `run` property on another object', expression: 'inputs.a.run.outputs["ghost"]' },
  { why: 'the same, separated by whitespace', expression: 'inputs.a . run.outputs["ghost"]' },
  { why: 'the same, through optional chaining', expression: 'inputs.a ?. run.outputs["ghost"]' },
  { why: 'the same, with a comment between', expression: 'inputs.a./* c */run.outputs["ghost"]' },
  {
    why: 'a Unicode identifier ending in `run`',
    expression: '({["çrun"]: {outputs: {ghost: 1}}}).çrun.outputs["ghost"]',
  },
  {
    why: 'a parameter named `run` shadowing the scope',
    expression: '((run) => run.outputs["ghost"])(inputs.shadow)',
  },
  {
    why: 'a destructured `run` shadowing the scope',
    expression: '(({ shadow: run }) => run.outputs["ghost"])(inputs)',
  },
  { why: 'an access inside a string', expression: '"run.outputs[\'ghost\']".length' },
  { why: 'an access inside a comment', expression: '1 /* run.outputs["ghost"] */' },
  { why: 'an access inside a nested template', expression: '(`${`run.outputs["ghost"]`}`).length' },
];

describe('the scan never disagrees with the sandbox (ADR-0093 §2 soundness)', () => {
  for (const c of NOT_SCOPE_READS) {
    it(`says nothing about ${c.why}`, () => {
      expect(literalOutputReads(c.expression).map((r) => r.id)).toEqual([]);
    });

    it(`…and the sandbox confirms it reads no scope output: ${c.why}`, () => {
      // An EMPTY `run.outputs`. If the expression genuinely read the scope it would see `undefined` and
      // either throw on dereference or produce a different value; evaluating cleanly here is the evidence
      // that the scan's silence was correct rather than lucky.
      const value = sandbox.evaluate({
        expression: c.expression,
        kind: 'transform',
        scope: {
          inputs: { a: { run: { outputs: { ghost: 1 } } }, shadow: { outputs: { ghost: 1 } } },
          ctx: {},
          outputs: {},
        },
      });
      expect(value).toBeDefined();
    });
  }

  it('and still refuses the genuine article', () => {
    // The other half of soundness: silence everywhere would also pass every case above.
    expect(literalOutputReads('run.outputs["real"] === 1').map((r) => r.id)).toEqual(['real']);
    expect(literalOutputReads('run?.outputs?.["real"]').map((r) => r.id)).toEqual(['real']);
    expect(literalOutputReads('run.outputs.real').map((r) => r.id)).toEqual(['real']);
  });
});
