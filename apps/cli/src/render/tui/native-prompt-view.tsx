import { Box, Text, useApp, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  nativePromptFits,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';
import { dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { hardWrap } from './question-card.js';

/**
 * The host's gutter. EVERY row of a chord card's body starts with it, so column 0 belongs to the renderer: text the card's author wrote
 * (an MCP server's arguments, say) can neither begin at the start of a row nor, once wrapped, at any later row, and so cannot pass for
 * the card's own key rows (the same rule as the question card's gutter, ADR-0132).
 */
const GUTTER = '│ ';
const CHORD_KEYS: Readonly<Record<string, string>> = { allow: '[Ctrl+Y] ', deny: '[Ctrl+N] ' };

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
  const back = snapshot.escape === 'back';
  // `Esc` ends the flow unless the prompt was opened to step back; `Ctrl+C` always leaves it.
  const leave = back ? 'Esc back · Ctrl+C leave' : 'Esc cancel';
  if (!nativePromptFits(size))
    return (
      <Text>
        Terminal too small — resize to at least 80×24.{' '}
        {back ? 'Esc steps back · Ctrl+C leaves.' : 'Esc cancels.'}
      </Text>
    );
  if (blocked)
    return (
      <Text>
        Prompt does not fit — enlarge the terminal.{' '}
        {back ? 'Esc steps back · Ctrl+C leaves.' : 'Esc cancels.'}
      </Text>
    );
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
            <Text>No matching sessions. Esc cancels.</Text>
          ) : null}
          {snapshot.options.map((option, index) => (
            <Box key={option.value} flexDirection="column">
              <Text wrap="truncate-end">
                {index === snapshot.selected ? '❯ ' : '  '}
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
        snapshot.options.map((option, index) => (
          <Text key={option.value}>
            {index === snapshot.selected ? '❯ ' : '  '}
            {option.label}
            {option.hint ? ` — ${option.hint}` : ''}
          </Text>
        ))}
      {(snapshot.kind === 'password' || snapshot.kind === 'text') && (
        <Text>
          {'> '}
          {snapshot.display}
        </Text>
      )}
      {snapshot.error !== '' && <Text>{snapshot.error}</Text>}
      <Text {...dimProps(color)}>
        {snapshot.kind === 'picker'
          ? snapshot.error !== ''
            ? snapshot.picker?.retryable === true
              ? 'Enter retry · Esc cancel'
              : 'Edit filter · Esc cancel'
            : '↑/↓ select · Enter resume · Tab scope · PgUp/PgDn pages · Esc cancel'
          : snapshot.kind === 'select'
            ? `↑/↓ select · Enter continue · ${leave}`
            : snapshot.kind === 'busy' || snapshot.kind === 'chord'
              ? leave
              : `Enter continue · ${leave}`}
      </Text>
    </Box>
  );
}
