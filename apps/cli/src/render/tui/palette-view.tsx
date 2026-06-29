import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { sanitizeInline } from './chat-projection.js';
import { filterPaletteCommands, type PaletteState } from './palette-reducer.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The interactive `/` command-palette overlay (2.5.C S3b) — a PURE ink view over the filtered curated commands
 * ({@link filterPaletteCommands}). It owns NO `useInput`: the single raw-mode owner (the standalone `ChatApp` or
 * the Home's `RootApp`) routes keys to {@link reducePaletteKey}/{@link stepPalette} and re-renders this from the
 * resulting {@link PaletteState}. Every rendered free-form field — the query echo, the command name, and its
 * description — is sanitized at the display boundary, so a crafted command name/description or a pasted control
 * sequence can never forge a row or inject an escape.
 */
export interface PaletteViewProps {
  readonly commands: readonly ReplCommand[];
  readonly state: PaletteState;
  readonly color: boolean;
}

export function PaletteView(props: Readonly<PaletteViewProps>): ReactElement {
  const { commands, state, color } = props;
  const filtered = filterPaletteCommands(commands, state.query);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...dimProps(color)} wrap="truncate-end">
        {`/${sanitizeInline(state.query)}`}
      </Text>
      {filtered.length === 0 ? (
        <Text {...dimProps(color)} wrap="truncate-end">
          no matching command
        </Text>
      ) : (
        filtered.map((command, index) => {
          const selected = index === state.index;
          return (
            <Text
              key={command.name}
              {...(selected ? colorProps(color, 'cyan') : {})}
              wrap="truncate-end"
            >
              {`${selected ? '›' : ' '} /${sanitizeInline(command.name)}  `}
              <Text {...dimProps(color)}>{sanitizeInline(command.description)}</Text>
            </Text>
          );
        })
      )}
      <Text {...dimProps(color)} wrap="truncate-end">
        ↑/↓ select · Enter run · Esc cancel
      </Text>
    </Box>
  );
}
