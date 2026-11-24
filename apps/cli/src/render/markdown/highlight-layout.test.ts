import { describe, expect, it } from 'vitest';

import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINE } from './highlight/index.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';
import type { MarkdownDisplayLine, MarkdownSpan } from './types.js';

function layout(source: string, columns = 60): readonly MarkdownDisplayLine[] {
  return layoutMarkdown(parseMarkdown(source), columns);
}

/** Every span of every row, with the gutter and label spans left out. */
function codeSpans(rows: readonly MarkdownDisplayLine[]): MarkdownSpan[] {
  return rows.flatMap((row) => row.spans.filter((span) => span.code === true));
}

describe('a fenced block with a known language is drawn as classed spans (ADR-0144)', () => {
  it('splits the code into spans that keep the code flag and carry their class', () => {
    const rows = layout('```ts\nconst a = 1;\n```');
    expect(rows.map((row) => row.text)).toEqual(['ts', '│ const a = 1;']);
    expect(rows[1]?.spans).toEqual([
      { text: '│ ', dim: true },
      { text: 'const', code: true, token: 'keyword' },
      { text: ' a = ', code: true, token: 'text' },
      { text: '1', code: true, token: 'number' },
      { text: ';', code: true, token: 'text' },
    ]);
  });

  it('keeps two neighbouring classes apart, not merged into one span', () => {
    const spans = codeSpans(layout('```ts\nreturn"x"\n```'));
    expect(spans.map((span) => [span.token, span.text])).toEqual([
      ['keyword', 'return'],
      ['string', '"x"'],
    ]);
  });

  it('leaves a block with no language, or an unknown one, as the single plain code span it always was', () => {
    for (const fence of [
      '```\nconst a = 1;\n```',
      '```text\nconst a = 1;\n```',
      '```mermaid\nconst a = 1;\n```',
    ]) {
      const spans = codeSpans(layout(fence));
      expect(spans).toEqual([{ text: 'const a = 1;', code: true }]);
      expect(spans[0]).not.toHaveProperty('token');
    }
  });

  it('does not change the text of the rows, whatever the language', () => {
    const body = 'const a = "x"; // c\nif (a) { return `y${a}`; }';
    const plain = layout(`\`\`\`\n${body}\n\`\`\``);
    const typed = layout(`\`\`\`ts\n${body}\n\`\`\``);
    // The one row a language adds is its dim label above the block.
    expect(typed.filter((row) => row.text !== 'ts').map((row) => row.text)).toEqual(
      plain.map((row) => row.text),
    );
    expect(typed).toHaveLength(plain.length + 1);
  });

  it('carries each class across a wrapped row, and a wrapped code row keeps its gutter', () => {
    const rows = layout('```ts\nconst name = "a very long string value that wraps";\n```', 24);
    const body = rows.slice(1);
    expect(body.length).toBeGreaterThan(2);
    for (const row of body) expect(row.text.startsWith('│ ')).toBe(true);
    const strings = body.flatMap((row) => row.spans.filter((span) => span.token === 'string'));
    expect(strings.map((span) => span.text).join('')).toBe('"a very long string value that wraps"');
    expect(body.map((row) => row.text.slice(2)).join('')).toBe(
      'const name = "a very long string value that wraps";',
    );
  });

  it('classes the code of a block inside a quote and inside a list', () => {
    const quoted = codeSpans(layout('> ```json\n> {"a": 1}\n> ```'));
    expect(
      quoted.filter((span) => span.token !== 'text').map((span) => [span.token, span.text]),
    ).toEqual([
      ['property', '"a"'],
      ['number', '1'],
    ]);
    const listed = codeSpans(layout('- item\n\n  ```sh\n  ls -la\n  ```'));
    expect(
      listed.filter((span) => span.token !== 'text').map((span) => [span.token, span.text]),
    ).toEqual([
      ['function', 'ls'],
      ['property', '-la'],
    ]);
  });

  it('does not highlight a block over the size limit, or one with a very long line', () => {
    const huge = layout(`\`\`\`ts\n${'a '.repeat(MAX_HIGHLIGHT_CHARS / 2 + 1)}\n\`\`\``, 80);
    expect(codeSpans(huge).every((span) => span.token === undefined)).toBe(true);
    const long = layout(
      `\`\`\`ts\nconst x = 1;\n${'y'.repeat(MAX_HIGHLIGHT_LINE + 1)}\n\`\`\``,
      80,
    );
    expect(codeSpans(long).every((span) => span.token === undefined)).toBe(true);
  });

  it('highlights an unfinished fence as it is, since an unfinished fence is code through the end of the turn', () => {
    const spans = codeSpans(layout('```ts\nconst a = "open'));
    expect(
      spans.filter((span) => span.token !== 'text').map((span) => [span.token, span.text]),
    ).toEqual([
      ['keyword', 'const'],
      ['string', '"open'],
    ]);
  });

  it('highlights a diff block with the classes of an added and a removed line', () => {
    const spans = codeSpans(layout('```diff\n-old\n+new\n```'));
    expect(
      spans.filter((span) => span.token !== 'text').map((span) => [span.token, span.text]),
    ).toEqual([
      ['deleted', '-old'],
      ['inserted', '+new'],
    ]);
  });
});

/** The live tail leaves out the last blank row of a text that ends in a newline; that holds with or without highlighting. */
function withoutTrailingBlanks(
  rows: readonly MarkdownDisplayLine[],
): readonly MarkdownDisplayLine[] {
  const kept = [...rows];
  while (kept.at(-1)?.text === '') kept.pop();
  return kept;
}

describe('a long fence keeps its language in the live tail', () => {
  const line = 'const x = "a"; // c\n';
  const classes = (rows: readonly MarkdownDisplayLine[]): string[] =>
    codeSpans(rows)
      .filter((span) => span.token !== undefined && span.token !== 'text')
      .map((span) => span.token ?? '');

  it('an open fence of more than 4,000 characters is still highlighted while it streams', () => {
    const source = `\`\`\`ts\n${line.repeat(220)}`; // 4,400 characters of code
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += 19) stream.append(source.slice(at, at + 19));
    const rows = stream.tail(60, 6);
    expect(codeSpans(rows).length).toBeGreaterThan(0);
    expect(classes(rows)).toContain('keyword');
    expect(classes(rows)).toContain('string');
    expect(classes(rows)).toContain('comment');
  });

  it('a closed block of 4,000 characters or more, then more text, is still highlighted', () => {
    const source = `\`\`\`typescript\n${line.repeat(210)}\`\`\`\n\nThen some prose that streams in after it.`;
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += 23) stream.append(source.slice(at, at + 23));
    const rows = stream.tail(60, 400);
    expect(classes(rows)).toContain('keyword');
  });

  it('keeps every row of the live tail the same as without a language', () => {
    const body = line.repeat(220);
    const typed = new MarkdownStream();
    const plain = new MarkdownStream();
    typed.append(`\`\`\`ts\n${body}`);
    plain.append(`\`\`\`\n${body}`);
    expect(typed.tail(60, 6).map((row) => row.text)).toEqual(
      plain.tail(60, 6).map((row) => row.text),
    );
  });
});

describe('a streamed fence draws as the finished block does', () => {
  const source = [
    'Here is the change:',
    '',
    '```ts',
    'export async function run(n: number): Promise<string> {',
    '  // fetch it',
    '  const s = `n=${n}`;',
    '  return await load(s, 0x10);',
    '}',
    '```',
    '',
    'Then run it:',
    '',
    '```bash',
    'FOO="a b" npm run build --silent 2>&1 | tee out.log',
    '```',
    '',
  ].join('\n');

  it.each([40, 80])(
    'at %i columns, for every prefix cut at a line end and for the whole text',
    (columns) => {
      const lines = source.split('\n');
      for (let count = 1; count <= lines.length; count++) {
        const prefix = `${lines.slice(0, count).join('\n')}\n`;
        const stream = new MarkdownStream();
        stream.append(prefix);
        expect(withoutTrailingBlanks(stream.tail(columns, 400)), `after ${count} lines`).toEqual(
          withoutTrailingBlanks(layoutMarkdown(parseMarkdown(prefix), columns).slice(-400)),
        );
      }
    },
  );

  it('draws the same rows when the text arrives in small pieces', () => {
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += 7) stream.append(source.slice(at, at + 7));
    expect(withoutTrailingBlanks(stream.tail(60, 400))).toEqual(
      withoutTrailingBlanks(layoutMarkdown(parseMarkdown(source), 60).slice(-400)),
    );
  });

  it('highlighting changes no row text of the live tail, only the classes of its spans; the label is the one added row', () => {
    const plainSource = source.replace('```ts', '```').replace('```bash', '```');
    for (const columns of [30, 60]) {
      const typed = new MarkdownStream();
      const plain = new MarkdownStream();
      for (let at = 0; at < source.length; at += 11) {
        typed.append(source.slice(at, at + 11));
      }
      for (let at = 0; at < plainSource.length; at += 11) {
        plain.append(plainSource.slice(at, at + 11));
      }
      const labels = new Set(['ts', 'bash']);
      const typedRows = typed.tail(columns, 400).filter((row) => !labels.has(row.text));
      const plainRows = plain.tail(columns, 400);
      expect(typedRows.map((row) => row.text)).toEqual(plainRows.map((row) => row.text));
    }
  });
});
