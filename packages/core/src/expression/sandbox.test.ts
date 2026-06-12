/**
 * Expression-sandbox tests (1.AB). The security-critical paths — sandbox escape, forbidden globals,
 * cap enforcement, secret-free errors — are exercised **directly and adversarially**, per
 * docs/standards/testing.md (the dangerous input is exactly the one the happy path never runs).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { SandboxError } from '../errors.js';
import {
  createExpressionSandbox,
  type EvaluateInput,
  type ExpressionSandbox,
  type ExpressionScope,
} from './sandbox.js';

let sandbox: ExpressionSandbox;

beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function mkScope(partial?: Partial<ExpressionScope>): ExpressionScope {
  return { inputs: {}, ctx: {}, outputs: {}, ...partial };
}

/** Run an evaluation expected to fail, returning the thrown SandboxError. */
function evalError(input: EvaluateInput): SandboxError {
  try {
    sandbox.evaluate(input);
  } catch (error) {
    if (error instanceof SandboxError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the evaluation to throw a SandboxError');
}

describe('createExpressionSandbox — basic evaluation', () => {
  it('evaluates a boolean condition', () => {
    expect(sandbox.evaluate({ kind: 'condition', expression: '1 + 1 === 2', scope: mkScope() })).toBe(
      true,
    );
  });

  it('reads inputs, ctx, and run.outputs', () => {
    const scope = mkScope({
      inputs: { threshold: 7 },
      ctx: { mode: 'strict' },
      outputs: { scan: { score: 3 } },
    });
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: 'run.outputs["scan"].score < inputs.threshold && ctx.mode === "strict"',
        scope,
      }),
    ).toBe(true);
  });

  it('returns a reshaped object from a transform', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        expression: '{ doubled: inputs.n * 2 }',
        scope: mkScope({ inputs: { n: 21 } }),
      }),
    ).toEqual({ doubled: 42 });
  });

  it('exposes merge_fn branches in static order', () => {
    expect(
      sandbox.evaluate({
        kind: 'merge_fn',
        expression: '{ ...branches[0], ...branches[1] }',
        scope: mkScope({ branches: [{ a: 1 }, { b: 2 }] }),
      }),
    ).toEqual({ a: 1, b: 2 });
  });
});

describe('module reuse', () => {
  it('reuses the loaded wasm module across sandboxes', async () => {
    const a = await createExpressionSandbox();
    const b = await createExpressionSandbox();
    expect(a.evaluate({ kind: 'condition', expression: 'true', scope: mkScope() })).toBe(true);
    expect(b.evaluate({ kind: 'condition', expression: '1 === 1', scope: mkScope() })).toBe(true);
  });
});

describe('determinism — non-deterministic and I/O-bearing capabilities are absent', () => {
  const cases: Array<[string, string]> = [
    ['Date', 'typeof Date'],
    ['Promise', 'typeof Promise'],
    ['setTimeout', 'typeof setTimeout'],
    ['fetch', 'typeof fetch'],
    ['Proxy', 'typeof Proxy'],
  ];
  it.each(cases)('%s is undefined', (_name, expr) => {
    expect(sandbox.evaluate({ kind: 'condition', expression: expr, scope: mkScope() })).toBe(
      'undefined',
    );
  });

  it('calling Date throws (Date is not even defined)', () => {
    expect(evalError({ kind: 'condition', expression: 'Date.now() > 0', scope: mkScope() }).reason).toBe(
      'runtime',
    );
  });

  it('Math.random is neutralized — calling it throws', () => {
    expect(
      evalError({ kind: 'condition', expression: 'Math.random() >= 0', scope: mkScope() }).reason,
    ).toBe('runtime');
  });

  it('the rest of Math still works (deterministic)', () => {
    expect(
      sandbox.evaluate({ kind: 'condition', expression: 'Math.max(1, 2) === 2', scope: mkScope() }),
    ).toBe(true);
  });

  it('is a pure function of the scope (same scope → same result)', () => {
    const input: EvaluateInput = {
      kind: 'transform',
      expression: '{ total: run.outputs["a"].v + run.outputs["b"].v }',
      scope: mkScope({ outputs: { a: { v: 2 }, b: { v: 3 } } }),
    };
    expect(sandbox.evaluate(input)).toEqual(sandbox.evaluate(input));
  });
});

describe('sandbox escape is closed', () => {
  it('a __proto__ key in untrusted scope data cannot pollute the prototype chain', () => {
    // JSON.parse (not an object literal) installs `__proto__` as an OWN data property.
    const evil = JSON.parse('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: '({}).polluted === undefined && Object.prototype.polluted === undefined',
        scope: mkScope({ outputs: { x: evil } }),
      }),
    ).toBe(true);
  });

  // eval/Function exist inside the VM (evalCode needs the Eval intrinsic) but are contained: the wasm
  // isolation is the boundary, and nothing they run can reach a host reference or a forbidden
  // capability — so they are harmless. These assert containment, not absence.
  it('eval cannot reach a forbidden capability (Date stays absent through eval)', () => {
    expect(
      sandbox.evaluate({ kind: 'condition', expression: 'eval("typeof Date")', scope: mkScope() }),
    ).toBe('undefined');
  });

  it('the Function constructor cannot reach a forbidden capability', () => {
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: 'Function("return typeof Date")()',
        scope: mkScope(),
      }),
    ).toBe('undefined');
  });

  it('a function re-acquired via .constructor still reaches nothing dangerous', () => {
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: '(function () {}).constructor("return typeof fetch")()',
        scope: mkScope(),
      }),
    ).toBe('undefined');
  });
});

describe('resource caps are non-idempotent safety nets', () => {
  it('an infinite loop trips the wall-clock timeout (retryable)', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function () { while (true) {} })()',
      scope: mkScope(),
      limits: { timeoutMs: 50, memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024 },
    });
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('unbounded recursion trips the stack cap (fatal)', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function f() { return 1 + f(); })()',
      scope: mkScope(),
    });
    expect(error.reason).toBe('stack');
    expect(error.retryable).toBe(false);
  });

  it('runaway allocation trips the memory cap (fatal)', () => {
    const error = evalError({
      kind: 'transform',
      expression:
        '(function () { const a = []; for (;;) { a.push(new Array(100000).fill(0)); } })()',
      scope: mkScope(),
      limits: { timeoutMs: 2000, memoryBytes: 1024 * 1024, stackBytes: 256 * 1024 },
    });
    expect(error.reason).toBe('memory');
    expect(error.retryable).toBe(false);
  });
});

describe('result contract', () => {
  it('a condition returning a non-primitive is rejected', () => {
    expect(
      evalError({ kind: 'condition', expression: '({ a: 1 })', scope: mkScope() }).reason,
    ).toBe('result_type');
  });

  it.each([
    ['number', '3 + 4', 7],
    ['string', '"yes"', 'yes'],
    ['boolean', 'false', false],
  ])('a condition may return a %s', (_t, expr, expected) => {
    expect(sandbox.evaluate({ kind: 'condition', expression: expr, scope: mkScope() })).toBe(expected);
  });

  it('a transform returning undefined is rejected as non-serializable', () => {
    expect(
      evalError({ kind: 'transform', expression: 'undefined', scope: mkScope() }).reason,
    ).toBe('non_serializable');
  });

  it('a transform returning a function is rejected as non-serializable', () => {
    expect(
      evalError({ kind: 'transform', expression: '(function () {})', scope: mkScope() }).reason,
    ).toBe('non_serializable');
  });

  it('a transform returning a circular object is rejected as non-serializable', () => {
    expect(
      evalError({
        kind: 'transform',
        expression: '(function () { const a = {}; a.self = a; return a; })()',
        scope: mkScope(),
      }).reason,
    ).toBe('non_serializable');
  });

  it('a transform may return a JSON-serializable object', () => {
    expect(
      sandbox.evaluate({ kind: 'transform', expression: '({ ok: true, n: 1 })', scope: mkScope() }),
    ).toEqual({ ok: true, n: 1 });
  });
});

describe('error classification and message scrubbing', () => {
  it('a syntax error is fatal', () => {
    const error = evalError({ kind: 'condition', expression: '1 +', scope: mkScope() });
    expect(error.reason).toBe('syntax');
    expect(error.retryable).toBe(false);
  });

  it('a reference error is a fatal runtime error', () => {
    const error = evalError({ kind: 'condition', expression: 'nope.foo', scope: mkScope() });
    expect(error.reason).toBe('runtime');
    expect(error.code).toBe('sandbox_error');
  });

  it('the user-facing message never echoes a scope value (the value stays on detail)', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function () { throw inputs.token; })()',
      scope: mkScope({ inputs: { token: 'SENSITIVE-VALUE' } }),
    });
    expect(error.message).not.toContain('SENSITIVE-VALUE');
    expect(error.message).not.toContain('inputs.token');
    expect(error.detail).toContain('SENSITIVE-VALUE');
  });

  it('a thrown non-error value (number) is a runtime error, scrubbed from the message', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function () { throw 42; })()',
      scope: mkScope(),
    });
    expect(error.reason).toBe('runtime');
    expect(error.message).not.toContain('42');
    expect(error.detail).toBe('42');
  });

  it('a thrown plain object without name/message is a runtime error', () => {
    expect(
      evalError({
        kind: 'condition',
        expression: '(function () { throw {}; })()',
        scope: mkScope(),
      }).reason,
    ).toBe('runtime');
  });

  it('a non-serializable scope is reported as an engine/caller fault', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(
      evalError({
        kind: 'transform',
        expression: 'inputs',
        scope: mkScope({ inputs: { bad: circular } }),
      }).reason,
    ).toBe('scope');
  });
});

describe('limits', () => {
  it('a default-limits override passed to the factory is honored', async () => {
    const tight = await createExpressionSandbox({
      limits: { timeoutMs: 20, memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024 },
    });
    let thrown: unknown;
    try {
      tight.evaluate({
        kind: 'condition',
        expression: '(function () { while (true) {} })()',
        scope: mkScope(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SandboxError);
    expect((thrown as SandboxError).reason).toBe('timeout');
  });

  it('a per-evaluation limits override is honored', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function () { while (true) {} })()',
      scope: mkScope(),
      limits: { timeoutMs: 30, memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024 },
    });
    expect(error.reason).toBe('timeout');
  });
});
