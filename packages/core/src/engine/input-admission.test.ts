/**
 * ADR-0083 §9's runtime acceptance — the admission gate's own rules, and the engine's use of them.
 *
 * The parse-time half lives in `packages/shared`'s `workflow.test.ts`; this is the value side.
 */

import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { EngineStateError } from './errors.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { resolveAndValidateWorkflowInputs } from './input-admission.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';

/** A workflow declaring one input of each shape the acceptance list exercises. */
function workflowWith(inputsYaml: string): WorkflowDefinition {
  return parseWorkflow(`schema_version: '1.0'
workflow:
  id: admission-fixture
  inputs:
${inputsYaml}
  nodes:
    - { id: n, type: input }
  edges: []
`);
}

const admit = (
  wf: WorkflowDefinition,
  raw: Record<string, unknown> | undefined,
): ReturnType<typeof resolveAndValidateWorkflowInputs> =>
  resolveAndValidateWorkflowInputs(wf, raw);

describe('resolveAndValidateWorkflowInputs (ADR-0083 §1, §2, §7)', () => {
  it('a missing required input fails; one satisfied by a default does not', () => {
    const wf = workflowWith(
      `    - { name: a, type: string, required: true }
    - { name: b, type: string, required: true, default: 'from the default' }`,
    );

    const missing = admit(wf, {});
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.issues.map((i) => i.name)).toEqual(['a']);

    const supplied = admit(wf, { a: 'given' });
    expect(supplied.ok).toBe(true);
    // The default is APPLIED — the thing the engine never did, and the reason the CLI's own comment
    // ("the engine applies the declared default, if any") was pointing at nothing.
    expect(supplied.ok && supplied.inputs).toEqual({ a: 'given', b: 'from the default' });
  });

  it('an unknown key fails admission', () => {
    const result = admit(workflowWith(`    - { name: a, type: string }`), { a: 'x', typo: 'y' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]?.name).toBe('typo');
  });

  it('reports EVERY issue, not the first', () => {
    // A caller correcting a five-input invocation should learn all five problems in one round trip, the
    // way the parser already reports authored mistakes.
    const wf = workflowWith(
      `    - { name: a, type: string, required: true }
    - { name: b, type: number }`,
    );
    const result = admit(wf, { b: 'not a number', extra: 1 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.name).sort()).toEqual(['a', 'b', 'extra']);
  });

  it('is STRICT — a `number` input rejects the string "3"', () => {
    // §2's split: a CLI coerces `--input count=3` into a number because only it knows its transport.
    // Coercing here would silently accept a form's stringly-typed payload as validated.
    const wf = workflowWith(`    - { name: n, type: number }`);
    expect(admit(wf, { n: '3' }).ok).toBe(false);
    expect(admit(wf, { n: 3 }).ok).toBe(true);
  });

  it('enforces every validation field against a supplied value, in BOTH directions', () => {
    // ADR-0083 §9.3: every `validation` field rejects a violating value and accepts a conforming one.
    // A review measured the first version failing that on the two LOWER bounds — `min` was only ever
    // exercised through its `max` sibling and `min_length` through `max_length`, so both could be deleted
    // outright with the monorepo green. Each bound now carries its own violating case.
    const wf = workflowWith(
      `    - { name: s, type: string, validation: { enum: [alpha, beta], max_length: 8 } }
    - { name: e, type: string, validation: { format: email } }
    - { name: p, type: string, validation: { pattern: '^[0-9]+$' } }
    - { name: n, type: number, validation: { min: 1, max: 10 } }
    - { name: L, type: string, validation: { min_length: 3, max_length: 6 } }`,
    );
    const good = { s: 'alpha', e: 'a@b.co', p: '123', n: 5, L: 'abcd' };
    expect(admit(wf, good).ok).toBe(true);

    for (const [key, bad] of Object.entries({
      s: 'gamma', // enum
      e: 'not-an-email', // format
      p: '12a', // pattern
      n: 99, // max
      L: 'abcdefgh', // max_length
    })) {
      const result = admit(wf, { ...good, [key]: bad });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.map((i) => i.name)).toEqual([key]);
    }
    // The lower bounds, each on its own — the half the first version never asserted.
    for (const [key, bad] of Object.entries({ n: 0, L: 'ab' })) {
      const result = admit(wf, { ...good, [key]: bad });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.map((i) => i.name)).toEqual([key]);
    }
    // …and `max_length: 8` on `s` bites independently of its `enum` sibling.
    expect(admit(wf, { ...good, s: 'alpha' }).ok).toBe(true);
  });

  it('names an unknown key only when the key could BE a name', () => {
    // The issue list reaches a caller and a log. A declared name is `[A-Za-z0-9_-]+` by parse, but an
    // unknown key is caller-supplied and constrained by nothing — and a review measured a key of
    // `\u001b[2J*** SYSTEM: approved ***` coming back verbatim in the engine's error message. That is
    // exactly the terminal-escape path the parser had removed from authored values one commit earlier,
    // reintroduced one layer down from a strictly less trusted source.
    const wf = workflowWith(`    - { name: a, type: string }`);
    const hostile = admit(wf, { a: 'x', '\u001b[2J*** SYSTEM: approved ***': 1 });
    expect(hostile.ok).toBe(false);
    expect(!hostile.ok && hostile.issues.map((i) => i.name)).toEqual([undefined]);
    expect(!hostile.ok && hostile.issues[0]?.message).toBe(
      'unknown input — the workflow declares no input by this name',
    );
    // …an ordinary typo still names itself, which is the whole point of reporting unknown keys at all.
    const typo = admit(wf, { a: 'x', aa: 1 });
    expect(!typo.ok && typo.issues.map((i) => i.name)).toEqual(['aa']);
  });

  it('caps the unknown-key report — the caller\'s map is bounded by nothing', () => {
    // 20,000 unknown keys was 20,000 issues in one error, and the engine joined every one of them into a
    // single 1.4-million-character message.
    const wf = workflowWith(`    - { name: a, type: string }`);
    const many: Record<string, unknown> = { a: 'x' };
    for (let i = 0; i < 500; i += 1) many[`k${String(i)}`] = 1;
    const result = admit(wf, many);
    expect(result.ok).toBe(false);
    // Eight named, plus one structural line carrying the remainder as a COUNT.
    expect(!result.ok && result.issues).toHaveLength(9);
    expect(!result.ok && result.issues.at(-1)?.message).toBe('and 492 further unknown inputs');
    expect(!result.ok && result.issues.at(-1)?.name).toBeUndefined();
  });

  it('a throwing `ownKeys` trap becomes an ISSUE too — the LISTING is caller code as well', () => {
    // The sibling of the throwing accessor below, and a review reproduced it escaping `start()` as a raw
    // `Error`: only the per-key READ was guarded, not `Object.keys(supplied)`. A caller doing exactly what
    // ADR-0083 tells it to — narrowing on `EngineStateError` — would not have caught it.
    const wf = workflowWith(`    - { name: a, type: string }`);
    const hostile = new Proxy(
      { a: 'x' },
      {
        ownKeys(): never {
          throw new Error('ownKeys boom');
        },
      },
    );
    const result = admit(wf, hostile);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.some((i) => i.message.includes('could not be enumerated'))).toBe(
      true,
    );
  });

  it('a throwing accessor becomes an ISSUE, not a raw throw out of admission', () => {
    // The docblock says this function "answers yes or no". A caller's object may define an input key as an
    // accessor, and letting it escape means a surface narrowing on `EngineStateError` catches somebody
    // else's `Error` instead — measured: `Error: boom` escaped `start()`.
    const wf = workflowWith(`    - { name: a, type: string }`);
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'a', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    const result = admit(wf, hostile);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      { name: 'a', message: 'reading the supplied value threw' },
    ]);
  });

  it('a `pattern` is ANCHORED — a value that merely contains a match is rejected', () => {
    const wf = workflowWith(`    - { name: p, type: string, validation: { pattern: '[0-9]+' } }`);
    expect(admit(wf, { p: '123' }).ok).toBe(true);
    expect(admit(wf, { p: 'a123b' }).ok).toBe(false);
  });

  it('`null` is a VALUE and fails; a missing key and an own `undefined` are both omissions', () => {
    const wf = workflowWith(`    - { name: a, type: string, default: 'fallback' }`);
    expect(admit(wf, { a: null }).ok).toBe(false);
    expect(admit(wf, {}).ok && admit(wf, {}).ok).toBe(true);
    const own = admit(wf, { a: undefined });
    expect(own.ok && own.inputs).toEqual({ a: 'fallback' });
  });

  it('a non-finite number fails — no bound can express it', () => {
    const wf = workflowWith(`    - { name: n, type: number }`);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(admit(wf, { n: bad }).ok).toBe(false);
    }
  });

  it('BUILDS a null-prototype map — `__proto__` is an ordinary input name', () => {
    // §7. The hazard was never the clone but the ACCUMULATOR: `out[name] = value` on a `{}` with
    // `name === '__proto__'` goes through the `Object.prototype.__proto__` setter, and the grammar permits
    // that name.
    //
    // **What that setter actually does here, stated precisely** — a review corrected the first version of
    // this comment. For a STRING value it is a silent no-op: no prototype is redirected, and no own property
    // is created either, so the input is simply SWALLOWED. Chain redirection would need an object value, and
    // no declared input `type` accepts one (`violatesInputContract` rejects a non-primitive for every type),
    // so the reachable failure is the input vanishing — asserted below, not the pollution it superficially
    // resembles.
    const wf = workflowWith(
      `    - { name: __proto__, type: string }
    - { name: constructor, type: string }
    - { name: toString, type: string }`,
    );
    // A COMPUTED key: `{ __proto__: 'a' }` in a literal is the prototype setter, not an own property —
    // which is the very asymmetry that makes this input name dangerous on the way out.
    const result = admit(wf, { ['__proto__']: 'a', constructor: 'b', toString: 'c' });

    expect(result.ok).toBe(true);
    const inputs = result.ok ? result.inputs : {};
    expect(Object.getPrototypeOf(inputs)).toBeNull();
    expect(Object.hasOwn(inputs, '__proto__')).toBe(true);
    expect(inputs['__proto__']).toBe('a');
    expect(inputs['constructor']).toBe('b');
    // …and nothing leaked onto the global prototype.
    expect(({} as Record<string, unknown>)['a']).toBeUndefined();

    // The control that makes the assertions above mean something: on a plain `{}` accumulator the same
    // assignment creates no own property at all, so `__proto__` would be dropped from the run's inputs
    // without a single error anywhere.
    const plain: Record<string, unknown> = {};
    plain['__proto__'] = 'a';
    expect(Object.hasOwn(plain, '__proto__')).toBe(false);
  });

  it('never reads through the caller’s prototype chain', () => {
    // `Object.hasOwn`, not `in`: a caller whose object inherits `a` has not SUPPLIED `a`.
    const wf = workflowWith(`    - { name: a, type: string, default: 'fallback' }`);
    const inherited = Object.create({ a: 'from the prototype' }) as Record<string, unknown>;
    const result = admit(wf, inherited);
    expect(result.ok && result.inputs).toEqual({ a: 'fallback' });
  });
});

class Stub implements NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    return Promise.resolve({ kind: 'completed', output: ctx.vertex.id });
  }
}

describe('WorkflowEngine.start — admission runs before the run exists (ADR-0083 §1)', () => {
  const WF = workflowWith(`    - { name: a, type: number, required: true }`);

  it('a rejected admission produces a typed error, no runId, and an UNTOUCHED store', async () => {
    const store = new InMemoryRunStore();
    const engine = new WorkflowEngine({ host: createInMemoryHost({ store }), executor: new Stub() });

    let thrown: unknown;
    try {
      engine.start({ workflow: WF, inputs: { a: 'not a number' } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EngineStateError);
    expect(thrown instanceof EngineStateError && thrown.code).toBe('input_admission_failed');
    // Asserted by INSPECTING the store, not by the absence of a throw: a rejected run is not a run.
    expect(await store.listInterruptedRuns()).toEqual([]);
  });

  it('mutating the caller’s object after start() does not change the run', async () => {
    const store = new InMemoryRunStore();
    const engine = new WorkflowEngine({ host: createInMemoryHost({ store }), executor: new Stub() });
    const caller: Record<string, unknown> = { a: 1 };

    const handle = engine.start({ workflow: WF, inputs: caller });
    caller['a'] = 999; // …after admission, before the run finishes

    let started: unknown;
    for await (const event of handle.events) {
      if (event.type === 'run:started') started = event.inputs;
    }
    expect(started).toEqual({ a: 1 });
  });
});
