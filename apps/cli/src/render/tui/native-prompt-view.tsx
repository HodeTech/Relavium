import { Box, Text, useApp, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { glyphOf, withGlyphForm } from './glyphs.js';
import { exitKey, keyToken, legend, type LegendItem } from './legend.js';
import { nativeLeave, type NativePromptSnapshot } from './native-prompt-channel.js';
import {
  nativePromptFits,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';
import { dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { hardWrap } from './question-card.js';
import {
  SELECT_MARKER_INDENT,
  selectLayout,
  selectLegend,
  selectRowText,
} from './native-select-window.js';

/**
 * The host's gutter. EVERY row of a chord card's body starts with it, so column 0 belongs to the renderer: text the card's author wrote
 * (an MCP server's arguments, say) can neither begin at the start of a row nor, once wrapped, at any later row, and so cannot pass for
 * the card's own key rows (the same rule as the question card's gutter, ADR-0132).
 */
const GUTTER = '│ ';
const CHORD_KEYS: Readonly<Record<string, string>> = {
  allow: `${keyToken('Ctrl+Y')} `,
  deny: `${keyToken('Ctrl+N')} `,
};

/** What leaving a card does, where closing it is not the whole of it (ADR-0145 §2): a chord card refuses, and a busy card stops what it waits for. */
function leaveEffect(snapshot: NativePromptSnapshot): string | undefined {
  if (snapshot.kind === 'chord') return 'denies';
  return snapshot.kind === 'busy' ? 'cancels it' : undefined;
}

/** The legend under a picker: what its keys do, or, after a failed read, how to try again or change the filter. */
function pickerLegend(snapshot: NativePromptSnapshot): string {
  if (snapshot.error === '') {
    return legend(
      [
        { keys: '↑/↓', verb: 'select' },
        { keys: 'Enter', verb: 'resume' },
        { keys: 'Tab', verb: 'scope' },
        { keys: 'PgUp/PgDn', verb: 'page' },
      ],
      exitKey.close(),
    );
  }
  const next: LegendItem =
    snapshot.picker?.retryable === true
      ? { keys: 'Enter', verb: 'retry' }
      : { text: 'Edit filter' };
  return legend([next], exitKey.close());
}

/** The one-line key legend under a prompt card, by the kind of card. */
function promptLegend(snapshot: NativePromptSnapshot, windowed: boolean): string {
  const back = snapshot.escape === 'back';
  if (snapshot.kind === 'picker') return pickerLegend(snapshot);
  if (snapshot.kind === 'select') return selectLegend(back, windowed);
  const { before, exit } = nativeLeave(back, leaveEffect(snapshot));
  if (snapshot.kind === 'busy' || snapshot.kind === 'chord') return legend(before, exit);
  return legend([{ keys: 'Enter', verb: 'continue' }, ...before], exit);
}

/** A sentence in place of a card the terminal cannot show: the reason, then what the keys that leave do (ADR-0145 §3). */
function refusal(snapshot: NativePromptSnapshot, reason: string): string {
  const { before, exit } = nativeLeave(snapshot.escape === 'back', leaveEffect(snapshot));
  return legend([{ text: reason }, ...before], exit);
}

export function NativePromptView({
  snapshot,
  color,
  acknowledgement,
  size,
}: Readonly<{
  snapshot: NativePromptSnapshot;
  color: boolean;
  acknowledgement: NativePromptAcknowledgement;
  size: { cols: number; rows: number };
}>): ReactElement | null {
  const ref = useRef<DOMElement | null>(null);
  const app = useApp();
  const [overflow, setOverflow] = useState<{
    snapshot: NativePromptSnapshot;
    cols: number;
    rows: number;
  }>();
  const blocked =
    overflow?.snapshot === snapshot && overflow.cols === size.cols && overflow.rows === size.rows;
  useLayoutEffect(() => {
    if (!snapshot.active || !nativePromptFits(size) || blocked) return;
    if (!acknowledgement.commit(snapshot, ref.current, () => app.waitUntilRenderFlush()))
      setOverflow({ snapshot, cols: size.cols, rows: size.rows });
  });
  if (!snapshot.active) return null;
  // `Esc` ends the flow unless the prompt was opened to step back; `Ctrl+C` always leaves it.
  if (!nativePromptFits(size))
    return <Text>{refusal(snapshot, 'Terminal too small — resize to at least 80×24')}</Text>;
  if (blocked)
    return <Text>{refusal(snapshot, 'Prompt does not fit — enlarge the terminal')}</Text>;
  // A select whose options do not all fit the terminal draws a window of them (LAUNCH-4); every other card, and a select that fits, is drawn whole.
  const selectWindow =
    snapshot.kind === 'select'
      ? withGlyphForm(!color, () => selectLayout(snapshot, size))
      : undefined;
  // A row's text is built in the glyph form the colour setting asks for (the cursor is the table's selection marker).
  const rowText = (index: number): string =>
    withGlyphForm(!color, () => selectRowText(snapshot, index));
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {snapshot.note !== '' && <Text wrap="wrap">{snapshot.note}</Text>}
      {snapshot.message !== '' && <Text wrap="wrap">{snapshot.message}</Text>}
      {snapshot.kind === 'picker' && (
        <>
          <Text wrap="truncate-end">
            {snapshot.picker?.allDirectories === true ? 'All directories' : 'This directory'} · Page{' '}
            {snapshot.picker?.page ?? 1}
          </Text>
          <PromptEditor
            editor={{
              text: snapshot.display,
              cursor: snapshot.picker?.cursor ?? snapshot.display.length,
            }}
            color={color}
          />
          {snapshot.picker?.loading === true ? (
            <Text>Loading sessions…</Text>
          ) : snapshot.options.length === 0 && snapshot.error === '' ? (
            <Text>{legend([{ text: 'No matching sessions' }], exitKey.close())}</Text>
          ) : null}
          {snapshot.options.map((option, index) => (
            <Box key={option.value} flexDirection="column">
              <Text wrap="truncate-end">
                {index === snapshot.selected ? `${glyphOf('selection', !color)} ` : '  '}
                {option.label}
              </Text>
              {option.hint !== undefined && (
                <Text {...dimProps(color)} wrap="truncate-end">
                  {'  '}
                  {option.hint}
                </Text>
              )}
            </Box>
          ))}
        </>
      )}
      {snapshot.kind === 'chord' && (
        <>
          {snapshot.details.flatMap((line, index) =>
            hardWrap(line, Math.max(1, size.cols - GUTTER.length - 2)).map((row, part) => (
              <Text key={`${String(index)}:${String(part)}`} wrap="truncate-end">
                {GUTTER}
                {row}
              </Text>
            )),
          )}
          {snapshot.options.map((option) => (
            <Text key={option.value} wrap="truncate-end">
              {CHORD_KEYS[option.value] ?? ''}
              {option.label}
            </Text>
          ))}
        </>
      )}
      {snapshot.kind === 'select' &&
        (selectWindow === undefined
          ? snapshot.options.map((option, index) => (
              <Text key={option.value}>{rowText(index)}</Text>
            ))
          : selectWindow.lines.map((line) =>
              line.kind === 'marker' ? (
                <Text key={line.position} {...dimProps(color)} wrap="truncate-end">
                  {SELECT_MARKER_INDENT}
                  {line.text}
                </Text>
              ) : (
                <Text key={snapshot.options[line.index]?.value ?? line.index} wrap="truncate-end">
                  {rowText(line.index)}
                </Text>
              ),
            ))}
      {(snapshot.kind === 'password' || snapshot.kind === 'text') && (
        <Text>
          {'> '}
          {snapshot.display}
        </Text>
      )}
      {snapshot.error !== '' && <Text>{snapshot.error}</Text>}
      <Text {...dimProps(color)}>{promptLegend(snapshot, selectWindow !== undefined)}</Text>
    </Box>
  );
}
