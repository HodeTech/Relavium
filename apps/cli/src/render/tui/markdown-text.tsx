import { Text } from 'ink';
import type { ComponentProps, ReactElement } from 'react';

import type { MarkdownSpan } from '../markdown/types.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function semanticProps(span: MarkdownSpan, color: boolean): Partial<ComponentProps<typeof Text>> {
  if (!color) return {};
  return {
    ...(span.strong || span.heading !== undefined ? { bold: true } : {}),
    ...(span.emphasis ? { italic: true } : {}),
    ...(span.strike ? { strikethrough: true } : {}),
    ...(span.dim || span.quote ? { dimColor: true } : {}),
    ...(span.code ? { color: 'cyan' } : {}),
    ...(span.linkURL !== undefined ? { underline: true } : {}),
  };
}

/** One grapheme gets one style even when markup put a style edge inside it. */
export function MarkdownText(
  props: Readonly<{
    spans: readonly MarkdownSpan[];
    color: boolean;
    selected?: { readonly start: number; readonly end: number } | undefined;
  }>,
): ReactElement {
  const source = props.spans.map((span) => span.text).join('');
  const chunks: { text: string; span: MarkdownSpan; inverse: boolean }[] = [];
  let spanIndex = 0;
  let spanEnd = props.spans[0]?.text.length ?? 0;
  for (const { segment, index } of segmenter.segment(source)) {
    while (spanIndex + 1 < props.spans.length && index >= spanEnd) {
      spanIndex += 1;
      spanEnd += props.spans[spanIndex]?.text.length ?? 0;
    }
    const span = props.spans[spanIndex] ?? { text: segment };
    const inverse =
      props.selected !== undefined &&
      index < props.selected.end &&
      index + segment.length > props.selected.start;
    const previous = chunks.at(-1);
    if (previous?.span === span && previous.inverse === inverse) previous.text += segment;
    else chunks.push({ text: segment, span, inverse });
  }
  return (
    <>
      {chunks.map((chunk, index) => (
        <Text
          key={index}
          {...semanticProps(chunk.span, props.color)}
          {...(chunk.inverse ? { inverse: true } : {})}
        >
          {chunk.text}
        </Text>
      ))}
    </>
  );
}
