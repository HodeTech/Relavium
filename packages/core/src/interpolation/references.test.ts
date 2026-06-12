import { describe, expect, it } from 'vitest';

import {
  parseTemplate,
  templateReferences,
  type InterpolationReference,
  type TemplateSegment,
} from './references.js';

/** Narrow a segment to its reference, failing the test if it is a literal. */
function refOf(segment: TemplateSegment | undefined): InterpolationReference {
  if (segment?.kind !== 'reference') {
    throw new Error('expected a reference segment');
  }
  return segment.reference;
}

describe('parseTemplate', () => {
  it('returns a single literal segment when there is no interpolation', () => {
    expect(parseTemplate('just plain text')).toEqual([
      { kind: 'literal', text: 'just plain text' },
    ]);
  });

  it('returns no segments for an empty string', () => {
    expect(parseTemplate('')).toEqual([]);
  });

  it('parses an `inputs` reference', () => {
    expect(parseTemplate('{{inputs.file_path}}')).toEqual([
      {
        kind: 'reference',
        reference: {
          kind: 'inputs',
          identifier: 'file_path',
          path: '',
          filters: [],
          raw: '{{inputs.file_path}}',
        },
      },
    ]);
  });

  it('parses a `ctx` reference between literal text', () => {
    const segments = parseTemplate('Review:\n{{ctx.code_content}}\n');
    expect(segments.map((s) => s.kind)).toEqual(['literal', 'reference', 'literal']);
    expect(refOf(segments[1])).toMatchObject({ kind: 'ctx', identifier: 'code_content', path: '' });
  });

  it('parses a node-output reference (`run.outputs[...]`) with a trailing path', () => {
    const ref = refOf(parseTemplate('{{run.outputs["security-scan-node"].score}}')[0]);
    expect(ref).toMatchObject({ kind: 'node', identifier: 'security-scan-node', path: '.score' });
  });

  it('parses a node-output reference with no trailing path', () => {
    const ref = refOf(parseTemplate('{{ run.outputs["style-review-node"] }}')[0]);
    expect(ref).toMatchObject({ kind: 'node', identifier: 'style-review-node', path: '' });
  });

  it('parses a single pipe filter with no arguments', () => {
    const ref = refOf(parseTemplate('{{run.outputs["n"].issues | length}}')[0]);
    expect(ref.path).toBe('.issues');
    expect(ref.filters).toEqual([{ name: 'length', args: [] }]);
  });

  it('parses a filter with a string argument, keeping the literal verbatim', () => {
    const ref = refOf(parseTemplate('{{run.outputs["g"].decision | default("not required")}}')[0]);
    expect(ref.filters).toEqual([
      { name: 'default', args: [{ type: 'string', value: 'not required' }] },
    ]);
  });

  it('parses multiple filters in order (un-applied)', () => {
    const ref = refOf(parseTemplate('{{inputs.payload | json | length}}')[0]);
    expect(ref.filters.map((f) => f.name)).toEqual(['json', 'length']);
  });

  it('parses numeric and boolean filter arguments', () => {
    const ref = refOf(parseTemplate('{{inputs.x | clamp(0, 10, true)}}')[0]);
    expect(ref.filters[0]?.args).toEqual([
      { type: 'number', value: 0 },
      { type: 'number', value: 10 },
      { type: 'boolean', value: true },
    ]);
  });

  it('classifies a `secrets` reference structurally (no taint judgment — that is 1.L2)', () => {
    expect(refOf(parseTemplate('{{secrets.github_token}}')[0])).toMatchObject({
      kind: 'secrets',
      identifier: 'github_token',
    });
  });

  it('classifies an unrecognized namespace as `unknown`, carrying the raw head', () => {
    expect(refOf(parseTemplate('{{ foo.bar }}')[0])).toMatchObject({
      kind: 'unknown',
      identifier: 'foo.bar',
      path: '',
    });
  });

  it('leaves an unterminated `{{` as literal text (never a malformed reference)', () => {
    expect(parseTemplate('value is {{ inputs.x')).toEqual([
      { kind: 'literal', text: 'value is {{ inputs.x' },
    ]);
  });

  it('parses an empty `{{}}` as an unknown reference with empty identifier', () => {
    const segments = parseTemplate('{{}}');
    expect(segments).toHaveLength(1);
    expect(refOf(segments[0])).toMatchObject({
      kind: 'unknown',
      identifier: '',
      path: '',
      filters: [],
      raw: '{{}}',
    });
  });

  it('parses a whitespace-only `{{ }}` as an unknown reference with empty identifier', () => {
    const segments = parseTemplate('{{ }}');
    expect(segments).toHaveLength(1);
    expect(refOf(segments[0])).toMatchObject({
      kind: 'unknown',
      identifier: '',
      path: '',
      filters: [],
      raw: '{{ }}',
    });
  });

  it('does not split on a pipe inside a filter string argument', () => {
    const ref = refOf(parseTemplate('{{inputs.x | default("a|b")}}')[0]);
    expect(ref.filters).toEqual([{ name: 'default', args: [{ type: 'string', value: 'a|b' }] }]);
  });

  it('treats a bareword (non-quoted, non-numeric) filter argument as a string', () => {
    const ref = refOf(parseTemplate('{{inputs.x | join(and)}}')[0]);
    expect(ref.filters).toEqual([{ name: 'join', args: [{ type: 'string', value: 'and' }] }]);
  });

  it('ignores an empty argument list', () => {
    const ref = refOf(parseTemplate('{{inputs.x | trim()}}')[0]);
    expect(ref.filters).toEqual([{ name: 'trim', args: [] }]);
  });

  it('carries a non-identifier filter name verbatim (the resolver later rejects it)', () => {
    const ref = refOf(parseTemplate('{{inputs.x | 9bad}}')[0]);
    expect(ref.filters).toEqual([{ name: '9bad', args: [] }]);
  });

  it('drops an empty (trailing-comma) filter argument piece', () => {
    const ref = refOf(parseTemplate('{{inputs.x | f(a,)}}')[0]);
    expect(ref.filters).toEqual([{ name: 'f', args: [{ type: 'string', value: 'a' }] }]);
  });

  it('does not let a literal `}}` inside a quoted argument truncate the reference', () => {
    const segments = parseTemplate('{{inputs.x | default("}}")}} tail');
    expect(segments).toEqual([
      {
        kind: 'reference',
        reference: {
          kind: 'inputs',
          identifier: 'x',
          path: '',
          filters: [{ name: 'default', args: [{ type: 'string', value: '}}' }] }],
          raw: '{{inputs.x | default("}}")}}',
        },
      },
      { kind: 'literal', text: ' tail' },
    ]);
  });

  it('does not let a literal `}}` inside a bracket key truncate the reference', () => {
    const ref = refOf(parseTemplate('{{run.outputs["a}}b"].score}}')[0]);
    expect(ref).toMatchObject({ kind: 'node', identifier: 'a}}b', path: '.score' });
  });

  it('handles an escaped quote inside a filter string argument (does not close the quote early)', () => {
    // `default("say \"hi\"")` — the `\"` must NOT close the string, so the argument is `say "hi"`.
    const ref = refOf(parseTemplate('{{inputs.x | default("say \\"hi\\"")}}')[0]);
    expect(ref.filters).toEqual([
      { name: 'default', args: [{ type: 'string', value: 'say \\"hi\\"' }] },
    ]);
  });

  it('handles an escaped quote inside a filter string argument (single-quote variant)', () => {
    const ref = refOf(parseTemplate("{{inputs.x | default('it\\'s fine')}}")[0]);
    expect(ref.filters).toEqual([
      { name: 'default', args: [{ type: 'string', value: "it\\'s fine" }] },
    ]);
  });

  it('does not let an escaped quote before `}}` terminate the reference', () => {
    // `{{ inputs.x | default("a\\\"") }}` — the `\"` is escaped, the `"` that follows closes the
    // string; the first `}}` after that closes the reference.
    const segments = parseTemplate('{{inputs.x | default("val")}} tail');
    expect(segments[0]?.kind).toBe('reference');
    expect(segments[1]).toEqual({ kind: 'literal', text: ' tail' });
  });

  it('keeps a non-decimal numeric-looking argument a string (no Number() over-acceptance)', () => {
    const ref = refOf(parseTemplate('{{inputs.x | f(0x10, 1e3, Infinity)}}')[0]);
    expect(ref.filters[0]?.args).toEqual([
      { type: 'string', value: '0x10' },
      { type: 'string', value: '1e3' },
      { type: 'string', value: 'Infinity' },
    ]);
  });

  it('parses a plain decimal argument (incl. leading zeros) as a number', () => {
    const ref = refOf(parseTemplate('{{inputs.x | f(007, -2.5)}}')[0]);
    expect(ref.filters[0]?.args).toEqual([
      { type: 'number', value: 7 },
      { type: 'number', value: -2.5 },
    ]);
  });

  it('preserves the verbatim raw of each occurrence for round-trip', () => {
    const ref = refOf(parseTemplate('x {{ ctx.k }} y')[1]);
    expect(ref.raw).toBe('{{ ctx.k }}');
  });
});

describe('templateReferences', () => {
  it('returns only the references, in order', () => {
    const refs = templateReferences('{{inputs.a}} between {{ctx.b}} and {{secrets.c}}');
    expect(refs.map((r) => r.kind)).toEqual(['inputs', 'ctx', 'secrets']);
  });

  it('returns an empty list when there is no interpolation', () => {
    expect(templateReferences('nothing here')).toEqual([]);
  });
});
