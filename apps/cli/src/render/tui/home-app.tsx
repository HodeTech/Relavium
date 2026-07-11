import { Box, Text, useApp, useInput, usePaste } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import { CHAT_PALETTE_COMMANDS, HOME_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { PendingAttachment } from './attachments.js';
import { ChatView } from './chat-ink.js';
import type { EditorState } from './chat-input.js';
import { liveScrollGeometry, sanitizeInline, wrapTranscript } from './chat-projection.js';
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
import { createMouseReportReader, type MouseEvent as TerminalMouseEvent } from './mouse.js';
import {
  normalizeSelection,
  selectionText,
  type SelectionRange,
  type SelectionState,
  routeMouseSelection,
} from './selection.js';
import {
  effectiveOffset,
  INITIAL_SCROLL,
  reduceScroll,
  scrollMotionForKey,
  WHEEL_LINES,
  type ScrollGeometry,
  type ViewportGeometry,
  type ScrollState,
} from './scroll.js';

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The session state machine lives in {@link HomeController} (a plain
 * external store, unit-tested without ink); `RootApp` is a thin view that subscribes to it, forwards every key to
 * `controller.handleKey`, and renders the Home strip, the loading echo, or the chat region from the published
 * state. The clock + terminal size are injected so the strip degrade (<80×24) and the relative times are testable.
 */

export type { HomeChatSession } from './home-controller.js';

import type { ClipboardOutcome } from '../clipboard.js';
import type { SuspendPort } from '../suspend.js';

export interface RootAppProps {
  readonly controller: HomeController;
  readonly nowMs: () => number;
  readonly color: boolean;
  readonly getSize: () => { cols: number; rows: number };
  /** Subscribe to terminal resizes; returns an unsubscribe. */
  readonly subscribeResize: (onResize: () => void) => () => void;
  /** `true` ⇒ mounted on ink 7's alternate screen (2.6.F Step 4b, ADR-0068 §c) — the in-Home chat's transcript
   *  renders through the scroll viewport (bounded to the resize-tracked size) instead of `<Static>`. Resolved by
   *  `driveHome` (`resolveRenderMode`); absent/false ⇒ the inline renderer. */
  readonly alternateScreen?: boolean;
  /** The ADR-0068 §e suspend port (2.6.F Step 5d). `RootApp` attaches ink's `useApp().suspendTerminal` to it while
   *  mounted — the ONLY way the non-React slash dispatch (`createHomeController` is built before this tree exists)
   *  can reach `/scrollback` and `/edit`. Absent (a test) ⇒ the hatches notice "needs an interactive terminal". */
  readonly suspendPort?: SuspendPort | undefined;
  /** Write the in-Home chat's mouse selection to the system clipboard over OSC 52 (2.6.F Step 6). Absent ⇒ the
   *  selection still highlights but copy-on-select is inert (a test that wires no terminal). */
  readonly clipboard?: ((text: string) => ClipboardOutcome) | undefined;
  /** `[preferences].show_banner` (2.6.F Step 5g) — forwarded verbatim to `HomeView`, which owns the visibility rule. */
  readonly showBanner?: boolean | undefined;
  /**
   * Turn terminal mouse reporting on/off as the in-Home CHAT takes and gives up the screen (2.6.F Step 6g).
   *
   * Capturing the mouse for the whole Home was a regression: the landing has no viewport to wheel-scroll and no in-app
   * selection, so the user lost the emulator's native click-drag there and got nothing back — they could not even copy
   * a session id off the strip. Absent (or `--no-mouse` / `[preferences].mouse = false`) ⇒ never captured.
   */
  readonly setMouseCapture?: ((enabled: boolean) => void) | undefined;
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
    /** The live terminal width (resize-tracked in `RootApp`) — bounds the reasoning panel to N rendered rows (2.5.H). */
    cols: number;
    /** PRESENT ⇒ the alt-screen renderer (2.6.F Step 4b, ADR-0068 §c): the chat region is bounded to the terminal
     *  size and the transcript renders through the scroll viewport instead of `<Static>`, carrying the RootApp-held
     *  `scroll` state (4b-2) + the `onMeasure` geometry-lift. Absent ⇒ inline. */
    viewport:
      | {
          readonly rows: number;
          readonly cols: number;
          readonly scroll: ScrollState;
          /** The active mouse selection, document-ordered (2.6.F Step 6). */
          readonly selection?: SelectionRange | undefined;
          readonly onMeasure: (geom: ViewportGeometry) => void;
        }
      | undefined;
    shellBusy: boolean;
    submitBusy: boolean;
    shellCommand: string | undefined;
    historyEntries: readonly string[];
    attachments: readonly PendingAttachment[];
    /** The in-flight `[c]` typed-reason capture buffer (Step 14) — shows the reason input in the approval prompt. */
    reasonDraft: EditorState | undefined;
  }>,
): ReactElement {
  const { state, tick, color, mode, reasoningEffort, reasoningVisible, approval } =
    useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  // Read the clock in THIS per-frame component (see the `now` prop doc) so the elapsed advances live.
  const nowMs = props.now();
  const viewport = props.viewport;
  return (
    // Alt-screen (Step 4b): bound the chat region to the terminal `rows` so `ChatView`'s flex-grow viewport has a
    // height to fill below any keyboard-owning overlay (palette / search / model-picker / …); inline ⇒ unbounded.
    <Box flexDirection="column" {...(viewport === undefined ? {} : { height: viewport.rows })}>
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
        columns={props.cols}
        viewport={viewport}
        reasonDraft={props.reasonDraft}
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
  // Attach ink's `suspendTerminal` to the ADR-0068 §e port while this tree is mounted (2.6.F Step 5d). `useApp()` is
  // the only place it exists, and the in-Home chat's slash dispatch runs outside React — so the port is the bridge.
  // Invoked as a METHOD (`app.suspendTerminal(cb)`), never as a bare destructured reference: ink 7 hands it out
  // unbound off the prototype, so this form is immune to how the context object is shaped.
  const app = useApp();
  const suspendPort = props.suspendPort;
  useEffect(() => {
    if (suspendPort === undefined) return;
    suspendPort.attach((callback) => app.suspendTerminal(callback));
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort]);
  const [size, setSize] = useState(getSize);
  // The alt-screen transcript SCROLL state (2.6.F Step 4b-2) — RootApp-local (a pure-render concern, like `size`;
  // NOT session state), ref-shadowed for coalesced-chunk safety, and the viewport's live geometry lifted into
  // `scrollGeomRef` via `onMeasure` so a scroll key reduces against the SAME geometry the viewport windows with.
  const [scroll, setScroll] = useState<ScrollState>(INITIAL_SCROLL);
  const scrollRef = useRef<ScrollState>(INITIAL_SCROLL);
  // Survives an SGR mouse report SPLIT across two `useInput` calls (Step 6f). One reader per mount: it holds the
  // fragment, so it must not be re-created on every render.
  const mouseReaderRef = useRef(createMouseReportReader());
  // Whether the transcript was following the tail when the current gesture began — a plain click restores it.
  const followedBeforeSelectionRef = useRef(false);
  // Whether a left-button gesture is in flight — set by a press inside the viewport, cleared on release. Distinct from
  // a retained highlight, so a stray click after a copy cannot re-copy it (Step 6h review).
  const gestureActiveRef = useRef(false);
  // The mouse selection (2.6.F Step 6) — held exactly like `scroll`: state for the render, a ref so a coalesced drag
  // burst (several SGR reports in ONE stdin read) reduces off the latest rather than the render closure.
  const [selection, setSelection] = useState<SelectionState | undefined>(undefined);
  const selectionRef = useRef<SelectionState | undefined>(undefined);
  // Seeded at zero: the post-commit measure fills it on the first frame. `top`/`left`/`width` are the box's position
  // in ink's frame — the mouse handler's half of the row→line mapping (Step 6).
  const scrollGeomRef = useRef<ViewportGeometry>({
    totalLines: 0,
    height: 0,
    width: 0,
    top: 0,
    left: 0,
  });
  const applySelection = (next: SelectionState | undefined): void => {
    selectionRef.current = next;
    setSelection(next);
  };
  const applyScroll = (next: ScrollState): void => {
    scrollRef.current = next;
    setScroll(next);
  };

  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(() => subscribeResize(() => setSize(getSize())), [subscribeResize, getSize]);

  // Reset the scroll to the TAIL when the chat SESSION changes — a fresh chat, a `/clear` swap, or a `/models` reseat
  // (RootApp is NOT remounted across a swap the way driveInk remounts ChatApp, so without this a new session would
  // inherit the prior one's frozen offset). Keyed on the session OBJECT identity, NOT `sessionId`: a `/models` reseat
  // deliberately PRESERVES the sessionId across the swap (the reseated session adopts the same durable row —
  // home-controller `reseatChat`), so a string-keyed effect would MISS a reseat and leave a scrolled-away transcript
  // frozen (Step-4b-2 Sonnet review). The controller carries `state.session` by reference across non-swap updates and
  // mints a fresh object only on startChat/clearChat/reseatChat, so the object identity fires exactly on a swap.
  // Entering chat (undefined ⇒ session) and leaving it (session ⇒ undefined) also re-follow.
  const session = state.session;
  useEffect(() => {
    applyScroll(INITIAL_SCROLL); // reset on the session-object transition only (deps = [session]); applyScroll only
  }, [session]); // touches render-stable refs + setState, so it is intentionally omitted from the deps.

  // In the alt-screen in-Home chat, PgUp/PgDn/Ctrl+Home/Ctrl+End SCROLL the transcript viewport (Step 4b-2) BEFORE
  // the key reaches the controller — inline mode keeps native scrollback, and a bare Home / a non-chat mode has no
  // viewport, so those fall straight through. Gated on NO keyboard-owning overlay (palette / search / mention /
  // model-picker / effort-picker / reason-capture) — mirroring ChatApp's after-overlays ordering, so an overlay that
  // later paged with PgUp/PgDn keeps its keys. The approval prompt is in the fixed live region (always visible), so
  // no force-follow is needed (parity with `ChatApp`).
  const noOverlay =
    state.palette === undefined &&
    state.search === undefined &&
    state.mention === undefined &&
    state.modelPicker === undefined &&
    state.effortPicker === undefined &&
    state.reasonDraft === undefined;
  const altChat = props.alternateScreen === true && state.mode === 'chat' && noOverlay;
  // Capture the mouse exactly while the CHAT owns the screen — not while an overlay is open over it (a transient
  // state; toggling DECSET per overlay would be churn, and a report there is consumed and ignored anyway).
  const mouseCaptured = props.alternateScreen === true && state.mode === 'chat';
  const setMouseCapture = props.setMouseCapture;
  useEffect(() => {
    setMouseCapture?.(mouseCaptured);
  }, [mouseCaptured, setMouseCapture]);

  // Reduce against LIVE geometry (parity with `ChatApp`): wrap the session store's CURRENT transcript at the keypress
  // for a fresh `totalLines`, not the `onMeasure` ref which lags by up to a commit — else a mid-stream burst makes
  // `settle` resume-follow against a stale bottom (Step-4b-2 Sonnet review). `getSnapshot()` reads the store fresh
  // regardless of closure staleness; no session (bare Home) ⇒ the lifted geometry, nothing to move. Hoisted out of
  // `useInput` at Step 6 so the scroll keymap and the selection reducer share ONE definition.
  const liveGeom = (): ScrollGeometry => {
    const store = state.session?.store;
    return store === undefined
      ? scrollGeomRef.current
      : liveScrollGeometry(
          store.getSnapshot().state.transcript,
          size.cols,
          scrollGeomRef.current.height,
        );
  };

  /** Reduce one non-wheel mouse report into the in-Home chat's selection (2.6.F Step 6) — the same reducer, the same
   *  viewport facts, and therefore the same behaviour as `relavium chat`. */
  const routeSelection = (event: TerminalMouseEvent): void => {
    routeMouseSelection(event, {
      geometry: () => {
        const measured = scrollGeomRef.current;
        const live = liveGeom();
        return {
          top: measured.top,
          left: measured.left,
          height: live.height,
          totalLines: live.totalLines,
          offset: effectiveOffset(scrollRef.current, live),
        };
      },
      current: () => selectionRef.current,
      setSelection: applySelection,
      copy: copySelection,
      scrollBy: (motion: 'line-up' | 'line-down') =>
        applyScroll(reduceScroll(scrollRef.current, motion, liveGeom())),
      pauseFollow: () => {
        const scroll = scrollRef.current;
        followedBeforeSelectionRef.current = scroll.following;
        if (!scroll.following) return;
        applyScroll({ offset: effectiveOffset(scroll, liveGeom()), following: false });
      },
      restoreFollow: () => {
        if (!followedBeforeSelectionRef.current) return;
        applyScroll({ ...scrollRef.current, following: true });
      },
      gestureActive: () => gestureActiveRef.current,
      setGestureActive: (active: boolean) => {
        gestureActiveRef.current = active;
      },
    });
  };

  /** Copy on release. SILENT on success: a notice would append a transcript entry and shift the very lines the user
   *  just selected. Only a refusal (past the terminal's OSC 52 length floor) is worth telling them about. */
  const copySelection = (state_: SelectionState): void => {
    const clipboard = props.clipboard;
    const store = state.session?.store;
    if (clipboard === undefined || store === undefined) return;
    const rows = wrapTranscript(store.getSnapshot().state.transcript, size.cols).map(
      (line) => line.text,
    );
    const outcome = clipboard(selectionText(rows, normalizeSelection(state_)));
    if (outcome.kind === 'too-large') {
      store.note(
        `selection too large to copy (${Math.ceil(outcome.base64Length / 1024)} KB) — use /scrollback or /edit`,
      );
    }
  };

  // A resize re-wraps the transcript, and a session swap (`/clear`, a reseat) replaces it — either way every
  // display-line index the selection holds moves. Drop it rather than highlight, and copy, the wrong text.
  useEffect(() => {
    applySelection(undefined);
  }, [size.cols, state.session]);

  /** One wheel notch. Kept beside `routeSelection` so the two mouse verbs read alike. */
  const routeWheel = (direction: 'up' | 'down'): void => {
    const geom = liveGeom();
    const motion = direction === 'up' ? 'line-up' : 'line-down';
    let next = scrollRef.current;
    for (let i = 0; i < WHEEL_LINES; i += 1) next = reduceScroll(next, motion, geom);
    applyScroll(next);
  };

  /**
   * Consume a mouse report, if `input` is one. Returns `true` when it was — the caller must then type NOTHING: a
   * report's raw bytes must never reach the Home prompt, the `/` palette filter, or the `[c]` reason capture. That is
   * true in EVERY mode and behind EVERY overlay; only the ROUTING is gated on the chat owning the screen.
   */
  const consumeMouseReport = (input: string): boolean => {
    if (props.alternateScreen !== true) return false;
    const read = mouseReaderRef.current.read(input);
    if (read.kind === 'none') return false;
    const mouse = read.kind === 'event' ? read.event : undefined;
    if (mouse !== undefined && altChat) {
      if (mouse.kind === 'wheel') routeWheel(mouse.direction);
      else routeSelection(mouse);
    }
    return true;
  };

  useInput((input, key) => {
    if (consumeMouseReport(input)) return;
    if (altChat) {
      // Esc DISMISSES a live selection. Gated on an IDLE chat: while a turn streams, Esc is the mid-turn ABORT that
      // `controller.handleKey` reduces, and shadowing an abort with a cosmetic clear would be a bad trade. Mirrors
      // ChatApp exactly — a click still clears the highlight mid-turn.
      const chatRunning = state.session?.store.getSnapshot().state.status === 'running';
      if (key.escape === true && !chatRunning && selectionRef.current !== undefined) {
        applySelection(undefined);
        return;
      }
      const motion = scrollMotionForKey(key);
      if (motion !== undefined) {
        applyScroll(reduceScroll(scrollRef.current, motion, liveGeom()));
        return;
      }
    }
    controller.handleKey(input, key);
  });
  // Bracketed paste arrives on ink 7's native `usePaste` channel (separate from `useInput`): the whole paste is
  // one `text` event, so a multi-line block appends verbatim and a pasted approval token never reaches the key
  // reducers (ADR-0068). The controller gates it (drops behind an overlay / pending approval / mid-turn).
  usePaste((text) => controller.handlePaste(text));

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
        cols={size.cols}
        // Alt-screen (Step 4b): the resize-tracked size bounds the chat region + wraps the transcript viewport, which
        // carries the scroll state (4b-2) + reports its geometry back into `scrollGeomRef` for the scroll keymap.
        viewport={
          props.alternateScreen === true
            ? {
                rows: size.rows,
                cols: size.cols,
                scroll,
                // Document-ordered here, once: the viewport draws it, `copySelection` re-derives it for the clipboard.
                ...(selection === undefined ? {} : { selection: normalizeSelection(selection) }),
                onMeasure: (g: ViewportGeometry): void => {
                  scrollGeomRef.current = g;
                },
              }
            : undefined
        }
        reasonDraft={state.reasonDraft}
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
        showBanner={props.showBanner}
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
