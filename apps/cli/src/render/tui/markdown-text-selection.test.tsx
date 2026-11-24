import './force-no-color.js';

import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { MarkdownSpan } from '../markdown/types.js';
import { stylesOver } from './emphasis-test-kit.js';
import { settleFrames, withoutStyles } from './harness-util.js';
import { MarkdownText } from './markdown-text.js';

/**
 * The highlight of a mouse selection in a markdown line is the HOST's feedback, not the model's content ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5: "no colour" means colour only). It is drawn through `emphasis.ts` as inverse video, so it is there with chalk at level 0 (`NO_COLOR`,
 * `--no-color`, `FORCE_COLOR=0`, `TERM=dumb`), where ink's own `inverse` prop prints nothing and the selection was invisible.
 *
 * Bold and underline of a heading, strong text or a link are the model's content and stay under the colour gate: with colour off the transcript
 * does not parse markdown at all (it draws the source), so there is no span for them to style; that path is a different renderer and is left
 * as it is.
 */
afterEach(cleanup);

const SPANS: readonly MarkdownSpan[] = [
  { text: 'x:' },
  { text: 'hello ', strong: true },
  { text: 'bold world' },
];

async function frameOf(
  selected: { readonly start: number; readonly end: number } | undefined,
  color: boolean,
): Promise<string> {
  const h = render(
    <Text>
      <MarkdownText spans={SPANS} color={color} selected={selected} />
    </Text>,
  );
  await settleFrames();
  const frame = h.lastFrame() ?? '';
  h.unmount();
  return frame;
}

describe.each([false, true])('MarkdownText with chalk off, the colour flag %s', (color) => {
  it('draws the selected stretch inverse, and only that stretch', async () => {
    const frame = await frameOf({ start: 2, end: 9 }, color);
    expect(withoutStyles(frame)).toBe('x:hello bold world');
    expect(stylesOver(frame, 'hello b')).toContain('inverse');
    expect(stylesOver(frame, 'x:') ?? []).not.toContain('inverse');
    expect(stylesOver(frame, 'old world') ?? []).not.toContain('inverse');
  });

  it('draws no style at all without a selection', async () => {
    const frame = await frameOf(undefined, color);
    expect(frame).toBe('x:hello bold world');
  });

  it('closes the highlight on the row it opened it on', async () => {
    const frame = await frameOf({ start: 0, end: 18 }, color);
    expect(frame.endsWith('\u001b[27m'), JSON.stringify(frame)).toBe(true);
  });
});
