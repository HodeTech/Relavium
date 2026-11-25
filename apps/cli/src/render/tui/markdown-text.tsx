import { Text } from './text.js';
import type { ComponentProps, ReactElement } from 'react';

import type { MarkdownSpan } from '../markdown/types.js';
import { Emph } from './emphasis-view.js';
import { syntaxStyle } from './syntax-palette.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function semanticProps(span: MarkdownSpan, color: boolean): Partial<ComponentProps<typeof Text>> {
  if (!color) return {};
  return {
    ...(span.strong || span.heading !== undefined ? { bold: true } : {}),
    ...(span.emphasis ? { italic: true } : {}),
    ...(span.strike ? { strikethrough: true } : {}),
    ...(span.dim || span.quote ? { dimColor: true } : {}),
    // A highlighted code block draws its classes (ADR-0144); other code, inline or fenced, keeps the one code colour.
    ...(span.code && span.token === undefined ? { color: 'cyan' } : {}),
    ...(span.token === undefined ? {} : syntaxStyle(span.token)),
    ...(span.linkURL !== undefined ? { underline: true } : {}),
  };
}

/**
 * One grapheme gets one style even when markup put a style edge inside it. The span styles are the MODEL's content (a heading, strong text, a
 * link, a code class) and are drawn under the colour gate; the highlight of a mouse selection is the HOST's feedback, so it is drawn through
 * `emphasis.ts` as inverse with colour on and off alike (ADR-0145 §5), and never vanishes where chalk is at level 0.
 */
export function MarkdownText(
  props: Readonly<{
    spans: readonly MarkdownSpan[];
    color: boolean;
    selected?: { readonly start: number; readonly end: number } | undefined;
  }>,
): ReactElement {
  const source = props.spans.map((span) => span.text).join('');
  const chunks: { text: string; span: MarkdownSpan; highlighted: boolean }[] = [];
  let spanIndex = 0;
  let spanEnd = props.spans[0]?.text.length ?? 0;
  for (const { segment, index } of segmenter.segment(source)) {
    while (spanIndex + 1 < props.spans.length && index >= spanEnd) {
      spanIndex += 1;
      spanEnd += props.spans[spanIndex]?.text.length ?? 0;
    }
    const span = props.spans[spanIndex] ?? { text: segment };
    const highlighted =
      props.selected !== undefined &&
      index < props.selected.end &&
      index + segment.length > props.selected.start;
    const previous = chunks.at(-1);
    if (previous?.span === span && previous.highlighted === highlighted) previous.text += segment;
    else chunks.push({ text: segment, span, highlighted });
  }
  return (
    <>
      {chunks.map((chunk, index) => (
        <Text key={index} {...semanticProps(chunk.span, props.color)}>
          <Emph kinds={chunk.highlighted ? 'inverse' : undefined}>{chunk.text}</Emph>
        </Text>
      ))}
    </>
  );
}
