import { Box, Text, useApp, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  nativePromptFits,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';
import { dimProps } from './projection.js';

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
  if (!nativePromptFits(size))
    return <Text>Terminal too small — resize to at least 80×24. Esc cancels.</Text>;
  if (blocked) return <Text>Prompt does not fit — enlarge the terminal. Esc cancels.</Text>;
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {snapshot.note !== '' && <Text wrap="wrap">{snapshot.note}</Text>}
      {snapshot.message !== '' && <Text wrap="wrap">{snapshot.message}</Text>}
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
        {snapshot.kind === 'select'
          ? '↑/↓ select · Enter continue · Esc cancel'
          : snapshot.kind === 'busy'
            ? 'Esc cancel'
            : 'Enter continue · Esc cancel'}
      </Text>
    </Box>
  );
}
