import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { RunHostSnapshot } from '../../home/run-host.js';
import { withGlyphForm } from './glyphs.js';
import { RunApp } from './RunApp.js';
import { layoutColumns } from './layout-columns.js';
import { colorProps, dimProps } from './projection.js';
import { RUN_SCREEN_NOTE_MARK, runScreenModel } from './run-screen.js';
import type { RunStore } from './run-store.js';

/**
 * The Home's run view ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): a PURE ink view over
 * {@link runScreenModel}. It owns no `useInput` (the Home's `RootApp` is the one raw-mode owner) and no state: it paints the title
 * row, the live output, the newest notices, the disposition card once the leg has ended, and the key line.
 *
 * - **The live output is `RunApp`**, mounted over the leg's own run store, and nothing here rewrites it. It sits in a box of the rows
 *   the model leaves it, anchored to the BOTTOM when it is taller than that (the newest rows, and the cost footer, stay on screen; the
 *   oldest node rows scroll off the top) and to the top when it is shorter.
 * - **Every state is a glyph and a word**, and colour only reinforces them, so the view reads the same under `NO_COLOR`.
 * - **Below 80×24** the view is the enlarge line and the key line, and the live output is not mounted at all.
 * - It is the same view in the full-screen and the inline renderer: the box is bounded, so it never grows past `rows - 1`.
 */
export interface RunScreenViewProps {
  readonly runId: string;
  /** The leg's live output; absent when nothing feeds this Home (the view then says there is none). */
  readonly store: RunStore | undefined;
  readonly hostedRun: RunHostSnapshot | undefined;
  /** The run host's notice ring, oldest first. */
  readonly notices: readonly string[];
  /** The interrupt keymap is armed: the key line says a second `Ctrl+C` cancels the run. */
  readonly interruptArmed: boolean;
  /** A gate card can be opened: a run that ended parked offers `Enter` for it. */
  readonly openGate?: boolean | undefined;
  /** The last `Enter` could not open the card: the key line says it will try again (the view's own note row says why). */
  readonly gateOpenFailed?: boolean | undefined;
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
}

export function RunScreenView(props: Readonly<RunScreenViewProps>): ReactElement {
  const model = withGlyphForm(!props.color, () =>
    runScreenModel({
      runId: props.runId,
      snapshot: props.hostedRun,
      notices: props.notices,
      armed: props.interruptArmed,
      columns: props.columns,
      rows: props.rows,
      openGate: props.openGate,
      gateOpenFailed: props.gateOpenFailed,
    }),
  );
  const { color } = props;
  const card = model.card;
  return (
    <Box flexDirection="column" width={layoutColumns(props.columns)}>
      {model.tooSmall !== undefined ? (
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {model.tooSmall}
        </Text>
      ) : (
        <>
          <Text {...colorProps(color, model.tone)} bold wrap="truncate-end">
            {model.header}
          </Text>
          {model.status !== undefined && (
            <Text
              {...(model.phase === 'cancelling' ? colorProps(color, 'yellow') : dimProps(color))}
              wrap="truncate-end"
            >
              {model.status}
            </Text>
          )}
          {/* The live output: a fixed box, bottom-anchored when its content is taller (the inner box does not shrink and
              grows to fill a taller box, so a short output stays at the top). */}
          <Box
            height={model.liveRows}
            overflowY="hidden"
            flexDirection="column"
            justifyContent="flex-end"
          >
            <Box flexDirection="column" flexGrow={1} flexShrink={0}>
              {props.store === undefined ? (
                <Text {...dimProps(color)} wrap="truncate-end">
                  No live output for this view.
                </Text>
              ) : (
                <RunApp store={props.store} />
              )}
            </Box>
          </Box>
          {model.earlierNotices > 0 && (
            <Text {...dimProps(color)} wrap="truncate-end">
              {`… ${String(model.earlierNotices)} earlier ${model.earlierNotices === 1 ? 'notice' : 'notices'}`}
            </Text>
          )}
          {model.notices.map((line, index) => (
            // The ring is append-only and bounded: a row's place among the newest is its identity.
            <Text key={`${String(index)}:${line}`} {...dimProps(color)} wrap="truncate-end">
              {`${RUN_SCREEN_NOTE_MARK}${line}`}
            </Text>
          ))}
          {card?.rows.map((line, index) => (
            <Text
              key={`${String(index)}:${line}`}
              {...(index === 0 ? colorProps(color, card.tone) : {})}
              wrap="truncate-end"
            >
              {`  ${line}`}
            </Text>
          ))}
        </>
      )}
      <Text {...dimProps(color)} wrap="truncate-end">
        {model.keys}
      </Text>
    </Box>
  );
}
