import { Box, Text, useInput } from 'ink';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';

import { CHAT_PALETTE_COMMANDS, HOME_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { PendingAttachment } from './attachments.js';
import { ChatView } from './chat-ink.js';
import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import type { ChatStoreController } from './chat-store.js';
import type { HomeController } from './home-controller.js';
import { HomeView } from './home-view.js';
import type { ReverseSearchState } from './input-history.js';
import type { MentionState } from './mention.js';
import { MentionView } from './mention-view.js';
import type { EffortPickerState } from './effort-picker.js';
import { EffortTierList } from './effort-tier-list.js';
import type { ModelPickerState } from './model-picker.js';
import { ModelPickerView } from './model-picker-view.js';
import { PaletteView } from './palette-view.js';
import type { PaletteState } from './palette-reducer.js';
import { colorProps, dimProps } from './projection.js';
import { ReverseSearchView } from './reverse-search-view.js';

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The session state machine lives in {@link HomeController} (a plain
 * external store, unit-tested without ink); `RootApp` is a thin view that subscribes to it, forwards every key to
 * `controller.handleKey`, and renders the Home strip, the loading echo, or the chat region from the published
 * state. The clock + terminal size are injected so the strip degrade (<80×24) and the relative times are testable.
 */

export type { HomeChatSession } from './home-controller.js';

export interface RootAppProps {
  readonly controller: HomeController;
  readonly nowMs: () => number;
  readonly color: boolean;
  readonly getSize: () => { cols: number; rows: number };
  /** Subscribe to terminal resizes; returns an unsubscribe. */
  readonly subscribeResize: (onResize: () => void) => () => void;
}

/** The chat region: subscribes to the chat store (re-render on stream events) and renders the pure {@link ChatView},
 *  plus the `/` palette overlay (2.5.C S3b) when open. It owns NO `useInput` — {@link RootApp} is the single
 *  raw-mode owner and forwards keys to the controller. */
function ChatRegion(
  props: Readonly<{
    store: ChatStoreController;
    editor: EditorState;
    palette: PaletteState | undefined;
    search: ReverseSearchState | undefined;
    mention: MentionState | undefined;
    modelPicker: ModelPickerState | undefined;
    effortPicker: EffortPickerState | undefined;
    /** The wall-clock as a FUNCTION, not a pre-computed number: `ChatRegion` re-renders every frame while a turn
     *  streams (its own store subscription flushes on `tick`, chat-store.ts), whereas its parent `RootApp` only
     *  re-renders on controller state changes. So the live-turn timer (2.5.H) MUST read the clock here, per frame —
     *  a number prop frozen at the parent's last render would stick the elapsed at 0s for the whole pre-token wait. */
    now: () => number;
    shellBusy: boolean;
    submitBusy: boolean;
    shellCommand: string | undefined;
    historyEntries: readonly string[];
    attachments: readonly PendingAttachment[];
  }>,
): ReactElement {
  const { state, tick, color, mode, reasoningEffort, reasoningVisible, approval } =
    useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  // Read the clock in THIS per-frame component (see the `now` prop doc) so the elapsed advances live.
  const nowMs = props.now();
  return (
    <Box flexDirection="column">
      <ChatView
        state={state}
        tick={tick}
        nowMs={nowMs}
        color={color}
        editor={props.editor}
        running={state.status === 'running' || props.shellBusy || props.submitBusy}
        mode={mode}
        reasoningEffort={reasoningEffort}
        reasoningVisible={reasoningVisible}
        approval={approval}
        attachments={props.attachments}
        busyCommand={props.shellCommand}
        paletteOpen={
          props.palette !== undefined ||
          props.search !== undefined ||
          props.mention !== undefined ||
          props.modelPicker !== undefined ||
          props.effortPicker !== undefined
        }
      />
      {props.palette !== undefined && (
        <PaletteView commands={CHAT_PALETTE_COMMANDS} state={props.palette} color={color} />
      )}
      {props.search !== undefined && (
        <ReverseSearchView state={props.search} entries={props.historyEntries} color={color} />
      )}
      {props.mention !== undefined && <MentionView state={props.mention} color={color} />}
      {/* The `/models` reseat picker overlay in a live in-Home chat (ADR-0059) — mounted like the palette. */}
      {props.modelPicker !== undefined && (
        <ModelPickerView state={props.modelPicker} color={color} nowMs={nowMs} />
      )}
      {/* The standalone `/effort` overlay in a live in-Home chat (ADR-0066 §6) — the shared tier list. */}
      {props.effortPicker !== undefined && (
        <EffortTierList
          selected={props.effortPicker.selected}
          current={props.effortPicker.current}
          labelSuffix={props.effortPicker.model}
          footer="↑/↓ select · Enter apply · Esc cancel"
          color={color}
        />
      )}
    </Box>
  );
}

export function RootApp(props: Readonly<RootAppProps>): ReactElement {
  const { controller, getSize, subscribeResize, color } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [size, setSize] = useState(getSize);

  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(() => subscribeResize(() => setSize(getSize())), [subscribeResize, getSize]);

  useInput((input, key) => controller.handleKey(input, key));

  if (state.mode === 'chat' && state.session !== undefined) {
    return (
      <ChatRegion
        store={state.session.store}
        editor={state.input}
        palette={state.palette}
        search={state.search}
        mention={state.mention}
        modelPicker={state.modelPicker}
        effortPicker={state.effortPicker}
        now={props.nowMs}
        shellBusy={state.shellBusy}
        submitBusy={state.submitBusy}
        shellCommand={state.shellCommand}
        historyEntries={state.historyEntries}
        attachments={state.attachments}
      />
    );
  }
  if (state.mode === 'loading') {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
          {'> '}
          {sanitizeInline(state.pendingMessage)}
        </Text>
        <Text {...dimProps(color)} wrap="truncate-end">
          Starting chat… · Ctrl-C to cancel
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <HomeView
        snapshot={state.snapshot}
        editor={state.input}
        errorText={state.errorText}
        notice={state.notice}
        nowMs={props.nowMs()}
        cols={size.cols}
        rows={size.rows}
        color={color}
        paletteOpen={state.palette !== undefined || state.modelPicker !== undefined}
      />
      {state.palette !== undefined && (
        <PaletteView commands={HOME_PALETTE_COMMANDS} state={state.palette} color={color} />
      )}
      {state.modelPicker !== undefined && (
        <ModelPickerView state={state.modelPicker} color={color} nowMs={props.nowMs()} />
      )}
    </Box>
  );
}
