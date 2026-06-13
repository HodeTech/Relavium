/**
 * Expression-sandbox tests (1.AB). The security-critical paths — sandbox escape, forbidden globals,
 * cap enforcement, secret-free errors — are exercised **directly and adversarially**, per
 * docs/standards/testing.md (the dangerous input is exactly the one the happy path never runs).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { SandboxError } from '../errors.js';
import {
  createExpressionSandbox,
  hostErrorToSandbox,
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
    expect(
      sandbox.evaluate({ kind: 'condition', expression: '1 + 1 === 2', scope: mkScope() }),
    ).toBe(true);
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
    expect(
      evalError({ kind: 'condition', expression: 'Date.now() > 0', scope: mkScope() }).reason,
    ).toBe('runtime');
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
    expect(sandbox.evaluate({ kind: 'condition', expression: expr, scope: mkScope() })).toBe(
      expected,
    );
  });

  it('a transform returning undefined is rejected as non-serializable', () => {
    expect(evalError({ kind: 'transform', expression: 'undefined', scope: mkScope() }).reason).toBe(
      'non_serializable',
    );
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

describe('classification keys on type, not author-controlled message text', () => {
  it.each([
    ['Error("…interrupted…")', '(function () { throw new Error("the job was interrupted"); })()'],
    [
      'Error("…stack overflow…")',
      '(function () { throw new Error("stack overflow happened"); })()',
    ],
    [
      'RangeError("…out of memory…")',
      '(function () { throw new RangeError("we ran out of memory"); })()',
    ],
    [
      'Error("…string too long…")',
      '(function () { throw new Error("the string too long anyway"); })()',
    ],
  ])('a thrown %s is a fatal runtime error, never a retryable timeout', (_label, expr) => {
    const error = evalError({ kind: 'condition', expression: expr, scope: mkScope() });
    expect(error.reason).toBe('runtime');
    expect(error.retryable).toBe(false);
  });

  it('the genuine wall-clock interrupt is the only retryable failure', () => {
    expect(
      evalError({
        kind: 'condition',
        expression: '(function () { while (true) {} })()',
        scope: mkScope(),
        limits: { timeoutMs: 20, memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024 },
      }).retryable,
    ).toBe(true);
  });
});

/** Build an object nested `depth` levels deep (`{ n: { n: … } }`) — drives the deep-scope rejection test. */
function deepObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    cur['n'] = next;
    cur = next;
  }
  return root;
}

describe('a pathologically deep value is a clean SandboxError, never a raw host throw', () => {
  it('a deeply-nested scope value is rejected as a SandboxError (not a host RangeError)', () => {
    const error = evalError({
      kind: 'condition',
      expression: 'true',
      scope: mkScope({ outputs: { deep: deepObject(20_000) } }),
    });
    expect(error).toBeInstanceOf(SandboxError);
    expect(error.reason).toBe('scope');
  });
});

describe('result serialization', () => {
  it('a transform returning a top-level BigInt is rejected as non-serializable', () => {
    expect(evalError({ kind: 'transform', expression: '2n ** 64n', scope: mkScope() }).reason).toBe(
      'non_serializable',
    );
  });

  // Map/Set→{} and NaN/Infinity→null are standard JSON.stringify semantics (documented in the spec
  // author guidance), so these pin the intentional lossy coercion rather than reject it.
  it('a Map result serializes to {} (JSON semantics)', () => {
    expect(
      sandbox.evaluate({ kind: 'transform', expression: 'new Map([["a", 1]])', scope: mkScope() }),
    ).toEqual({});
  });

  it('NaN/Infinity coerce to null (JSON semantics)', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        expression: '({ x: 0 / 0, y: 1 / 0, z: 5 })',
        scope: mkScope(),
      }),
    ).toEqual({ x: null, y: null, z: 5 });
  });
});

describe('determinism over scope ordering', () => {
  it('a sorted iteration is identical for equal-but-reordered run.outputs', () => {
    const expression = 'Object.keys(run.outputs).sort().join(",")';
    const first = sandbox.evaluate({
      kind: 'condition',
      expression,
      scope: mkScope({ outputs: { b: 1, a: 2, c: 3 } }),
    });
    const second = sandbox.evaluate({
      kind: 'condition',
      expression,
      scope: mkScope({ outputs: { c: 3, a: 2, b: 1 } }),
    });
    expect(first).toBe(second);
    expect(first).toBe('a,b,c');
  });

  it('an unsorted iteration follows insertion order (the pinned contract)', () => {
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: 'Object.keys(run.outputs).join(",")',
        scope: mkScope({ outputs: { b: 1, a: 2 } }),
      }),
    ).toBe('b,a');
  });

  it('merge_fn sees branches in static array order regardless of value', () => {
    expect(
      sandbox.evaluate({
        kind: 'merge_fn',
        expression: 'branches.map(function (b) { return b.id; }).join(",")',
        scope: mkScope({ branches: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }),
      }),
    ).toBe('x,y,z');
  });
});

describe('prototype-pollution containment (deep + cross-eval)', () => {
  it('a nested/deep __proto__ in untrusted scope cannot pollute the prototype chain', () => {
    const deepEvil = JSON.parse('{"a":{"b":{"__proto__":{"polluted":1}}}}') as Record<
      string,
      unknown
    >;
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: '({}).polluted === undefined && Object.prototype.polluted === undefined',
        scope: mkScope({ outputs: { x: deepEvil } }),
      }),
    ).toBe(true);
  });

  it('a within-eval prototype write does not leak to a separate evaluation', () => {
    // Within one evaluation the prototype is NOT frozen — the write succeeds but is contained by the
    // fresh runtime+context; a SEPARATE evaluation sees a clean prototype.
    sandbox.evaluate({
      kind: 'transform',
      expression: '(function () { ({}).constructor.prototype.leaked = 1; return {}; })()',
      scope: mkScope(),
    });
    expect(
      sandbox.evaluate({
        kind: 'condition',
        expression: 'Object.prototype.leaked === undefined',
        scope: mkScope(),
      }),
    ).toBe(true);
  });
});

describe('the VM surface matches the documented allow-list', () => {
  it.each(['Reflect', 'Symbol', 'WeakMap', 'WeakSet', 'Map', 'Set', 'JSON', 'RegExp', 'Math'])(
    '%s is present',
    (name) => {
      expect(
        sandbox.evaluate({
          kind: 'condition',
          expression: `typeof ${name} !== "undefined"`,
          scope: mkScope(),
        }),
      ).toBe(true);
    },
  );

  it.each([
    'Date',
    'Promise',
    'Proxy',
    'WeakRef',
    'FinalizationRegistry',
    'Intl',
    'setTimeout',
    'performance',
    'crypto',
    'fetch',
    'process',
    'require',
  ])('%s is absent', (name) => {
    expect(
      sandbox.evaluate({ kind: 'condition', expression: `typeof ${name}`, scope: mkScope() }),
    ).toBe('undefined');
  });

  it('Math is frozen — Math.random cannot be re-added inside an expression', () => {
    expect(
      evalError({
        kind: 'condition',
        expression:
          '(function () { Math.random = function () { return 0.5; }; return Math.random(); })()',
        scope: mkScope(),
      }).reason,
    ).toBe('runtime');
    expect(
      sandbox.evaluate({ kind: 'condition', expression: 'typeof Math.random', scope: mkScope() }),
    ).toBe('undefined');
  });
});

describe('error serialization safety', () => {
  it('a serialized SandboxError does not leak detail (non-enumerable)', () => {
    const error = evalError({
      kind: 'condition',
      expression: '(function () { throw inputs.token; })()',
      scope: mkScope({ inputs: { token: 'SENSITIVE-XYZ' } }),
    });
    expect(error.detail).toContain('SENSITIVE-XYZ'); // readable by an explicit logger
    expect(JSON.stringify(error)).not.toContain('SENSITIVE-XYZ'); // but not via naive serialization
  });
});

describe('createExpressionSandbox — PR-review regression cases', () => {
  it('evaluates an expression carrying a trailing line comment (own-line wrapping)', () => {
    // The author expression is emitted on its own line so a trailing `//` cannot comment out the
    // closing `);` (commit 9493ba5). An inline regression would break every such expression.
    expect(
      sandbox.evaluate({ kind: 'condition', expression: '1 + 1 === 2 // ok', scope: mkScope() }),
    ).toBe(true);
    expect(
      sandbox.evaluate({ kind: 'transform', expression: '({ a: 1 }) // note', scope: mkScope() }),
    ).toEqual({ a: 1 });
  });

  it('rejects an unterminated block comment as a syntax error', () => {
    expect(
      evalError({ kind: 'condition', expression: 'true /* unterminated', scope: mkScope() }).reason,
    ).toBe('syntax');
  });

  it('evaluates a multi-line merge_fn body (with a trailing comment)', () => {
    const expression = [
      '(function () {',
      '  const merged = {};',
      '  for (let i = 0; i < branches.length; i++) { Object.assign(merged, branches[i]); }',
      '  return merged; // combine the branch outputs',
      '})()',
    ].join('\n');
    expect(
      sandbox.evaluate({
        kind: 'merge_fn',
        expression,
        scope: mkScope({ branches: [{ a: 1 }, { b: 2 }] }),
      }),
    ).toEqual({ a: 1, b: 2 });
  });

  it('rejects a pathologically large expression before evalCode (bounds host parse overflow)', () => {
    // Deeply-nested parens around `1` — well over MAX_EXPRESSION_CHARS, the shape that would overflow
    // the host parser stack; the length bound rejects it cleanly as `syntax` first.
    const expression = `${'('.repeat(60_000)}1${')'.repeat(60_000)}`;
    expect(evalError({ kind: 'condition', expression, scope: mkScope() }).reason).toBe('syntax');
  });

  it('rejects a top-level boxed primitive as non_serializable (documented over-rejection)', () => {
    // `new String(...)` round-trips through JSON but the VM typeof is `object` while the marshaled
    // value is a primitive — the host validator rejects that mismatch (spec §Result contract).
    expect(
      evalError({ kind: 'transform', expression: 'new String("x")', scope: mkScope() }).reason,
    ).toBe('non_serializable');
  });

  it('classifies a non-serializable injected scope via the JSON.stringify-throw branch', () => {
    // A SHALLOW BigInt scope passes assertBoundedDepth, then JSON.stringify throws — exercising the
    // stringify-throw arm (distinct message), not the depth arm.
    const error = evalError({
      kind: 'transform',
      expression: '1',
      scope: mkScope({ inputs: { n: BigInt(5) } }),
    });
    expect(error.reason).toBe('scope');
    expect(error.message).toContain('could not be serialized');
  });

  it('hostErrorToSandbox classifies a raw host throw without leaking it (the evaluate boundary arm)', () => {
    // The `: hostErrorToSandbox(err)` arm of evaluate's catch (a raw host throw constructing the
    // runtime/context) is otherwise impractical to reach from a black-box test — unit-test the mapping.
    const passthrough = new SandboxError('timeout', 'x');
    expect(hostErrorToSandbox(passthrough)).toBe(passthrough); // a SandboxError passes through unchanged
    const stack = hostErrorToSandbox(new RangeError('Maximum call stack size exceeded'));
    expect(stack.reason).toBe('stack');
    const generic = hostErrorToSandbox(new Error('boom'));
    expect(generic.reason).toBe('runtime');
    expect(JSON.stringify(generic)).not.toContain('boom'); // detail is non-enumerable (secret-free)
  });
});
