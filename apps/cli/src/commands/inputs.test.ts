import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';

import { isCliError } from '../process/errors.js';
import { parseInputArgs, resolveInputs } from './inputs.js';

/** Build a parsed workflow with the given `inputs:` block (or none). */
function workflowWithInputs(inputsYaml: string): WorkflowDefinition {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: inputs-fixture
${inputsYaml}
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }`,
  );
}

const NO_INPUTS = workflowWithInputs('');
const TYPED_INPUTS = workflowWithInputs(`  inputs:
    - { name: count, type: number }
    - { name: flag, type: boolean }
    - { name: title, type: string }
    - { name: needed, type: string, required: true }`);

describe('parseInputArgs', () => {
  it('parses key=value tokens into a map', () => {
    expect(parseInputArgs(['a=1', 'b=hello'])).toEqual({ a: '1', b: 'hello' });
  });

  it('keeps `=` characters in the value', () => {
    expect(parseInputArgs(['url=https://x?a=b'])).toEqual({ url: 'https://x?a=b' });
  });

  it('returns an empty map for no inputs', () => {
    expect(parseInputArgs([])).toEqual({});
  });

  it('rejects a token without `=` (exit 2)', () => {
    try {
      parseInputArgs(['nope']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) expect(err.code).toBe('invalid_invocation');
    }
  });

  it('rejects a token with an empty key (`=value`)', () => {
    expect(() => parseInputArgs(['=v'])).toThrow();
  });

  it('rejects a repeated key rather than silently last-wins', () => {
    try {
      parseInputArgs(['k=a', 'k=b']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.code).toBe('invalid_invocation');
        expect(err.message).toContain('more than once');
      }
    }
  });
});

describe('resolveInputs', () => {
  it('coerces declared types from their string form', () => {
    expect(
      resolveInputs(TYPED_INPUTS, { count: '42', flag: 'true', title: 'hi', needed: 'x' }),
    ).toEqual({
      count: 42,
      flag: true,
      title: 'hi',
      needed: 'x',
    });
  });

  it('accepts 1/0 as boolean shorthands', () => {
    expect(resolveInputs(TYPED_INPUTS, { flag: '1', needed: 'x' })).toMatchObject({ flag: true });
    expect(resolveInputs(TYPED_INPUTS, { flag: '0', needed: 'x' })).toMatchObject({ flag: false });
  });

  it('rejects a non-numeric number input', () => {
    try {
      resolveInputs(TYPED_INPUTS, { count: 'abc', needed: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) expect(err.code).toBe('invalid_invocation');
    }
  });

  it('rejects an empty number value (Number("") would silently be 0)', () => {
    try {
      resolveInputs(TYPED_INPUTS, { count: '', needed: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) expect(err.code).toBe('invalid_invocation');
    }
    expect(() => resolveInputs(TYPED_INPUTS, { count: '   ', needed: 'x' })).toThrow();
  });

  it('accepts a literal zero for a number input', () => {
    expect(resolveInputs(TYPED_INPUTS, { count: '0', needed: 'x' })).toMatchObject({ count: 0 });
  });

  it('accepts decimal, negative, and scientific number forms', () => {
    expect(resolveInputs(TYPED_INPUTS, { count: '3.14', needed: 'x' })).toMatchObject({
      count: 3.14,
    });
    expect(resolveInputs(TYPED_INPUTS, { count: '-5', needed: 'x' })).toMatchObject({ count: -5 });
    expect(resolveInputs(TYPED_INPUTS, { count: '1e3', needed: 'x' })).toMatchObject({
      count: 1000,
    });
  });

  it('rejects radix/hex number literals (0x10 would silently be 16)', () => {
    for (const radix of ['0x10', '0o17', '0b11']) {
      expect(() => resolveInputs(TYPED_INPUTS, { count: radix, needed: 'x' })).toThrow();
    }
  });

  it('rejects a non-boolean boolean input', () => {
    expect(() => resolveInputs(TYPED_INPUTS, { flag: 'yes', needed: 'x' })).toThrow();
  });

  it('rejects an unknown input key', () => {
    try {
      resolveInputs(TYPED_INPUTS, { bogus: '1', needed: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) expect(err.code).toBe('invalid_invocation');
    }
  });

  it('rejects a missing required input', () => {
    expect(() => resolveInputs(TYPED_INPUTS, {})).toThrow();
  });

  it('omits an absent optional input so the engine applies its default', () => {
    expect(resolveInputs(TYPED_INPUTS, { needed: 'x' })).toEqual({ needed: 'x' });
  });

  it('accepts an empty raw map when the workflow declares no inputs', () => {
    expect(resolveInputs(NO_INPUTS, {})).toEqual({});
  });

  it('carries `__proto__`, `constructor` and `toString` as ordinary inputs (ADR-0083 §9.7, CLI path)', () => {
    // §9.7 requires these three to round-trip "on the CLI path AND the engine path". The engine half and
    // `relavium gate`'s secret merge were pinned; this — the PRIMARY `relavium run --input` path — was not,
    // and it was broken. On a plain `{}` accumulator `out['__proto__'] = 'x'` goes through
    // `Object.prototype`'s accessor: a string value is a silent no-op, so the input vanished with no own
    // property and no error; the later read then answered `Object.prototype`, which a `number`-typed input
    // handed to `coerce`, throwing an untyped `TypeError` that surfaced as "an unexpected internal error".
    // `constructor` and `toString` are ordinary writable data properties and were never affected — they are
    // here so the acceptance criterion is covered as written.
    const raw = parseInputArgs(['__proto__=p', 'constructor=c', 'toString=t']);
    expect(Object.getOwnPropertyNames(raw).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(raw['__proto__']).toBe('p');

    const wf = workflowWithInputs(`  inputs:
    - { name: __proto__, type: string }
    - { name: constructor, type: string }
    - { name: toString, type: string }`);
    const resolved = resolveInputs(wf, raw);
    expect(Object.getOwnPropertyNames(resolved).sort()).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ]);
    expect(resolved['__proto__']).toBe('p');
    expect(({} as Record<string, unknown>)['p']).toBeUndefined(); // nothing leaked onto the prototype
  });

  it('treats an OMITTED `__proto__` input as omitted, even from a plain-object raw map', () => {
    // `resolveInputs` takes `raw` from a caller, and a caller may hand it an ordinary literal. Reading
    // `raw['__proto__']` off one answers `Object.prototype` — an object, not `undefined` — so an input the
    // user never supplied looked PRESENT: the "missing required input" refusal never fired and `coerce`
    // received an object. `Object.hasOwn` before the read is what makes absent mean absent.
    const wf = workflowWithInputs(`  inputs:
    - { name: __proto__, type: string, required: true }`);
    try {
      resolveInputs(wf, {});
      expect.unreachable('an omitted required input must be refused');
    } catch (error) {
      expect(isCliError(error) && error.code).toBe('invalid_invocation');
      expect(isCliError(error) && error.message).toContain('missing required input');
    }
  });

  it('a `number` input named `__proto__` coerces instead of throwing an untyped TypeError', () => {
    // The sharpest symptom of the same defect: `coerce` called `.trim()` on `Object.prototype`, and the
    // resulting `TypeError` was not a `CliError` — it escaped the surface's typed-error contract entirely.
    const wf = workflowWithInputs(`  inputs:
    - { name: __proto__, type: number }`);
    expect(resolveInputs(wf, parseInputArgs(['__proto__=3']))['__proto__']).toBe(3);
    // …and a genuinely non-numeric value is still the CLEAN exit-2 fault, not a raw throw.
    try {
      resolveInputs(wf, parseInputArgs(['__proto__=abc']));
      expect.unreachable('a non-numeric value must be refused');
    } catch (error) {
      expect(isCliError(error) && error.code).toBe('invalid_invocation');
    }
  });
});
