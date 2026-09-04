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

  it('accepts optional chaining — the same literal access, written another way', () => {
    expect(ids('run?.outputs["a"]')).toEqual(['a']);
    expect(ids('run?.outputs?.["a"]')).toEqual(['a']);
    expect(ids('run?.outputs?.gate')).toEqual(['gate']);
  });

  it('does NOT match a member access separated by whitespace or a comment', () => {
    // A single-character lookbehind saw only what sits immediately before `run`, and JavaScript allows
    // whitespace and comments between the `.` and the property name. Five valid member accesses on
    // OTHER objects slipped through as scope reads. The anchoring is a backward walk now.
    expect(ids('a . run.outputs["x"]')).toEqual([]);
    expect(ids('a ?. run.outputs["x"]')).toEqual([]);
    expect(ids('a./*c*/run.outputs["x"]')).toEqual([]);
    expect(ids('a["k"] . run.outputs["x"]')).toEqual([]);
    expect(ids('this . run.outputs["x"]')).toEqual([]);
    expect(ids('a\n . run.outputs["x"]')).toEqual([]);
    // …while a genuine read separated from an operator by the same whitespace is still found.
    expect(ids('1 + run.outputs["ok"]')).toEqual(['ok']);
    expect(ids('"s" + run.outputs["ok"]')).toEqual(['ok']);
    expect(ids('  run.outputs["ok"]')).toEqual(['ok']);
  });

  it('does NOT match `run.outputs` on another object — the one false-refusal shape', () => {
    // `\brun` matched the `run` in `foo.run.outputs["x"]`, and an author can reach such an object through
    // `inputs` or `ctx`. Refusing it would break a workflow for a read that is not there — precisely the
    // failure ADR-0093 §2 forbids, and the reason the pattern uses a lookbehind rather than a boundary.
    expect(ids('foo.run.outputs["x"]')).toEqual([]);
    expect(ids('inputs.run.outputs["x"]')).toEqual([]);
    expect(ids('ctx?.run?.outputs?.["x"]')).toEqual([]);
    expect(ids('myrun.outputs["x"]')).toEqual([]);
    // `\w` is ASCII-only, but a JavaScript identifier may contain any Unicode ID_Continue character, so
    // `çrun` is an unrelated identifier that every ASCII guard let through. The expression below is a
    // self-contained object literal that never touches the scope — verified in the real sandbox.
    expect(ids('{["çrun"]: {outputs: {ghost: 1}}}.çrun.outputs["ghost"]')).toEqual([]);
    expect(ids('x.çrun.outputs.gate')).toEqual([]);
    expect(ids('日本語run.outputs["x"]')).toEqual([]);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    expect(ids('run.outputs["b"] + run.outputs["a"] + run.outputs["b"]')).toEqual(['b', 'a']);
  });
});

describe('literalOutputReads — the match is linear, not quadratic', () => {
  it('does not backtrack super-linearly on a long whitespace run', () => {
    // `outputs\s*\??\.?\s*\[` put two independently-optional characters between two `\s*`, so a
    // whitespace run with no `[` after it could be split at every position. Measured before the fix:
    // 8.6 ms at 4 K, 39 ms at 8 K, 115 ms at 16 K, 514 ms at 32 K — and the parser accepts a 2 MiB source
    // while plan build is synchronous, so no deadline or cancel can interrupt it. Now ~6 ms at 128 K.
    const evil = (n: number): string => `run${' '.repeat(n)}.outputs${' '.repeat(n)}x`;
    const time = (text: string): number => {
      const started = process.hrtime.bigint();
      literalOutputReads(text);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    // Bounded on the SHAPE of the growth, not on a wall-clock number a slow machine could breach: the
    // quadratic form grew ~4.5× per doubling, so anything near linear passes and the defect cannot.
    time(evil(8_000)); // warm
    const small = Math.max(time(evil(16_000)), 0.05);
    const large = time(evil(64_000));
    expect(large / small).toBeLessThan(12); // quadratic would be ~16×
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

  it('abandons the scan at any `/` it cannot classify as a comment', () => {
    // Regex-vs-division is the one genuinely hard part of lexing JS, and guessing wrong is NOT silence: a
    // regex with an odd number of quotes shifts every later string boundary by one, so a real string's
    // contents become code — and a second odd-quoted regex restores parity, so the mask terminates
    // cleanly and a FABRICATED read survives. Both shapes below go silent instead.
    expect(ids('/["]/.test(x) && run.outputs["a"]')).toEqual([]);
    expect(ids('/["]/ .test(a) + /["]/ .test(b) + "x run.outputs[\'ghost\'] y"')).toEqual([]);
    // The cost, stated rather than hidden: an expression containing division is never scanned.
    expect(ids('run.outputs["a"] / 2')).toEqual([]);
  });

  it('abandons the scan on a nested template literal', () => {
    // `${` inside a template opens CODE that may contain another template. Pairing backticks flat leaves
    // the inner template's TEXT marked as code — a false-find shape, not a missed read.
    expect(ids('`a ${ `run.outputs["ghost"]` } b`')).toEqual([]);
    expect(ids('`${x}` + run.outputs["a"]')).toEqual([]);
  });

  it('abandons the scan on an HTML-like comment (Annex B, which QuickJS accepts)', () => {
    expect(ids('<!-- run.outputs["ghost"]')).toEqual([]);
    expect(ids('x\n--> run.outputs["ghost"]')).toEqual([]);
  });

  it('says nothing when an identifier ESCAPE is present — `r\\u0075n` IS `run` to JavaScript', () => {
    // The guard that closed the eighth false-refusal shape, and nothing exercised it: deleting it left the
    // suite green. `((r\u0075n) => run.outputs["ghost"])(…)` binds a LOCAL `run`, so reporting `ghost`
    // would refuse a workflow for a read the real sandbox never performs.
    expect(ids('((r\\u0075n) => run.outputs["ghost"])({outputs:{ghost:1}})')).toEqual([]);
    expect(ids('r\\u0075n.outputs["ghost"]')).toEqual([]);
    // A backslash inside a STRING is masked before the check, so an ordinary expression still scans.
    expect(ids('"a\\nb" + run.outputs["a"]')).toEqual(['a']);
  });

  it('says nothing when `run` is REBOUND — the shadow is not the scope', () => {
    // `((run) => run.outputs["total"])(inputs.alias)` evaluates against something else entirely; naming
    // `total` would be a false refusal. A use of the scope's `run` is always `run.`/`run?.`, so any other
    // occurrence is treated as possibly a binding and the whole expression goes unscanned.
    expect(ids('((run) => run.outputs["total"])(inputs.alias)')).toEqual([]);
    expect(ids('(({ run }) => run.outputs["total"])(inputs)')).toEqual([]);
    expect(ids('typeof run === "object" ? run.outputs["a"] : 0')).toEqual([]);
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
