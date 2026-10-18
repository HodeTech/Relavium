/** ADR-0113 regressions execute the installed QuickJS VM, including its finite latch limit. */
import { beforeAll, describe, expect, it } from 'vitest';

import { SandboxError } from '../errors.js';
import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import { buildExpressionProgram } from './program.js';
import {
  createExpressionSandbox,
  DEFAULT_SANDBOX_LIMITS,
  type EvaluateInput,
  type ExpressionKind,
  type ExpressionSandbox,
  type ExpressionScope,
} from './sandbox.js';

const CANARY = 'private-input-canary-ADR0113-never-in-QuickJS';
const kinds: ExpressionKind[] = ['condition', 'transform', 'merge_fn'];
let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function scope(): ExpressionScope {
  return {
    inputs: { public: 'available', credential: CANARY },
    ctx: createWorkflowContextProjection({
      values: { first: 'alpha', last: 'omega' },
      deniedKeys: ['derived'],
      orderedKeys: ['first', 'derived', 'last'],
    }),
    deniedInputNames: ownSecretInputNames(['credential', 'optional']).deniedInputNames,
    outputs: { upstream: { count: 7 } },
    branches: [{ id: 'first' }, { id: 'second' }],
  };
}

function failure(input: EvaluateInput): SandboxError {
  let caught: unknown;
  try {
    sandbox.evaluate(input);
  } catch (error) {
    caught = error;
  }
  expect(caught, 'VM_CLASSIFIED_REFUSAL').toBeInstanceOf(SandboxError);
  if (!(caught instanceof SandboxError)) throw caught;
  return caught;
}

function expectDenial(expression: string, kind: ExpressionKind = 'transform'): void {
  const error = failure({ expression, kind, scope: scope() });
  expect(error).toMatchObject({
    code: 'sandbox_error',
    reason: 'secret_context',
    retryable: false,
    message: 'secret-derived values are unavailable to expressions',
  });
  expect(error.detail).toBeUndefined();
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(CANARY);
  expect(error.stack).not.toContain(CANARY);
}

describe('denied values in the real expression VM', () => {
  const reads = [
    'ctx.derived',
    'ctx[["der", "ived"].join("")]',
    'JSON.stringify(ctx)',
    'ctx',
    '({ nested: [ctx] })',
    '({ ...ctx })',
    'Object.values(ctx)',
    '(() => { try { return ctx.derived; } catch { return "caught"; } })()',
    '({ get value() { try { return ctx.derived; } catch { return "caught"; } } })',
    '({ toJSON() { try { return ctx.derived; } catch { return { ok: true }; } } })',
    'inputs.credential',
    'inputs[["creden", "tial"].join("")]',
    'JSON.stringify(inputs)',
    'inputs',
    '(() => { try { return inputs.credential; } catch { return true; } })()',
    'Object.getOwnPropertyDescriptor(ctx, "derived").get()',
    'Object.getOwnPropertyDescriptor(inputs, "credential").get()',
    'Reflect.get(ctx, "derived")',
  ];
  for (const kind of kinds) {
    it.each(reads)(
      `${kind}: observed read refuses even through catch/serialization: %s`,
      (expression) => {
        expectDenial(expression, kind);
      },
    );
  }

  it('excludes raw supplied values before program construction, including denied host getters', () => {
    const original = scope();
    expect(buildExpressionProgram('ctx.first', original)).not.toContain(CANARY);
    const inputs = { public: 'available' };
    Object.defineProperty(inputs, 'credential', {
      enumerable: true,
      get() {
        throw new Error(CANARY);
      },
    });
    expect(buildExpressionProgram('inputs.public', { ...original, inputs })).not.toContain(CANARY);
    expect(
      sandbox.evaluate({
        kind: 'transform',
        expression: 'inputs.public',
        scope: { ...original, inputs },
      }),
    ).toBe('available');
  });

  it('keeps successful clean values and declared branch order usable alongside denied keys', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression:
          '({ input: inputs.public, first: ctx.first, last: ctx.last, count: run.outputs.upstream.count, branches: branches.map(b => b.id), keys: Object.keys(ctx) })',
      }),
    ).toEqual({
      input: 'available',
      first: 'alpha',
      last: 'omega',
      count: 7,
      branches: ['first', 'second'],
      keys: ['first', 'derived', 'last'],
    });
    expect(
      sandbox.evaluate({
        kind: 'condition',
        scope: scope(),
        expression: 'ctx.first === "alpha" && inputs.public === "available"',
      }),
    ).toBe(true);
  });

  it('pins caught pre-accessor stack exhaustion without promising universal attempted-read detection', () => {
    const expression =
      '(() => { function f() { try { return f(); } catch { try { return ctx.derived; } catch { return "SWALLOWED"; } } } return f(); })()';
    expect(buildExpressionProgram(expression, scope())).not.toContain(CANARY);
    // The installed VM fails to enter the accessor at this exhausted stack: no latch body executes.
    expect(
      sandbox.evaluate({
        expression,
        kind: 'transform',
        scope: scope(),
        limits: DEFAULT_SANDBOX_LIMITS,
      }),
    ).toBe('SWALLOWED');
    expectDenial('(() => { try { return ctx.derived; } catch { return "SWALLOWED"; } })()');
  });

  it('keeps uncaught stack exhaustion classified as a resource failure', () => {
    expect(
      failure({
        kind: 'transform',
        scope: scope(),
        expression: '(() => { function f(){ return f(); } return f(); })()',
      }).reason,
    ).toBe('stack');
  });
});

describe('private control state cannot be forged by authored code', () => {
  it.each([
    '(() => { try { ctx.derived; } catch {} eval("var denied = false"); return true; })()',
    '(() => { try { ctx.derived; } catch {} Function("globalThis.denied=false")(); return true; })()',
    '(() => { try { ctx.derived; } catch {} globalThis.denied=false; globalThis.payloadJson="true"; return true; })()',
    '(() => { JSON.stringify=()=>"true"; JSON.parse=()=>({}); Object.create=()=>({}); Object.freeze=x=>x; try { ctx.derived; } catch {} return true; })()',
    '(() => { try { ctx.derived; } catch {} Object.prototype.toJSON=function(){ return { version:1, kind:"success", originalType:"boolean", payloadJson:"true" }; }; return { ok:true }; })()',
    '(() => { Object.prototype.toJSON=function(){ try { ctx.derived; } catch {} return { ok:true }; }; return { authored:true }; })()',
    '(() => { try { ctx.derived; } catch {} try { ctx={}; } catch {} return true; })()',
  ])('retains denial after tampering: %s', (expression) => expectDenial(expression));

  it('uses captured intrinsics for an exact clean result after global tampering', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression:
          '(() => { JSON.stringify=()=>"forged"; JSON.parse=()=>null; Object.create=()=>({}); Number.isNaN=()=>true; Object.is=()=>true; return { value:42 }; })()',
      }),
    ).toEqual({ value: 42 });
  });

  it('never invokes inherited toJSON again on its control envelope', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression:
          '(() => { let calls=0; Object.prototype.toJSON=function(){ calls++; if(calls>1){ ctx.derived; } return { calls }; }; return { authored:true }; })()',
      }),
    ).toEqual({ calls: 1 });
  });

  it('keeps private closure bindings inaccessible to eval and Function', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression:
          '[eval("typeof denied"),eval("typeof stringify"), Function("return typeof denied")(), Function("return typeof ctx")()]',
      }),
    ).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it.each(['inputs', 'ctx', 'run', 'branches'])('binds %s as const', (name) => {
    expect(
      failure({
        kind: 'transform',
        scope: scope(),
        expression: `(() => { ${name} = {}; return true; })()`,
      }).reason,
    ).toBe('runtime');
  });

  it('treats control-shaped strings and objects as authored data', () => {
    const forged = { version: 1, kind: 'denied' };
    for (const kind of kinds) {
      expect(
        sandbox.evaluate({
          kind,
          scope: scope(),
          expression: JSON.stringify(JSON.stringify(forged)),
        }),
      ).toBe(JSON.stringify(forged));
    }
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression: '({ version:1, kind:"denied" })',
      }),
    ).toEqual(forged);
    expect(
      failure({
        kind: 'condition',
        scope: scope(),
        expression: '(() => { throw new Error("secret_context"); })()',
      }).reason,
    ).toBe('runtime');
  });
});

describe('input presence, order and explicit provenance', () => {
  it('owns provenance against caller mutation and facade callback mutation attempts', () => {
    const callerNames = new Set(['credential', 'optional']);
    const names = ownSecretInputNames(callerNames);
    const values = { first: 'alpha' };
    const deniedKeys = ['derived'];
    const orderedKeys = ['first', 'derived'];
    const projection = createWorkflowContextProjection({ values, deniedKeys, orderedKeys });
    callerNames.clear();
    values.first = CANARY;
    deniedKeys.length = 0;
    orderedKeys.reverse();
    names.secretInputNames.forEach((_value, _key, membership) => {
      expect(membership).toBe(names.secretInputNames);
      expect('clear' in membership).toBe(false);
      expect(() => Set.prototype.clear.call(membership)).toThrow(TypeError);
    });
    expect(Reflect.set(names.deniedInputNames, '0', 'public')).toBe(false);
    const ownedScope = { ...scope(), ctx: projection, deniedInputNames: names.deniedInputNames };
    expect(buildExpressionProgram('ctx.first', ownedScope)).not.toContain(CANARY);
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: ownedScope,
        expression: '[ctx.first, Object.keys(ctx)]',
      }),
    ).toEqual(['alpha', ['first', 'derived']]);
    for (const expression of ['ctx.derived', 'inputs.credential']) {
      expect(failure({ kind: 'transform', scope: ownedScope, expression }).reason).toBe(
        'secret_context',
      );
    }
  });

  it('preserves omitted optional secrets across all ordinary reflection and direct reads', () => {
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: scope(),
        expression: `({
      keys:Object.keys(inputs), names:Object.getOwnPropertyNames(inputs), reflect:Reflect.ownKeys(inputs),
      descriptors:Object.keys(Object.getOwnPropertyDescriptors(inputs)),
      descriptorAbsent:Object.getOwnPropertyDescriptor(inputs,"optional")===undefined,
      hasOwn:Object.prototype.hasOwnProperty.call(inputs,"optional"),
      inResult:"optional" in inputs, absent:inputs.optional===undefined,
      suppliedHasOwn:Object.prototype.hasOwnProperty.call(inputs,"credential"), suppliedIn:"credential" in inputs,
      suppliedGetter:typeof Object.getOwnPropertyDescriptor(inputs,"credential").get,
      frozen:Object.isFrozen(inputs)&&Object.isFrozen(ctx),
      bare:Object.getPrototypeOf(inputs)===null&&Object.getPrototypeOf(ctx)===null
    })`,
      }),
    ).toEqual({
      keys: ['public', 'credential'],
      names: ['public', 'credential'],
      reflect: ['public', 'credential'],
      descriptors: ['public', 'credential'],
      descriptorAbsent: true,
      hasOwn: false,
      inResult: false,
      absent: true,
      suppliedHasOwn: true,
      suppliedIn: true,
      suppliedGetter: 'function',
      frozen: true,
      bare: true,
    });
    expectDenial('inputs.credential === undefined');
  });

  it('retains clean/denied interleaving, integer enumeration and own prototype-shaped keys', () => {
    const values = {
      before: 'a',
      ['__proto__']: 'own proto',
      after: 'z',
      constructor: 'own constructor',
      toString: 'own string',
    };
    const projection = createWorkflowContextProjection({
      values,
      deniedKeys: ['secret', '2', '10'],
      orderedKeys: ['before', '10', 'secret', '__proto__', '2', 'after', 'constructor', 'toString'],
    });
    const inputs = {
      before: 'a',
      '10': CANARY,
      secret: CANARY,
      ['__proto__']: 'own proto',
      '2': 'two',
      after: 'z',
    };
    const orderedScope: ExpressionScope = {
      ...scope(),
      ctx: projection,
      inputs,
      deniedInputNames: ['10', 'secret'],
    };
    expect(
      sandbox.evaluate({
        kind: 'transform',
        scope: orderedScope,
        expression:
          '({ ctxKeys:Object.keys(ctx), inputKeys:Reflect.ownKeys(inputs), proto:ctx.__proto__, ctor:ctx.constructor, str:ctx.toString, two:inputs[2] })',
      }),
    ).toEqual({
      ctxKeys: ['2', '10', 'before', 'secret', '__proto__', 'after', 'constructor', 'toString'],
      inputKeys: ['2', '10', 'before', 'secret', '__proto__', 'after'],
      proto: 'own proto',
      ctor: 'own constructor',
      str: 'own string',
      two: 'two',
    });
  });

  it.each<[string, unknown]>([
    ['ctx', undefined],
    ['ctx', {}],
    ['ctx', { values: { first: CANARY }, deniedKeys: ['first'], orderedKeys: ['first'] }],
    ['ctx', { values: {}, deniedKeys: ['derived'], orderedKeys: [] }],
    ['deniedInputNames', undefined],
    ['deniedInputNames', ['credential', 'credential']],
  ])(
    'refuses malformed %s metadata before execution with fixed scope diagnostics',
    (key, value) => {
      const invalid = { ...scope() };
      Reflect.set(invalid, key, value);
      const error = failure({
        kind: 'transform',
        scope: invalid,
        expression: '"must not execute"',
      });
      expect(error).toMatchObject({
        reason: 'scope',
        code: 'sandbox_error',
        retryable: false,
        message: 'the expression scope provenance is missing or invalid',
      });
      expect(error.detail).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(CANARY);
    },
  );
});

describe.each(kinds)('%s result compatibility through real QuickJS', (kind) => {
  it.each<[string, unknown]>([
    ['true', true],
    ['false', false],
    ['""', ''],
    ['"hello"', 'hello'],
    ['42', 42],
    ['-3.5', -3.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0', -0],
  ])('preserves exact primitive %s', (expression, expected) => {
    expect(sandbox.evaluate({ kind, scope: scope(), expression })).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['({ value:42 })', { value: 42 }],
    ['[1,"two",null]', [1, 'two', null]],
    ['null', null],
    ['new Map([["a",1]])', {}],
    ['new Set([1,2])', {}],
    ['({ toJSON(){ return null; } })', null],
    [
      '({ omitted:undefined, fn:()=>1, sym:Symbol("s"), nan:NaN, inf:Infinity, zero:-0, boxed:new Number(2), arr:[undefined,()=>1,Symbol("s"),NaN] })',
      { nan: null, inf: null, zero: 0, boxed: 2, arr: [null, null, null, null] },
    ],
    [
      '(() => { let calls=0; return { toJSON(){ calls++; if(calls>1) throw new Error("second call"); return { calls }; } }; })()',
      { calls: 1 },
    ],
  ])('retains object contract for %s', (expression, expected) => {
    if (kind === 'condition')
      expect(failure({ kind, scope: scope(), expression }).reason).toBe('result_type');
    else expect(sandbox.evaluate({ kind, scope: scope(), expression })).toEqual(expected);
  });

  it.each([
    'undefined',
    '(()=>1)',
    'Symbol("value")',
    '1n',
    'new Number(2)',
    'new Boolean(false)',
    'new String("value")',
    '({ toJSON(){ return "scalar"; } })',
    '({ toJSON(){ return 42; } })',
    '({ toJSON(){ return false; } })',
    '({ toJSON(){ return undefined; } })',
    '({ nested:1n })',
    '(() => { const cyclic={}; cyclic.self=cyclic; return cyclic; })()',
    '({ get value(){ throw new Error("getter failure"); } })',
    '({ toJSON(){ throw new Error("serialization failure"); } })',
  ])('retains refusal for %s', (expression) => {
    expect(failure({ kind, scope: scope(), expression }).reason).toBe(
      kind === 'condition' ? 'result_type' : 'non_serializable',
    );
  });

  it('preserves the existing serialization interruption disposition', () => {
    const error = failure({
      kind,
      scope: scope(),
      expression: '({ toJSON(){ while(true){} } })',
      limits: { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 20 },
    });
    expect(error.reason).toBe(kind === 'condition' ? 'result_type' : 'non_serializable');
    expect(error.retryable).toBe(false);
  });
});
