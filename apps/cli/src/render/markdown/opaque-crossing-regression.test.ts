import { describe, expect, it } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { parseInline } from './inline.js';
import { transcriptDocument, wrapTranscript } from '../tui/chat-projection.js';
import type { TranscriptEntry } from '../tui/session-view-model.js';

const forms = [
  (target: string): string => '`[label](' + target + ')` *tail*',
  (target: string): string => '`![label](' + target + ')` *tail*',
  (target: string): string => '`<' + target + '>` *tail*',
];
const safeMarkers = ['*', '**', '***', '~~', '_', '__', '\\*', '\\[', '`other`'];

describe('opaque targets after crossing code spans', () => {
  it.each(forms.map((form, kind) => ({ form, kind })))(
    'preserves complete target bytes in construct $kind',
    ({ form }) => {
      for (const marker of safeMarkers) {
        const target = 'https://example.test/`secret' + marker + '/foo';
        const source = form(target);
        const expected = layoutMarkdown(parseMarkdown(source), 500);
        expect(expected.map((line) => line.text).join('\n')).toContain(target);
        for (const size of [1, 3, 13, source.length]) {
          const stream = new MarkdownStream();
          for (let at = 0; at < source.length; at += size) {
            stream.append(source.slice(at, at + size));
            stream.tail(500, 4);
          }
          expect(stream.tail(500, 4)).toEqual(expected);
          expect(stream.sourceTail()).toBe(source);
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      }
    },
  );

  it.each(['[x](y)', '![x](y)', '<https://nested.test>', '\\[x\\]', 'a(b(c))'])(
    'keeps nested unsupported destination %s literal across a code boundary',
    (part) => {
      const target = 'https://example.test/`secret' + part + '/foo';
      for (const form of forms.slice(0, 2)) {
        const source = form(target);
        const rows = layoutMarkdown(parseMarkdown(source), 500);
        expect(rows.map((line) => line.text).join('\n')).toContain(target);
        const stream = new MarkdownStream();
        for (const unit of source) stream.append(unit);
        expect(stream.tail(500, 4)).toEqual(rows);
        expect(stream.sourceTail()).toBe(source);
      }
    },
  );

  it('keeps adjacent link openers, ordinary styled labels and code precedence', () => {
    const spans = parseInline('[**label**](url)[*second*](url)');
    expect(spans).toContainEqual({ text: 'label', strong: true, linkURL: 'url' });
    expect(spans).toContainEqual({ text: 'second', emphasis: true, linkURL: 'url' });
    const source = '`[label](https://example.test/`secret`/foo)`';
    expect(
      parseInline(source)
        .map((span) => span.text)
        .join(''),
    ).toBe('[label](https://example.test/`secret`/foo)');
  });

  it('preserves the target in rich transcript rows and the original source hatch', () => {
    const target = 'https://example.test/`secret\\*x/**tail**';
    const source = '`[label](' + target + ')` *after*';
    const entry: TranscriptEntry = {
      role: 'assistant',
      text: source,
      summary: { stopReason: 'stop', tokensUsed: { input: 0, output: 0 } },
    };
    expect(
      wrapTranscript([entry], 500, true)
        .map((row) => row.text)
        .join('\n'),
    ).toContain(target);
    expect(
      wrapTranscript([entry], 500, false)
        .map((row) => row.text)
        .join('\n'),
    ).toContain(source);
    expect(transcriptDocument([entry])).toContain(source);
  });

  it('preserves the target after its opener leaves the 4,000-unit live window', () => {
    const target = 'https://example.test/`secret\\*target**/foo';
    const prefix = 'p ' + 'x'.repeat(4100) + ' ';
    const suffix = forms[0]?.(target) ?? '';
    const source = prefix + suffix;
    const expected = layoutMarkdown(parseMarkdown(source), 10_000)[0];
    const units = (line: NonNullable<typeof expected>): string[] =>
      line.spans.flatMap(({ text, ...flags }) =>
        Array.from(text, (char) => JSON.stringify([char, flags])),
      );
    for (const size of [1, 7, suffix.length]) {
      const stream = new MarkdownStream();
      stream.append(prefix);
      for (let at = 0; at < suffix.length; at += size) {
        stream.append(suffix.slice(at, at + size));
        stream.tail(80, 5);
      }
      const actual = stream.tail(10_000, 5)[0];
      expect(actual?.text).toContain(target);
      expect(actual).toBeDefined();
      expect(expected).toBeDefined();
      if (!actual || !expected) continue;
      const rendered = units(actual);
      expect(units(expected).slice(-rendered.length)).toEqual(rendered);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([200, 400, 800, 1600])(
    'bounds indexed work and retention for %i protected candidates',
    (n) => {
      const target = 'https://x.test/`' + 'a*'.repeat(n);
      const source = '`[label](' + target + ')` *tail*';
      for (const size of [1, 13, source.length]) {
        const stream = new MarkdownStream();
        for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
        const work = stream.checkpointWork;
        expect(work.indexed).toBeLessThan(source.length * 350);
        expect(work.copied).toBeLessThan(source.length * 3);
        expect(work.decisions).toBeLessThan(source.length * 3);
        expect(work.cache).toBeLessThan(source.length * 400);
        expect(work.retained).toBeLessThan(source.length * 3);
        expect(work.indexRetained).toBeLessThan(source.length * 3);
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    },
  );
});
