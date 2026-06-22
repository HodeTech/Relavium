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
});
