import { describe, expect, it } from 'vitest';
import { layoutMarkdown, parseMarkdown } from './index.js';
import { BlockLineClassifier, closesMarkdownFence, isSetextPair } from './parser.js';

const rows = (source: string, width = 80): string[] =>
  layoutMarkdown(parseMarkdown(source), width).map((line) => line.text);

describe('block parser regressions', () => {
  it('uses displayed container columns for structural tabs', () => {
    expect(rows('> - x\n> \tcontinued')).toEqual(['│ • x', '│       continued']);
    expect(rows(' > - x\n > \tcontinued')).toEqual(['│ • x', '│       continued']);
    expect(rows('>>- x\n>>\tcontinued')).toEqual(['│ │ • x', '│ │     continued']);
    expect(rows('> 12. x\n> \tcontinued')).toEqual(['│ 12. x', '│       continued']);
  });

  it('keeps prose together before an actual table, including fallback tables', () => {
    const source = 'one\ntwo\n| --- | --- |\n| --- | --- |';
    expect(parseMarkdown(source).map((block) => block.kind)).toEqual(['paragraph', 'table']);
    expect(rows(source)[0]).toBe('one two');
    expect(rows('one\ntwo\n| h | h |\n| --- | --- |', 8).slice(0, 3)).toEqual([
      'one two',
      '| h | h ',
      '|',
    ]);
    const header = `| ${'x'.repeat(65524)} |`;
    const table = `${header}\n| --- |`;
    expect(table.length).toBe(65536);
    expect(parseMarkdown(`one\ntwo\n${table}`).map((block) => block.kind)).toEqual([
      'paragraph',
      'table',
    ]);
    expect(
      parseMarkdown(`one\ntwo\n| ${'x'.repeat(65525)} |\n| --- |`).map((block) => block.kind),
    ).toEqual(['paragraph', 'literal']);
  });

  it('shares static Setext eligibility, including indented literal headers', () => {
    expect(isSetextPair('    x', '---')).toBe(true);
    expect(isSetextPair('# heading', '---')).toBe(false);
    expect(isSetextPair('x', '--')).toBe(false);
    expect(parseMarkdown('    x\n---\n\nEND').map((block) => block.kind)).toEqual([
      'literal',
      'literal',
      'paragraph',
    ]);
  });

  it('retains lazy dedents literally after a list marker', () => {
    const source = '*  \n_é~~[a](https://x.test)\tEND\n*\tEND';
    const blocks = parseMarkdown(source);
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'literal', 'literal']);
    expect(blocks.slice(1).every((block) => block.raw)).toBe(true);
    expect(blocks.map((block) => block.source).join('\n')).toBe(source);
  });

  it('keeps list state across previews and committed lines', () => {
    const classifier = new BlockLineClassifier();
    classifier.commit('*  ');
    const line = '_é~~[a](https://x.test)\tEND';
    expect(classifier.preview(line).block).toMatchObject({ kind: 'literal', raw: true });
    expect(classifier.preview(line).block).toMatchObject({ kind: 'literal', raw: true });
    expect(classifier.commit(line).block).toMatchObject({ kind: 'literal', raw: true });
    expect(classifier.commit('*\tEND').block).toMatchObject({ kind: 'literal', raw: true });
    classifier.reset();
    expect(classifier.commit(line).block.kind).toBe('paragraph');
  });

  it('revises an indented Setext header when the underline arrives', () => {
    const classifier = new BlockLineClassifier();
    expect(classifier.commit('    x').block.kind).toBe('literal');
    expect(classifier.preview('---')).toMatchObject({
      block: { kind: 'literal', text: '---' },
      revision: { kind: 'literal', text: '    x' },
    });
    expect(classifier.commit('---')).toMatchObject({
      block: { kind: 'literal' },
      revision: { kind: 'literal' },
    });
  });

  it('revises Setext pairs inside quote and list containers', () => {
    for (const [header, underline, prefix] of [
      ['> Title', '> ---', '│ '],
      ['- > Title', '  > ---', '  │ '],
    ] satisfies [string, string, string][]) {
      const canonical = parseMarkdown(`${header}\n${underline}`);
      expect(canonical[0]?.kind).toBe('literal');
      const classifier = new BlockLineClassifier();
      classifier.commit(header);
      const result = classifier.commit(underline);
      expect(result.block).toMatchObject({ kind: 'literal', prefix });
      expect(result.revision).toMatchObject({ kind: 'literal', source: header });
    }
  });

  it('revises recognized table headers and holds table rows as raw geometry', () => {
    for (const [header, delimiter, body] of [
      ['| h |', '| --- |', '| **raw** |'],
      ['> | h |', '> | --- |', '> | **raw** |'],
      ['- | h |', '  | --- |', '  | **raw** |'],
      ['> - | h |', '>   | --- |', '>   | **raw** |'],
    ] satisfies [string, string, string][]) {
      expect(parseMarkdown(`${header}\n${delimiter}\n${body}`)[0]?.kind).toBe('table');
      const classifier = new BlockLineClassifier();
      classifier.commit(header);
      expect(classifier.commit(delimiter)).toMatchObject({
        block: { kind: 'literal' },
        revision: { kind: 'literal', source: header },
      });
      expect(classifier.commit(body).block.kind).toBe('literal');
    }
  });

  it('requests the prior marker prefix for table revisions without retaining it', () => {
    const marker = '1234567890'.repeat(1000) + '.';
    const classifier = new BlockLineClassifier();
    classifier.commit(`${marker} | h |`);
    expect(classifier.commit(`${' '.repeat(marker.length + 1)}| --- |`)).toMatchObject({
      revision: { kind: 'literal' },
      preserveRevisionPrefix: true,
    });
  });

  it('recognizes a table after a lazy list continuation', () => {
    const lines = ['- item', '| h |', '| --- |', '| row |'];
    expect(parseMarkdown(lines.join('\n')).map((block) => block.kind)).toEqual(['list', 'table']);
    const classifier = new BlockLineClassifier();
    classifier.commit(lines[0] ?? '');
    classifier.commit(lines[1] ?? '');
    expect(classifier.commit(lines[2] ?? '')).toMatchObject({
      block: { kind: 'literal' },
      revision: { kind: 'literal', source: '| h |' },
    });
    expect(classifier.commit(lines[3] ?? '').block.kind).toBe('literal');
  });

  it('reports paragraph scopes across quote and list boundaries', () => {
    const cases = [
      { lines: ['one', 'two'], continues: [false, true] },
      { lines: ['> one', '> two'], continues: [false, true] },
      { lines: ['> one', '> \ttwo'], continues: [false, true] },
      { lines: ['- > one', '  > two'], continues: [false, true] },
      { lines: ['- one', '- two'], continues: [false, false] },
      { lines: ['# one', 'two'], continues: [false, false] },
      { lines: ['> one', '>> two'], continues: [false, false] },
    ];
    for (const { lines, continues } of cases) {
      const classifier = new BlockLineClassifier();
      expect(lines.map((line) => classifier.commit(line).continuesParagraph)).toEqual(continues);
    }
  });

  it('matches paragraph scope under a long ordered marker', () => {
    const marker = '1234567890'.repeat(1000) + '.';
    const classifier = new BlockLineClassifier();
    classifier.commit(`${marker} > first`);
    expect(classifier.commit(`${' '.repeat(marker.length + 1)}> next`).continuesParagraph).toBe(
      true,
    );
  });

  it('keeps tab-leading physical lines in an existing paragraph', () => {
    const lines = [
      `p ${'x'.repeat(4000)}__`,
      '\té\tx',
      '\\*[**x**](**x**)__👩‍💻x👩‍💻__~~``[a](https://x.test)é**',
      '\tEND',
    ];
    expect(parseMarkdown(lines.join('\n'))).toMatchObject([
      { kind: 'paragraph', text: lines.join('\n') },
    ]);
    const classifier = new BlockLineClassifier();
    for (const [index, line] of lines.entries()) {
      expect(classifier.preview(line)).toMatchObject({
        block: { kind: 'paragraph' },
        continuesParagraph: index > 0,
      });
      expect(classifier.commit(line)).toMatchObject({
        block: { kind: 'paragraph' },
        continuesParagraph: index > 0,
      });
    }
  });

  it('maps structural source tabs to residual list indentation', () => {
    const classifier = new BlockLineClassifier();
    classifier.commit('1. a');
    const result = classifier.commit('\tb\t');
    expect(result.block).toMatchObject({ kind: 'list', text: '     b\t', prefix: '   ' });
    expect(result.listProjection).toEqual({ sourcePrefixLength: 1, textPrefix: '     ' });
    const quote = new BlockLineClassifier();
    quote.commit('> - a');
    expect(quote.commit('> \tb\t').listProjection).toEqual({
      sourcePrefixLength: 3,
      textPrefix: '    ',
    });
    const nested = new BlockLineClassifier();
    nested.commit('12345. # h');
    expect(nested.commit('\t tail\t')).toMatchObject({
      block: { kind: 'paragraph', text: '  tail\t', prefix: '       ' },
      listProjection: { sourcePrefixLength: 1, textPrefix: ' ' },
    });
    const literal = new BlockLineClassifier();
    literal.commit('- > a');
    expect(literal.commit('\t> b\t')).toMatchObject({
      block: { kind: 'literal', text: '      > b\t', prefix: '  ' },
      listProjection: { sourcePrefixLength: 1, textPrefix: '      ' },
    });
    const partial = new BlockLineClassifier();
    expect(partial.preview('1. ').block.kind).toBe('list');
    expect(partial.preview('1. \t').block.kind).toBe('paragraph');
    expect(partial.preview('1. \t').listProjection).toBeUndefined();
  });

  it('keeps the active list when a contained fence ends by dedenting', () => {
    for (const lines of [
      ['- ```', '*x*'],
      ['- ```', 'a', '`x`'],
      ['> - ```', '> x'],
    ]) {
      const classifier = new BlockLineClassifier();
      const actual = lines.map((line) => classifier.commit(line).block);
      expect(actual).toEqual(parseMarkdown(lines.join('\n')));
    }
  });

  it('retains quoted list state over physical lines', () => {
    const classifier = new BlockLineClassifier();
    const lines = ['> - x', '> \tcontinued'];
    const parsed = parseMarkdown(lines.join('\n'));
    expect(lines.map((line) => classifier.commit(line).block)).toEqual(parsed);
  });

  it('matches static blocks through list siblings, nested quotes, and lazy dedents', () => {
    for (const lines of [
      ['- a', '  - b', '  - c', '  tail', 'dedent', 'more'],
      ['- a | b', '  continuation', '  more'],
      ['> - a', '>   - b', '>   - c', '>   tail', '> dedent', '> more'],
      ['- > - a', '  >   tail', '  > dedent', '  > more'],
      ['- a', ...Array.from({ length: 40 }, () => '  - sibling'), '  tail'],
    ]) {
      const classifier = new BlockLineClassifier();
      const live = lines.map((line) => classifier.commit(line).block);
      expect(live).toEqual(parseMarkdown(lines.join('\n')));
    }
  });

  it('retains fenced-code state across lines inside quotes', () => {
    const classifier = new BlockLineClassifier();
    expect(classifier.commit('> ```').block.kind).toBe('code');
    expect(classifier.commit('> **literal**').block).toMatchObject({
      kind: 'code',
      text: '**literal**',
      prefix: '│ ',
    });
    expect(classifier.commit('> ```').block).toMatchObject({ kind: 'code', text: '' });
    expect(classifier.commit('> after').block.kind).toBe('paragraph');
  });

  it('uses displayed columns for tabbed quoted list fence bodies', () => {
    const classifier = new BlockLineClassifier();
    classifier.commit('> - ```');
    expect(classifier.commit('> \tcode').block).toMatchObject({
      kind: 'code',
      prefix: '│   ',
      text: '    code',
    });
  });

  it('reports fence boundaries and blank body ownership through containers', () => {
    for (const [open, blank, close] of [
      ['```', '', '```\t'],
      ['> ```', '> ', '> ```\t'],
      ['- ```', '', '  ```\t'],
      ['> - ~~~', '> ', '>   ~~~\t'],
    ] satisfies [string, string, string][]) {
      const classifier = new BlockLineClassifier();
      expect(classifier.commit(open)).toMatchObject({
        block: { kind: 'code' },
        fenceBoundary: 'open',
      });
      expect(classifier.commit(blank)).toMatchObject({ block: { kind: 'code', text: '' } });
      expect(classifier.commit(close)).toMatchObject({
        block: { kind: 'code' },
        fenceBoundary: 'close',
      });
    }
    const nested = new BlockLineClassifier();
    expect(nested.commit('- 1. ```').fenceBoundary).toBe('open');
    expect(nested.commit('').block.kind).toBe('literal');
  });

  it('keeps root leading tabs distinct from four source spaces', () => {
    const tab = '\t**x**';
    const spaces = '    **x**';
    expect(parseMarkdown(tab)[0]?.kind).toBe('paragraph');
    expect(parseMarkdown(spaces)[0]?.kind).toBe('literal');
    expect(rows(tab)).toEqual(['        x']);
    expect(rows(spaces)).toEqual(['    **x**']);
    expect(layoutMarkdown(parseMarkdown(tab), 80)[0]?.spans).toContainEqual({
      text: 'x',
      strong: true,
    });
    expect(new BlockLineClassifier().commit(tab).block.kind).toBe('paragraph');
    expect(new BlockLineClassifier().commit(spaces).block.kind).toBe('literal');
  });

  it('accepts tab-suffixed fence closers without accepting trailing text', () => {
    expect(closesMarkdownFence('   ````\t  ', '```')).toBe(true);
    expect(closesMarkdownFence('    ```\t', '```')).toBe(false);
    expect(closesMarkdownFence('```\ttext', '```')).toBe(false);
    expect(closesMarkdownFence('~~\t', '~~~')).toBe(false);
    for (const fence of ['```', '~~~']) {
      for (const opener of [fence, `> ${fence}`, `- ${fence}`]) {
        const prefix = opener.startsWith('>') ? '> ' : opener.startsWith('-') ? '  ' : '';
        const source = `${opener}\n${prefix}body\n${prefix}${fence}\t\nafter`;
        const blocks = parseMarkdown(source);
        expect(blocks[0]).toMatchObject({ kind: 'code', text: 'body' });
        expect(blocks.at(-1)?.source).toBe('after');
      }
      expect(parseMarkdown(`${fence}\nbody\n${fence}\tx\nafter`)[0]).toMatchObject({
        kind: 'code',
        text: `body\n${fence}\tx\nafter`,
      });
    }
  });

  it('retains literal fallback and blank ownership after contained fences', () => {
    for (const [source, kinds] of [
      [' - ```\n\n*x*\n\nout', ['code', 'code', 'literal', 'literal', 'paragraph']],
      [' - ```\n\n  - # hi\n\nend', ['code', 'code', 'literal', 'literal', 'paragraph']],
      ['  - a\n    ```\n\n# h', ['list', 'code', 'code', 'heading']],
      ['  1. a\n\t```\n\n# h', ['list', 'code', 'code', 'heading']],
    ] satisfies [string, string[]][]) {
      const classifier = new BlockLineClassifier();
      const blocks = source.split('\n').map((line) => classifier.commit(line).block);
      expect(blocks.map((block) => block.kind)).toEqual(kinds);
      const raw = blocks.find((block) => block.source === '*x*' || block.source === '  - # hi');
      if (raw) expect(raw).toMatchObject({ kind: 'literal', text: raw.source, raw: true });
      expect(parseMarkdown(source).at(-1)?.kind).toBe(kinds.at(-1));
    }
  });

  it('preserves long dedented literal content after a contained fence', () => {
    const text = '*x*'.repeat(2000) + '\tend';
    const opener = ' - ```';
    const source = `${opener}\n\n${text}\n\nout`;
    const classifier = new BlockLineClassifier();
    classifier.commit(opener);
    classifier.commit('');
    expect(classifier.preview(text.slice(0, 256)).block).toMatchObject({
      kind: 'literal',
      raw: true,
    });
    expect(classifier.commit(text).block).toMatchObject({
      kind: 'literal',
      source: text,
      text,
      raw: true,
    });
    expect(parseMarkdown(source)[1]).toMatchObject({ kind: 'literal', source: text, raw: true });
  });

  it('keeps blank lines inside a list fence', () => {
    const classifier = new BlockLineClassifier();
    for (const line of ['- ```', '  a', '', '  b', '  ```']) {
      expect(classifier.commit(line).block.kind).toBe('code');
    }
    const final = classifier.commit('after').block;
    const canonical = parseMarkdown('- ```\n  a\n\n  b\n  ```\nafter');
    expect(final.kind).toBe(canonical.at(-1)?.kind);
  });

  it('ends a nested list fence group on an outer unindented blank', () => {
    for (const fence of ['```', '~~~']) {
      const lines = [`- 1. ${fence}`, '', '\tb\t'];
      const classifier = new BlockLineClassifier();
      const actual = lines.map((line) => classifier.commit(line).block);
      expect(actual).toEqual(parseMarkdown(lines.join('\n')));
      expect(actual[1]).toMatchObject({ kind: 'literal', source: '' });
      expect(actual[2]).toMatchObject({ kind: 'paragraph', source: '\tb\t', text: '\tb\t' });
    }
  });

  it('retains literal depth overflow with incremental container state', () => {
    for (const lines of [
      ['> '.repeat(9) + 'overflow', '> '.repeat(8) + 'admitted'],
      ['- '.repeat(9) + 'overflow', 'plain'],
      ['> - '.repeat(9) + 'overflow', '> - ok'],
    ]) {
      const classifier = new BlockLineClassifier();
      expect(lines.map((line) => classifier.commit(line).block)).toEqual(
        parseMarkdown(lines.join('\n')),
      );
    }
  });

  it('preserves nesting overflow source and narrow fallback', () => {
    const source = '> - '.repeat(9) + 'x';
    expect(rows(source, 200)).toEqual([source]);
    expect(parseMarkdown(source)[0]).toMatchObject({ source, raw: true });
    for (const width of [1, 2]) {
      expect(rows('> - x\n> \tcontinued', width).join('')).toContain('continued');
    }
  });
});
