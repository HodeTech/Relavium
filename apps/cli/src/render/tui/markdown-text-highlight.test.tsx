import './force-color.js';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { MarkdownSpan, SyntaxToken } from '../markdown/types.js';
import { settleFrames } from './harness-util.js';
import { MarkdownText } from './markdown-text.js';

afterEach(cleanup);

const ESC = String.fromCharCode(27);
const open = (code: number): string => `${ESC}[${String(code)}m`;

async function frameOf(spans: readonly MarkdownSpan[], color: boolean): Promise<string> {
  // The transcript draws MarkdownText inside a <Text>, which is what keeps its pieces on one row.
  const h = render(
    <Text>
      <MarkdownText spans={spans} color={color} />
    </Text>,
  );
  await settleFrames();
  return h.lastFrame() ?? '';
}

const code = (token: SyntaxToken, text: string): MarkdownSpan => ({ text, code: true, token });

describe('MarkdownText draws a highlighted code span by its class (ADR-0144)', () => {
  it.each([
    ['keyword', `${open(35)}x${open(39)}`],
    ['string', `${open(32)}x${open(39)}`],
    ['number', `${open(33)}x${open(39)}`],
    ['constant', `${open(33)}x${open(39)}`],
    ['type', `${open(36)}x${open(39)}`],
    ['property', `${open(36)}x${open(39)}`],
    ['inserted', `${open(32)}x${open(39)}`],
    ['deleted', `${open(31)}x${open(39)}`],
    ['hunk', `${open(36)}x${open(39)}`],
    ['variable', `${open(36)}x${open(39)}`],
    ['meta', `${open(33)}x${open(39)}`],
    ['comment', `${open(2)}x${open(22)}`],
    ['function', `${open(1)}x${open(22)}`],
  ] as const)('a %s span is drawn with its style', async (token, expected) => {
    expect(await frameOf([code(token, 'x')], true)).toBe(expected);
  });

  it('draws plain code in the default colour, not in the code colour', async () => {
    expect(await frameOf([code('text', 'x')], true)).toBe('x');
  });

  it('keeps the one code colour for code that was not highlighted, inline or fenced', async () => {
    expect(await frameOf([{ text: 'x', code: true }], true)).toBe(`${open(36)}x${open(39)}`);
  });

  it('draws a whole line of classes in order, with the plain parts between them unstyled', async () => {
    const frame = await frameOf(
      [code('keyword', 'const'), code('text', ' a = '), code('string', '"s"'), code('text', ';')],
      true,
    );
    expect(frame).toBe(`${open(35)}const${open(39)} a = ${open(32)}"s"${open(39)};`);
  });

  it('draws no style at all with colour off, whatever the class', async () => {
    const frame = await frameOf(
      [code('keyword', 'const'), code('string', '"s"'), code('comment', '// c')],
      false,
    );
    expect(frame).toBe('const"s"// c');
  });
});
