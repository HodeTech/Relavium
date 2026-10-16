/** ADR-0113: retain installed-bridge value/error semantics inside the private VM transport. */
import { beforeAll, describe, expect, it } from 'vitest';

import { SandboxError } from '../errors.js';
import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import {
  createExpressionSandbox,
  type ExpressionKind,
  type ExpressionSandbox,
  type ExpressionScope,
} from './sandbox.js';

const kinds: ExpressionKind[] = ['condition', 'transform', 'merge_fn'];
const stackString: unknown = expect.any(String);
let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function cleanScope(): ExpressionScope {
  return {
    inputs: { public: 'available' },
    ctx: createWorkflowContextProjection({
      values: { public: 'clean' },
      deniedKeys: [],
      orderedKeys: ['public'],
    }),
    deniedInputNames: ownSecretInputNames([]).deniedInputNames,
    outputs: {},
    branches: [],
  };
}

function deniedScope(): ExpressionScope {
  return {
    ...cleanScope(),
    inputs: { public: 'available', credential: 'withheld-before-VM-intake' },
    ctx: createWorkflowContextProjection({
      values: { public: 'clean' },
      deniedKeys: ['derived'],
      orderedKeys: ['public', 'derived'],
    }),
    deniedInputNames: ownSecretInputNames(['credential']).deniedInputNames,
  };
}

function failure(
  expression: string,
  kind: ExpressionKind,
  scope: ExpressionScope = cleanScope(),
): SandboxError {
  let caught: unknown;
  try {
    sandbox.evaluate({ expression, kind, scope });
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the actual installed VM must produce a classified refusal').toBeInstanceOf(
    SandboxError,
  );
  if (!(caught instanceof SandboxError)) throw new Error('expected a SandboxError');
  return caught;
}

interface ReturnedCase {
  readonly label: string;
  readonly expression: string;
  readonly expected: unknown;
}

// Values were characterized against the accepted bridge. Stack text embeds wrapper locations;
// only its presence/type is compatible across the old and private wrappers.
const returnedCases: ReturnedCase[] = [
  {
    label: 'Error metadata',
    expression: 'new Error("clean")',
    expected: { name: 'Error', message: 'clean', stack: stackString },
  },
  {
    label: 'TypeError and enumerable own data',
    expression: 'Object.assign(new TypeError("clean diagnostic"), {info:42})',
    expected: {
      info: 42,
      name: 'TypeError',
      message: 'clean diagnostic',
      stack: stackString,
    },
  },
  {
    label: 'stateful Error toJSON called once with supplemental native fields',
    expression:
      '(() => {let calls=0;const e=new Error("clean");e.toJSON=function(){calls++;if(calls>1)throw new Error("second serialization");return {calls};};return e;})()',
    expected: { calls: 1, name: 'Error', message: 'clean', stack: stackString },
  },
  {
    label: 'toJSON fields take precedence over supplemental fields',
    expression:
      '(() => {const e=new Error("clean");e.toJSON=()=>({name:"Custom",message:"custom",stack:"custom-stack",fileName:"own",lineNumber:5,info:42});return e;})()',
    expected: {
      name: 'Custom',
      message: 'custom',
      stack: 'custom-stack',
      fileName: 'own',
      lineNumber: 5,
      info: 42,
    },
  },
  {
    label: 'present falsy toJSON metadata remains present',
    expression:
      '(() => {const e=new Error("clean");e.toJSON=()=>({name:null,message:false,stack:0,fileName:null,lineNumber:null});return e;})()',
    expected: { name: null, message: false, stack: 0, fileName: null, lineNumber: null },
  },
  {
    label: 'deleted Error metadata falls back to inherited values',
    expression: '(() => {const e=new Error("clean");delete e.message;delete e.stack;return e;})()',
    expected: { name: 'Error', message: '' },
  },
  {
    label: 'undefined metadata is omitted',
    expression:
      '(() => {const e=new Error("clean");e.name=undefined;e.message=undefined;e.stack=undefined;return e;})()',
    expected: {},
  },
  {
    label: 'nonenumerable special fields are hydrated',
    expression:
      '(() => {const e=new Error("clean");Object.defineProperty(e,"name",{value:"Special"});Object.defineProperty(e,"fileName",{value:"clean.js"});Object.defineProperty(e,"lineNumber",{value:7});return e;})()',
    expected: {
      name: 'Special',
      message: 'clean',
      stack: stackString,
      fileName: 'clean.js',
      lineNumber: 7,
    },
  },
  {
    label: 'inherited ordinary-object metadata is hydrated',
    expression: 'Object.create({name:"SyntaxError",message:"inherited"})',
    expected: { name: 'SyntaxError', message: 'inherited' },
  },
  {
    label: 'nonenumerable ordinary-object metadata is hydrated',
    expression:
      '(() => {const e={};Object.defineProperty(e,"name",{value:"SyntaxError"});Object.defineProperty(e,"message",{value:"hidden"});return e;})()',
    expected: { name: 'SyntaxError', message: 'hidden' },
  },
  {
    label: 'a failed special-field getter does not discard other Error fields',
    expression:
      '(() => {const e=new Error("clean");Object.defineProperty(e,"name",{get(){throw 42;}});return e;})()',
    expected: { message: 'clean', stack: stackString },
  },
  {
    label: 'existing serialized field avoids a failing supplemental getter',
    expression:
      '(() => {const e=new Error("clean");e.toJSON=()=>({name:"kept"});Object.defineProperty(e,"name",{get(){throw 42;}});return e;})()',
    expected: { name: 'kept', message: 'clean', stack: stackString },
  },
  {
    label: 'Error toJSON null remains null',
    expression: 'Object.assign(new Error("clean"), {toJSON(){return null;}})',
    expected: null,
  },
  {
    label: 'nested Errors keep ordinary JSON semantics',
    expression: '({nested:new Error("nested"),clean:ctx.public,input:inputs.public})',
    expected: { nested: {}, clean: 'clean', input: 'available' },
  },
  {
    label: 'ordinary clean stateful toJSON remains single-call',
    expression:
      '(() => {let calls=0;return {toJSON(){calls++;if(calls>1)throw new Error("second serialization");return {calls,clean:ctx.public};}};})()',
    expected: { calls: 1, clean: 'clean' },
  },
];

describe.each(kinds)('%s top-level Error result parity in actual QuickJS', (kind) => {
  it.each(returnedCases)('$label', ({ expression, expected }) => {
    if (kind === 'condition') expect(failure(expression, kind).reason).toBe('result_type');
    else {
      const result = sandbox.evaluate({ expression, kind, scope: cleanScope() });
      expect(result, 'NATIVE_RESULT_PROJECTION_PARITY').toEqual(expected);
      if (
        expected !== null &&
        typeof expected === 'object' &&
        Reflect.get(expected, 'stack') === stackString
      ) {
        expect(result).not.toBeNull();
        if (result === null || typeof result !== 'object') throw new Error('expected an object');
        expect(typeof Reflect.get(result, 'stack')).toBe('string');
      }
    }
  });

  it.each([
    'Object(2n)',
    'Object.assign(new Error("clean"),{toJSON(){return "scalar";}})',
    'Object.assign(new Error("clean"),{toJSON(){return undefined;}})',
    'Object.assign(new Error("clean"),{toJSON(){throw 42;}})',
    '(() => {const e=new Error("clean");e.self=e;return e;})()',
  ])('retains unsuccessful result conversion: %s', (expression) => {
    expect(failure(expression, kind).reason).toBe(
      kind === 'condition' ? 'result_type' : 'non_serializable',
    );
  });
});

interface ThrownCase {
  readonly label: string;
  readonly value: string;
  readonly reason: SandboxError['reason'];
  readonly detail: string;
}

const thrownCases: ThrownCase[] = [
  {
    label: 'serialized fields replace original resource-shaped metadata',
    value:
      '{name:"InternalError",message:"stack overflow",toJSON(){return {name:"Error",message:"old"};}}',
    reason: 'runtime',
    detail: 'Error: old',
  },
  {
    label: 'toJSON supplies syntax classification',
    value: '{toJSON(){return {name:"SyntaxError",message:"x"};}}',
    reason: 'syntax',
    detail: 'SyntaxError: x',
  },
  {
    label: 'toJSON supplies resource classification',
    value: '{toJSON(){return {name:"InternalError",message:"out of memory"};}}',
    reason: 'memory',
    detail: 'InternalError: out of memory',
  },
  {
    label: 'Error subclass',
    value: 'new TypeError("clean type")',
    reason: 'runtime',
    detail: 'TypeError: clean type',
  },
  {
    label: 'Error toJSON supplies different metadata once',
    value:
      '(() => {let calls=0;const e=new Error("clean");e.toJSON=function(){calls++;if(calls>1)throw 42;return {name:"SyntaxError",message:"calls="+calls};};return e;})()',
    reason: 'syntax',
    detail: 'SyntaxError: calls=1',
  },
  {
    label: 'original Error resource-shaped fields',
    value: 'Object.assign(new Error("clean"),{name:"InternalError",message:"stack overflow"})',
    reason: 'stack',
    detail: 'InternalError: stack overflow',
  },
  {
    label: 'failed ordinary serialization uses fallback text',
    value: '{name:"SyntaxError",message:"z",toJSON(){throw 42;}}',
    reason: 'runtime',
    detail: '[object Object]',
  },
  {
    label: 'null serialization does not retain original metadata',
    value: '{name:"SyntaxError",message:"z",toJSON(){return null;}}',
    reason: 'runtime',
    detail: 'null',
  },
  {
    label: 'ordinary cycle uses fallback text',
    value: '(() => {const e={name:"SyntaxError",message:"cycle"};e.self=e;return e;})()',
    reason: 'runtime',
    detail: '[object Object]',
  },
  {
    label: 'cyclic native Error keeps native thrown-error metadata',
    value: '(() => {const e=new Error("clean");e.self=e;return e;})()',
    reason: 'runtime',
    detail: 'Error: clean',
  },
  {
    label: 'inherited ordinary metadata',
    value: 'Object.create({name:"SyntaxError",message:"inherited"})',
    reason: 'syntax',
    detail: 'SyntaxError: inherited',
  },
  {
    label: 'nonenumerable ordinary metadata',
    value:
      '(() => {const e={};Object.defineProperty(e,"name",{value:"SyntaxError"});Object.defineProperty(e,"message",{value:"hidden"});return e;})()',
    reason: 'syntax',
    detail: 'SyntaxError: hidden',
  },
  {
    label: 'missing name',
    value: '{message:"message only"}',
    reason: 'runtime',
    detail: 'message only',
  },
  {
    label: 'missing message',
    value: '{name:"SyntaxError"}',
    reason: 'syntax',
    detail: 'SyntaxError',
  },
  {
    label: 'string serialization',
    value: '{toJSON(){return "text";}}',
    reason: 'runtime',
    detail: 'text',
  },
  {
    label: 'number serialization',
    value: '{toJSON(){return 42;}}',
    reason: 'runtime',
    detail: '42',
  },
  {
    label: 'boolean serialization',
    value: '{toJSON(){return false;}}',
    reason: 'runtime',
    detail: 'false',
  },
  {
    label: 'undefined serialization uses fallback text',
    value: '{toJSON(){return undefined;}}',
    reason: 'runtime',
    detail: '[object Object]',
  },
  { label: 'number primitive', value: '42', reason: 'runtime', detail: '42' },
  { label: 'NaN primitive', value: 'NaN', reason: 'runtime', detail: 'NaN' },
  { label: 'positive infinity', value: 'Infinity', reason: 'runtime', detail: 'Infinity' },
  { label: 'negative infinity', value: '-Infinity', reason: 'runtime', detail: '-Infinity' },
  { label: 'null primitive', value: 'null', reason: 'runtime', detail: 'null' },
  { label: 'boolean primitive', value: 'true', reason: 'runtime', detail: 'true' },
  { label: 'undefined primitive', value: 'undefined', reason: 'runtime', detail: 'undefined' },
  { label: 'string primitive', value: '"plain"', reason: 'runtime', detail: 'plain' },
  { label: 'symbol primitive', value: 'Symbol("S")', reason: 'runtime', detail: 'Symbol(S)' },
  { label: 'bigint primitive', value: '2n', reason: 'runtime', detail: '2' },
  { label: 'boxed string', value: 'new String("S")', reason: 'runtime', detail: 'S' },
  { label: 'boxed number', value: 'new Number(2)', reason: 'runtime', detail: '2' },
  { label: 'boxed boolean', value: 'new Boolean(false)', reason: 'runtime', detail: 'false' },
];

describe.each(kinds)('%s ordinary thrown-value parity in actual QuickJS', (kind) => {
  it.each(thrownCases)('$label', ({ value, reason, detail }) => {
    const error = failure(`(() => {throw (${value});})()`, kind);
    expect(error, 'NATIVE_THROWN_CLASSIFICATION_PARITY').toMatchObject({
      code: 'sandbox_error',
      reason,
      retryable: false,
      detail,
    });
    expect(error.cause).toBeUndefined();
  });
});

describe.each(kinds)('%s denial wins during error conversion', (kind) => {
  const reads = ['ctx.derived', 'inputs.credential'];
  for (const read of reads) {
    const swallowed = `try {${read};} catch {}`;
    it.each([
      `(() => {throw {get name(){${swallowed}return "SyntaxError";},message:"authored"};})()`,
      `(() => {throw {name:"SyntaxError",get message(){${swallowed}return "authored";}};})()`,
      `(() => {throw {toJSON(){${swallowed}return {name:"SyntaxError",message:"authored"};}};})()`,
      `(() => {const e=new Error("authored");e.toJSON=function(){${swallowed}return {name:"SyntaxError"};};throw e;})()`,
      `(() => {const e=new Error("authored");e.toJSON=function(){${swallowed}return {ok:true};};return e;})()`,
      ...['name', 'message', 'stack', 'fileName', 'lineNumber'].map(
        (field) =>
          `(() => {const e=new Error("authored");Object.defineProperty(e,"${field}",{get(){${swallowed}return "authored";}});return e;})()`,
      ),
    ])(`observes ${read} even when conversion catches it: %s`, (expression) => {
      const error = failure(expression, kind, deniedScope());
      expect(error).toMatchObject({
        code: 'sandbox_error',
        reason: 'secret_context',
        retryable: false,
        message: 'secret-derived values are unavailable to expressions',
      });
      expect(error.detail).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('withheld-before-VM-intake');
    });
  }

  it('keeps independent clean success available alongside denied names', () => {
    const expression =
      kind === 'condition'
        ? 'ctx.public === "clean" && inputs.public === "available"'
        : '({context:ctx.public,input:inputs.public})';
    expect(sandbox.evaluate({ expression, kind, scope: deniedScope() })).toEqual(
      kind === 'condition' ? true : { context: 'clean', input: 'available' },
    );
  });
});
