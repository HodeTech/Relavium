import { Box, Transform, useApp, useStdout, type DOMElement } from 'ink';
import { Text } from './text.js';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { withGlyphForm } from './glyphs.js';
import { keyHint, keyToken, legend, legendRows, waitMark } from './legend.js';
import { nativeLeave, type NativePromptSnapshot } from './native-prompt-channel.js';
import {
  nativePromptFits,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';
import { TERMINAL_TOO_SMALL_TEXT } from './measured-frame-acknowledgement.js';
import { dimProps } from './projection.js';
import { displayWidth, inkSafe } from './viewport.js';
import {
  nativeFramed,
  nativeLegendParts,
  pickerEmptyText,
  pickerLegendParts,
  withLiveBullets,
} from '../../popups/native-popup-body.js';
import { PromptEditor } from './prompt-view.js';
import { SelectableText, selectionMarker } from './selectable-text.js';
import { hardWrap } from './question-card.js';
import {
  SELECT_MARKER_INDENT,
  selectLayout,
  selectRowLines,
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

/**
 * The legend under a picker: what its keys do, or, after a failed read, how to try again or change the filter. Its leaving keys are the
 * card's own ({@link nativeLeave}), read from the same `escape` the channel reads, so a picker opened to step back says `Esc back` and
 * names `Ctrl+C` as the key that closes it. `Tab` flips between this directory and all of them, and says which one it goes to. The parts are
 * the popup frame's too (`pickerLegendParts`), so the card and the framed picker cannot drift.
 */
export function pickerLegend(snapshot: NativePromptSnapshot): string {
  const { items, exit } = pickerLegendParts(snapshot);
  return legend(items, exit);
}

/** What a picker with no row says (the framed picker's words, `pickerEmptyText`), with the card's own leaving keys. */
function pickerEmptyLegend(snapshot: NativePromptSnapshot): string {
  const { before, exit } = nativeLeave(snapshot.escape === 'back');
  return legend([{ text: pickerEmptyText(snapshot) }, ...before], exit);
}

/**
 * The one-line key legend under a prompt card: the channel's one legend (`nativeLegendParts`, shared with the popup frame), joined. `locked`
 * is the channel's lock (`NativePromptUi.lock`): a guarded option's `Enter` reads `Enter choose (wait)` while it holds.
 */
export function promptLegend(
  snapshot: NativePromptSnapshot,
  windowed: boolean,
  locked = false,
): string {
  const { items, exit } = nativeLegendParts(snapshot, windowed, 'card', locked);
  return legend(items, exit);
}

/**
 * A chord card's answer row as its text and whether it is drawn dim: `[Ctrl+Y] <allow>` and `[Ctrl+N] <deny>` (the row's key prefix), and,
 * while the channel's lock holds the affirmative, `[Ctrl+Y] <allow> (wait)` built by the legend builder and dim as a whole (ADR-0145 §3). The
 * label is the card's product constant (sanitised by the channel); nothing here reads a state from it.
 */
export function chordRowText(
  option: { readonly value: string; readonly label: string },
  locked: boolean,
): { readonly text: string; readonly dim: boolean } {
  if (locked && option.value === 'allow')
    return {
      text: keyHint([{ keys: 'Ctrl+Y', verb: option.label, ...waitMark(locked) }]),
      dim: true,
    };
  return { text: `${CHORD_KEYS[option.value] ?? ''}${option.label}`, dim: false };
}

/**
 * A card's body rows (a chord card's facts; a select's lines, which only a flow's last step has), each wrapped and every row behind the host's
 * gutter, so text the card's author did not write never starts at column 0.
 */
function DetailRows({
  details,
  cols,
}: Readonly<{ details: readonly string[]; cols: number }>): ReactElement {
  return (
    <>
      {details.flatMap((line, index) =>
        hardWrap(line, Math.max(1, cols - GUTTER.length - 2)).map((row, part) => (
          <Text key={`${String(index)}:${String(part)}`} wrap="truncate-end">
            {GUTTER}
            {row}
          </Text>
        )),
      )}
    </>
  );
}

/**
 * A resize empties a masked field before the renderer draws anything at the new size (ADR-0148 §4). The renderer registered its own `resize`
 * listener first and redraws the tree it already has (a shrink rewrites the whole screen), which still holds the field's bullets: so this
 * listener is PREPENDED, and the channel's change is rendered (the root is a legacy one: synchronously) before the renderer's redraw. Every host
 * that draws the channel mounts this view (the Home's root, the native prompt host), framed prompt or card.
 */
function useResizeClearsFirst(acknowledgement: NativePromptAcknowledgement): void {
  const { stdout } = useStdout();
  useEffect(() => {
    const noticed = (): void => acknowledgement.noticeSize();
    stdout.prependListener('resize', noticed);
    return () => {
      stdout.removeListener('resize', noticed);
    };
  }, [stdout, acknowledgement]);
}

/**
 * The field of a text or a masked card: what is typed (bullets for a secret, the channel's display). A masked field is drawn through the
 * renderer's output phase with the field as it is NOW: a resize redraws this tree before it is rendered again, and the field the resize emptied
 * must not be written with its old bullets (ADR-0148 §4). Nothing for any other card.
 */
function FieldRow({
  snapshot,
  acknowledgement,
}: Readonly<{
  snapshot: NativePromptSnapshot;
  acknowledgement: NativePromptAcknowledgement;
}>): ReactElement | null {
  if (snapshot.kind === 'text')
    return (
      <Text>
        {'> '}
        {inkSafe(snapshot.display)}
      </Text>
    );
  if (snapshot.kind !== 'password') return null;
  return (
    <Transform transform={(row) => withLiveBullets(row, acknowledgement.current())}>
      <Text>
        {'> '}
        {snapshot.display}
      </Text>
    </Transform>
  );
}

/** A sentence in place of a card the terminal cannot show: the reason, then what the keys that leave do (ADR-0145 §3). */
function refusal(snapshot: NativePromptSnapshot, reason: string, columns: number): string {
  const { before, exit } = nativeLeave(snapshot.escape === 'back', leaveEffect(snapshot));
  return legendRows([{ text: reason }, ...before], exit, columns, displayWidth).join('\n');
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
  useResizeClearsFirst(acknowledgement);
  // The lock is a display value, not a field of the snapshot: its change re-renders this card and is no new frame (ADR-0147 §2).
  const locked = useSyncExternalStore(acknowledgement.lock.subscribe, acknowledgement.lock.read);
  const [overflow, setOverflow] = useState<{
    snapshot: NativePromptSnapshot;
    cols: number;
    rows: number;
  }>();
  const blocked =
    overflow?.snapshot === snapshot && overflow.cols === size.cols && overflow.rows === size.rows;
  // A prompt a flow set as a popup is drawn in the popup frame by the host's overlay slot (ADR-0148 §2), which measures it there.
  const framed = nativeFramed(snapshot);
  useLayoutEffect(() => {
    if (!snapshot.active || framed || !nativePromptFits(size) || blocked) return;
    if (!acknowledgement.commit(snapshot, ref.current, () => app.waitUntilRenderFlush()))
      setOverflow({ snapshot, cols: size.cols, rows: size.rows });
  });
  if (!snapshot.active || framed) return null;
  // `Esc` ends the flow unless the prompt was opened to step back; `Ctrl+C` always leaves it.
  if (!nativePromptFits(size))
    return <Text>{refusal(snapshot, TERMINAL_TOO_SMALL_TEXT, size.cols)}</Text>;
  if (blocked)
    return (
      <Text>{refusal(snapshot, 'Prompt does not fit — enlarge the terminal', size.cols)}</Text>
    );
  // A select whose options do not all fit the terminal draws a window of them (LAUNCH-4); every other card, and a select that fits, is drawn whole.
  const selectWindow =
    snapshot.kind === 'select'
      ? withGlyphForm(!color, () => selectLayout(snapshot, size))
      : undefined;
  // A row's text is built in the glyph form the colour setting asks for (the cursor is the table's selection marker). The row under the
  // cursor is the selected row: bold and inverse, with colour on and off alike.
  const rowText = (index: number): ReactElement => (
    <SelectableText selected={index === snapshot.selected}>
      {withGlyphForm(!color, () => selectRowText(snapshot, index))}
    </SelectableText>
  );
  // A card drawn whole gives each option the rows it needs: the rows of one that wraps hang under its label, and the selected option is
  // selected on every one of them.
  const rowLines = (index: number): ReactElement[] =>
    withGlyphForm(!color, () => selectRowLines(snapshot, index, size.cols)).map((line, at) => (
      <Text key={at}>
        <SelectableText selected={index === snapshot.selected}>{line}</SelectableText>
      </Text>
    ));
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {/* ink wraps these itself: given in the form ink counts as a terminal draws it (an Indic conjunct, review round 4, R4-S-1) */}
      {snapshot.note !== '' && <Text wrap="wrap">{inkSafe(snapshot.note)}</Text>}
      {snapshot.message !== '' && <Text wrap="wrap">{inkSafe(snapshot.message)}</Text>}
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
            <Text>{pickerEmptyLegend(snapshot)}</Text>
          ) : null}
          {snapshot.options.map((option, index) => (
            <Box key={option.value} flexDirection="column">
              <Text wrap="truncate-end">
                <SelectableText selected={index === snapshot.selected}>
                  {`${selectionMarker(index === snapshot.selected, color)} `}
                  {inkSafe(option.label)}
                </SelectableText>
              </Text>
              {option.hint !== undefined && (
                <Text {...dimProps(color)} wrap="truncate-end">
                  {'  '}
                  {inkSafe(option.hint)}
                </Text>
              )}
            </Box>
          ))}
        </>
      )}
      {snapshot.kind === 'select' && <DetailRows details={snapshot.details} cols={size.cols} />}
      {snapshot.kind === 'chord' && (
        <>
          <DetailRows details={snapshot.details} cols={size.cols} />
          {snapshot.options.map((option) => {
            const row = chordRowText(option, locked);
            return (
              <Text key={option.value} wrap="truncate-end" {...dimProps(color && row.dim)}>
                {row.text}
              </Text>
            );
          })}
        </>
      )}
      {snapshot.kind === 'select' &&
        (selectWindow === undefined
          ? snapshot.options.map((option, index) => (
              <Box key={option.value} flexDirection="column">
                {rowLines(index)}
              </Box>
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
      <FieldRow snapshot={snapshot} acknowledgement={acknowledgement} />
      {snapshot.error !== '' && <Text>{inkSafe(snapshot.error)}</Text>}
      <Text {...dimProps(color)}>{promptLegend(snapshot, selectWindow !== undefined, locked)}</Text>
    </Box>
  );
}
