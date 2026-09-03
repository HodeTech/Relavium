import { describe, expect, it } from 'vitest';

import { literalOutputReads, maskLiterals } from './literal-output-reads.js';

const ids = (expression: string): readonly string[] =>
  literalOutputReads(expression).map((r) => r.id);

describe('literalOutputReads — what it SEES', () => {
  it('finds a bracket access in both quote styles', () => {
    expect(ids('run.outputs["a"] === 1')).toEqual(['a']);
    expect(ids("run.outputs['b'] === 1")).toEqual(['b']);
  });

  it('finds a dot access', () => {
    expect(ids('run.outputs.gate === true')).toEqual(['gate']);
  });

  it('finds a kebab-case id, which is only reachable through a bracket', () => {
    expect(ids('run.outputs["my-node"].status')).toEqual(['my-node']);
  });

  it('tolerates whitespace the author is free to write', () => {
    expect(ids('run . outputs [ "a" ] > 0')).toEqual(['a']);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    expect(ids('run.outputs["b"] + run.outputs["a"] + run.outputs["b"]')).toEqual(['b', 'a']);
  });
});

describe('literalOutputReads — where it deliberately says NOTHING', () => {
  // Each of these is a read the scan cannot resolve. ADR-0093 §2 makes silence the contract: the scan
  // only ever REFUSES, so being incomplete is safe, while guessing would refuse a valid workflow.
  it('says nothing about a computed key', () => {
    expect(ids('run.outputs[key]')).toEqual([]);
    expect(ids('run.outputs[ids[0]]')).toEqual([]);
  });

  it('says nothing about a template-literal key', () => {
    expect(ids('run.outputs[`${prefix}-node`]')).toEqual([]);
  });

  it('says nothing about an aliased binding', () => {
    expect(ids('((o) => o["a"])(run.outputs)')).toEqual([]);
  });

  it('says nothing about an access written inside a string', () => {
    // A FALSE REFUSAL is the one failure this scan must not have: it would break a workflow that loads
    // today for a read that is not there. Masking string literals is what buys that.
    expect(ids('"run.outputs[\\"a\\"]"')).toEqual([]);
    expect(ids("'run.outputs.gate'")).toEqual([]);
    expect(ids('`run.outputs["a"]`')).toEqual([]);
  });

  it('says nothing about an access written inside a comment', () => {
    expect(ids('1 // run.outputs["a"]')).toEqual([]);
    expect(ids('/* run.outputs["a"] */ 1')).toEqual([]);
  });

  it('abandons the whole scan when the text ends inside a literal or block comment', () => {
    // Not "scan what we can" — an unterminated literal means the masker has lost track of what is code,
    // so anything it reports afterwards is a guess. Silence is the only safe answer.
    expect(ids('run.outputs["a"] + "unterminated')).toEqual([]);
    expect(ids('run.outputs["a"] /* unterminated')).toEqual([]);
    expect(maskLiterals('"unterminated')).toBeUndefined();
  });

  it('mis-lexes a regex containing a quote — and fails toward silence, never a false find', () => {
    // The scan is not a JS lexer. Here the quote inside the regex opens a "string" that swallows the
    // real access, so the read is MISSED. That is the acceptable direction: the narrowed scope is still
    // the backstop, and no valid workflow is refused.
    expect(ids('/["]/.test(x) && run.outputs["a"]')).toEqual([]);
  });
});

describe('maskLiterals — a position map, not a substitute input', () => {
  it('preserves length exactly, so a match index means the same thing in both strings', () => {
    for (const text of ['a"bc"d', "x + 'y' + z", '1 /* xx */ 2', 'a // b']) {
      expect(maskLiterals(text)?.length).toBe(text.length);
    }
  });

  it('handles an escaped quote inside a string', () => {
    expect(ids('"a\\"b" + run.outputs["real"]')).toEqual(['real']);
  });

  it('marks literal positions and leaves code positions alone', () => {
    const masked = maskLiterals('x + "ab"') ?? '';
    expect(masked.slice(0, 4)).toBe('x + '); // code, untouched
    expect(masked.slice(4)).toBe('\u0000'.repeat(4)); // the literal, masked
  });
});
