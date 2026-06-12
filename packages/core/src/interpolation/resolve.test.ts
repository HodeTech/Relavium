import { describe, expect, it } from 'vitest';

import { InterpolationError } from '../errors.js';
import { parseWorkflow } from '../parser.js';

import { resolveContext, resolveTemplate } from './resolve.js';
import type { ResolverCapabilities, RunScope } from './scope.js';

function scope(over: Partial<RunScope> = {}): RunScope {
  return { inputs: {}, ctx: {}, outputs: {}, ...over };
}

/** Resolve `text`, asserting it throws an InterpolationError with the given code; returns the error. */
async function expectCode(
  text: string,
  s: RunScope,
  code: string,
  caps?: ResolverCapabilities,
): Promise<InterpolationError> {
  try {
    await resolveTemplate(text, s, caps);
  } catch (err) {
    if (!(err instanceof InterpolationError)) {
      throw err; // an unexpected error type — surface it rather than mis-narrowing
    }
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected resolveTemplate to throw ${code}`);
}

describe('resolveTemplate — happy paths', () => {
  it('passes a literal-only template through verbatim', async () => {
    await expect(resolveTemplate('just text', scope())).resolves.toBe('just text');
  });

  it('resolves inputs / ctx / run.outputs heads between literals', async () => {
    const s = scope({
      inputs: { name: 'Ada' },
      ctx: { greeting: 'Hi' },
      outputs: { scan: { score: 9 } },
    });
    await expect(resolveTemplate('{{ctx.greeting}}, {{inputs.name}}!', s)).resolves.toBe(
      'Hi, Ada!',
    );
    await expect(resolveTemplate('score={{run.outputs["scan"].score}}', s)).resolves.toBe(
      'score=9',
    );
  });

  it('stringifies number and boolean values', async () => {
    const s = scope({ inputs: { n: 42, flag: true } });
    await expect(resolveTemplate('{{inputs.n}}/{{inputs.flag}}', s)).resolves.toBe('42/true');
  });

  it('applies the json filter as 2-space pretty JSON', async () => {
    const s = scope({ outputs: { scan: { a: 1 } } });
    await expect(resolveTemplate('{{run.outputs["scan"] | json}}', s)).resolves.toBe(
      JSON.stringify({ a: 1 }, null, 2),
    );
  });

  it('applies length to a string, an array, and an object', async () => {
    const s = scope({ inputs: { str: 'abcd', arr: [1, 2, 3], obj: { a: 1, b: 2 } } });
    await expect(resolveTemplate('{{inputs.str | length}}', s)).resolves.toBe('4');
    await expect(resolveTemplate('{{inputs.arr | length}}', s)).resolves.toBe('3');
    await expect(resolveTemplate('{{inputs.obj | length}}', s)).resolves.toBe('2');
  });

  it('uses default only when the value is null/undefined, else passes the value through', async () => {
    const s = scope({ inputs: { present: 'kept' }, outputs: {} });
    await expect(
      resolveTemplate('{{run.outputs["missing"] | default("fallback")}}', s),
    ).resolves.toBe('fallback');
    await expect(resolveTemplate('{{inputs.present | default("fallback")}}', s)).resolves.toBe(
      'kept',
    );
  });

  it('default keeps a falsy-but-present value (0 / false / empty string), rescues only missing', async () => {
    await expect(
      resolveTemplate('{{inputs.z | default("FB")}}', scope({ inputs: { z: 0 } })),
    ).resolves.toBe('0');
    await expect(
      resolveTemplate('{{inputs.f | default("FB")}}', scope({ inputs: { f: false } })),
    ).resolves.toBe('false');
    await expect(
      resolveTemplate('{{inputs.e | default("FB")}}', scope({ inputs: { e: '' } })),
    ).resolves.toBe('');
    await expect(
      resolveTemplate('{{run.outputs["m"] | default("FB")}}', scope({ outputs: {} })),
    ).resolves.toBe('FB');
  });

  it('chains filters left to right (default rescues, then length counts)', async () => {
    const s = scope({ outputs: {} });
    await expect(
      resolveTemplate('{{run.outputs["x"] | default("abc") | length}}', s),
    ).resolves.toBe('3');
  });

  it('reads a file through an injected sync or async capability', async () => {
    const s = scope({ inputs: { path: 'src/a.ts' } });
    await expect(
      resolveTemplate('{{inputs.path | read_file}}', s, { readFile: (p) => `SYNC:${p}` }),
    ).resolves.toBe('SYNC:src/a.ts');
    await expect(
      resolveTemplate('{{inputs.path | read_file}}', s, {
        readFile: (p) => Promise.resolve(`ASYNC:${p}`),
      }),
    ).resolves.toBe('ASYNC:src/a.ts');
  });
});

describe('resolveTemplate — typed, secret-free errors', () => {
  it('unresolved_reference when a head/path yields nothing and no default rescues it', async () => {
    await expectCode('{{inputs.missing}}', scope(), 'unresolved_reference');
  });

  it('unknown_namespace for a non inputs/ctx/run.outputs head (incl. secrets)', async () => {
    await expectCode('{{foo.bar}}', scope(), 'unknown_namespace');
    const secretErr = await expectCode('{{secrets.token}}', scope(), 'unknown_namespace');
    expect(secretErr.message).toContain('secret'); // a clearer message than the generic unknown case
  });

  it('treats a prototype key on a scope bag as a missing reference (no inherited member)', async () => {
    // `scope.inputs.toString` must not return Object.prototype.toString — it is an unresolved reference.
    await expectCode('{{inputs.toString}}', scope({ inputs: {} }), 'unresolved_reference');
    await expectCode('{{ctx.constructor}}', scope({ ctx: {} }), 'unresolved_reference');
  });

  it('unserializable when an object/array is used as text without a json filter', async () => {
    const s = scope({ outputs: { scan: { a: 1 }, list: [1, 2] } });
    await expectCode('{{run.outputs["scan"]}}', s, 'unserializable');
    await expectCode('{{run.outputs["list"]}}', s, 'unserializable');
  });

  it('json wraps a circular structure as a typed unserializable error (not a raw TypeError)', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const err = await expectCode(
      '{{run.outputs["x"] | json}}',
      scope({ outputs: { x: circular } }),
      'unserializable',
    );
    expect(err.message).not.toContain('circular'); // the raw TypeError detail stays on cause
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('json wraps a BigInt as a typed unserializable error', async () => {
    await expectCode(
      '{{run.outputs["x"] | json}}',
      scope({ outputs: { x: { n: 1n } } }),
      'unserializable',
    );
  });

  it('unknown_filter for a filter not in the registry', async () => {
    await expectCode('{{inputs.x | nope}}', scope({ inputs: { x: 'v' } }), 'unknown_filter');
  });

  it('unknown_filter for an inherited registry member used as a filter name (no prototype call)', async () => {
    const s = scope({ inputs: { x: 'v' } });
    await expectCode('{{inputs.x | toString}}', s, 'unknown_filter');
    await expectCode('{{inputs.x | constructor}}', s, 'unknown_filter');
    await expectCode('{{inputs.x | __proto__}}', s, 'unknown_filter');
  });

  it('filter_arity for the wrong number of arguments', async () => {
    const s = scope({ inputs: { x: 'v' } });
    await expectCode('{{inputs.x | default}}', s, 'filter_arity'); // needs 1
    await expectCode('{{inputs.x | json(1)}}', s, 'filter_arity'); // needs 0
  });

  it('filter_type when a filter cannot apply to the value', async () => {
    await expectCode('{{inputs.n | length}}', scope({ inputs: { n: 5 } }), 'filter_type');
    await expectCode('{{inputs.u | json}}', scope({ inputs: { u: undefined } }), 'filter_type');
  });

  it('invalid_path for a malformed property access after the head', async () => {
    const s = scope({ outputs: { x: { score: 1 } } });
    await expectCode('{{run.outputs["x"]..score}}', s, 'invalid_path');
  });

  it('read_file_unavailable when no host reader was provided', async () => {
    await expectCode(
      '{{inputs.p | read_file}}',
      scope({ inputs: { p: 'a.ts' } }),
      'read_file_unavailable',
    );
  });

  it('read_file_failed (keeping the host error on cause) when the reader throws', async () => {
    const boom = new Error('ENOENT: /abs/secret/path');
    const err = await expectCode(
      '{{inputs.p | read_file}}',
      scope({ inputs: { p: 'a.ts' } }),
      'read_file_failed',
      {
        readFile: () => {
          throw boom;
        },
      },
    );
    expect(err.message).not.toContain('/abs/secret/path'); // the absolute path stays off the message
    expect(err.cause).toBe(boom); // …but is preserved on cause for logs
  });

  it('read_file filter_type when the piped value is not a string path', async () => {
    await expectCode('{{inputs.n | read_file}}', scope({ inputs: { n: 7 } }), 'filter_type', {
      readFile: (p) => p,
    });
  });

  it('carries the offending {{ … }} verbatim as the error location', async () => {
    const err = await expectCode('a {{inputs.missing}} b', scope(), 'unresolved_reference');
    expect(err.location).toBe('{{inputs.missing}}');
  });
});

describe('resolveContext — eager-once, frozen, deterministic', () => {
  const WF = `schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: p
      type: string
  context:
    - key: a
      value: 'hello {{inputs.p}}'
    - key: b
      value: '{{ctx.a}}!'
  nodes:
    - id: n
      type: input
  edges: []`;

  it('resolves entries in order so a later entry can read an earlier one', async () => {
    const ctx = await resolveContext(parseWorkflow(WF), { p: 'world' });
    expect(ctx).toEqual({ a: 'hello world', b: 'hello world!' });
  });

  it('freezes the snapshot and re-resolves to an identical scope', async () => {
    const wf = parseWorkflow(WF);
    const first = await resolveContext(wf, { p: 'world' });
    const second = await resolveContext(wf, { p: 'world' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
  });

  it('resolves a read_file context entry through the injected capability', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: path
      type: file_path
  context:
    - key: code
      value: '{{inputs.path | read_file}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    const ctx = await resolveContext(wf, { path: 'x.ts' }, { readFile: (p) => `FILE(${p})` });
    expect(ctx).toEqual({ code: 'FILE(x.ts)' });
  });

  it('rejects (pre-run) when a context pipe-filter fails, keeping the host path off the message', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: path
      type: file_path
  context:
    - key: code
      value: '{{inputs.path | read_file}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    const boom = new Error('ENOENT: /abs/missing.ts');
    let thrown: unknown;
    try {
      await resolveContext(
        wf,
        { path: 'missing.ts' },
        {
          readFile: () => {
            throw boom;
          },
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InterpolationError);
    if (!(thrown instanceof InterpolationError)) {
      throw new Error('expected an InterpolationError');
    }
    expect(thrown.code).toBe('read_file_failed');
    expect(thrown.message).not.toContain('/abs/missing.ts');
    expect(thrown.cause).toBe(boom);
  });

  it('returns a frozen empty snapshot when there is no context', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  nodes:
    - id: n
      type: input
  edges: []`);
    const ctx = await resolveContext(wf, {});
    expect(ctx).toEqual({});
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('stores a `__proto__` context key as a real own property (null-prototype accumulator)', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  context:
    - key: __proto__
      value: 'safe'
  nodes:
    - id: n
      type: input
  edges: []`);
    const ctx = await resolveContext(wf, {});
    expect(Object.hasOwn(ctx, '__proto__')).toBe(true);
    expect(ctx['__proto__']).toBe('safe');
  });

  it('a backward context reference is unresolved at runtime (single-pass declared order)', async () => {
    // `early` reads `late`, declared after it — accepted at parse, unresolved at runtime.
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  context:
    - key: early
      value: '{{ctx.late}}'
    - key: late
      value: 'L'
  nodes:
    - id: n
      type: input
  edges: []`);
    await expect(resolveContext(wf, {})).rejects.toBeInstanceOf(InterpolationError);

    // … unless a default rescues it.
    const wf2 = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  context:
    - key: early
      value: '{{ctx.late | default("FB")}}'
    - key: late
      value: 'L'
  nodes:
    - id: n
      type: input
  edges: []`);
    const ctx = await resolveContext(wf2, {});
    expect(ctx['early']).toBe('FB');
  });

  it('forwards the AbortSignal to the host readFile and aborts an already-cancelled run', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: path
      type: file_path
  context:
    - key: code
      value: '{{inputs.path | read_file}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    let receivedSignal: unknown;
    const live = new AbortController();
    await resolveContext(
      wf,
      { path: 'x.ts' },
      {
        readFile: (path, signal) => {
          receivedSignal = signal;
          return `FILE(${path})`;
        },
      },
      live.signal,
    );
    expect(receivedSignal).toBe(live.signal);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      resolveContext(wf, { path: 'x.ts' }, { readFile: (p) => `FILE(${p})` }, aborted.signal),
    ).rejects.toThrow();
  });

  it('re-resolves a read_file context identically (determinism across the impurity seam)', async () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: path
      type: file_path
  context:
    - key: code
      value: '{{inputs.path | read_file}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    const reader = (path: string): string => `FILE(${path})`;
    const first = await resolveContext(wf, { path: 'x.ts' }, { readFile: reader });
    const second = await resolveContext(wf, { path: 'x.ts' }, { readFile: reader });
    expect(second).toEqual(first);
  });
});
