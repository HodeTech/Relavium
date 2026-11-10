import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import { dimProps } from './projection.js';

export function NativePromptView({
  snapshot,
  color,
}: Readonly<{ snapshot: NativePromptSnapshot; color: boolean }>): ReactElement | null {
  if (!snapshot.active) return null;
  return (
    <Box flexDirection="column">
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
