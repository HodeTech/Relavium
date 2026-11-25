/**
 * The ONE overlay slot of a host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2 and
 * §4): where a popup is drawn, measured and acknowledged. Each host renders it as the LAST CHILD OF ITS ROOT, and it holds the ONLY absolutely
 * positioned node of the CLI (`popup-absolute-only.test.ts` pins both): z-order is tree order, and the spike showed that a later sibling is
 * drawn over a popup while the bounds check still passes, so nothing may come after the slot and nothing else may be absolute.
 *
 * - **Placement.** In the alternate screen a popup is an absolutely positioned box, centred over a body that stays drawn (`overlay`); inline it
 *   is a framed block in the flow that takes the body's place (`replace`), because the inline renderer cannot draw over its own scrollback.
 * - **Opacity.** Every row is exactly the frame's width, filled with spaces (`frame-model.ts`): the padding is what keeps the body from showing
 *   through. Opacity is the safety property; the dimming of the body behind is the look, and it is not done here: the slot is OUTSIDE the
 *   dimmed subtree (the host wraps everything but the slot in `BackdropDim`), so the popup's own cells are never dim, and
 *   {@link slotDrawing} / {@link dimsBackdrop} are the one predicate the hosts ask.
 * - **The measured frame.** The acknowledgement is handed the popup's CONTENT node, which has no fixed size, and refuses a frame that is not
 *   exactly the geometry's (`popup-acknowledgement.ts`). Below the floor, or inline with no room, a notice with the way back is drawn instead
 *   and nothing is acknowledged.
 * - **Fails closed.** A popup that throws while it is drawn is caught by an error boundary here and closed unanswered by its host; it never
 *   reaches the renderer's error path, which would end the Home (and cancel a hosted run with it).
 * - **One reader.** The slot reads no key: the host's root routes keys to the popup host (or the native channel), as it routes them to a card.
 *
 * Two body drivers share the one frame: the popup host's reducer (`HostPopup`) and the native prompt channel when a flow set its `popup`
 * descriptor (`NativePopup`).
 */

import { Box, Transform, type DOMElement } from 'ink';
import {
  Component,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import { withGlyphForm } from '../render/tui/glyphs.js';
import type { NativePromptAcknowledgement } from '../render/tui/native-prompt-acknowledgement.js';
import type { NativePromptSnapshot } from '../render/tui/native-prompt-channel.js';
import { SheetLinesView } from '../render/tui/permissions-sheet-view.js';
import type { SheetLine } from '../render/tui/sheet-frame.js';
import {
  bodyPageRows,
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  popupNoticeLegend,
  popupNoticeLines,
  type PopupFrameParts,
  type PopupNoticeReason,
} from './frame-model.js';
import {
  INLINE_LIST_MAX_ROWS,
  popupGeometry,
  popupInnerWidth,
  type PopupBoxGeometry,
  type PopupGeometry,
  type PopupPlacement,
} from './geometry.js';
import {
  nativeFramed,
  nativeNaturalRows,
  nativePopupLayout,
  nativePopupLegend,
  withLiveBullets,
  type NativeBodyLayout,
} from './native-popup-body.js';
import { Text } from '../render/tui/text.js';
import {
  popupFrameMatches,
  type ExpectedPopupFrame,
  type PopupAcknowledgement,
} from './popup-acknowledgement.js';
import type { PopupHost, PopupHostSnapshot } from './popup-host.js';
import { currentStep, popupLegend, railOf, type PopupFrame } from './popup-reducer.js';
import type { LegendExit, LegendItem } from '../render/tui/legend.js';

type Size = { readonly cols: number; readonly rows: number };

/** What the acknowledgement checks a drawn frame against: the geometry's own numbers. */
export function expectedFrame(geometry: PopupBoxGeometry): ExpectedPopupFrame {
  return {
    placement: geometry.placement,
    width: geometry.width,
    height: geometry.height,
    left: geometry.left,
    top: geometry.top,
  };
}

/**
 * Where the frame is drawn: in the overlay, the one absolutely positioned box of the CLI at the geometry's place; in the flow, as it is.
 * This is the ONLY `position="absolute"` in `apps/cli/src` (pinned by `popup-absolute-only.test.ts`).
 */
function Placed(
  props: Readonly<{ placement: PopupPlacement; left: number; top: number; children: ReactNode }>,
): ReactElement {
  if (props.placement === 'replace') return <>{props.children}</>;
  return (
    <Box position="absolute" marginTop={props.top} marginLeft={props.left} flexDirection="column">
      {props.children}
    </Box>
  );
}

/**
 * The frame's rows in their CONTENT node: a column with no size of its own, so what it measures is what was drawn. Exported so the measured-frame
 * tests can draw a frame whose rows are one cell too wide or one row too many and show the acknowledgement refuse it.
 */
export function PopupFrameView(
  props: Readonly<{
    lines: readonly SheetLine[];
    color: boolean;
    placement: PopupPlacement;
    left: number;
    top: number;
    contentRef: (node: DOMElement | null) => void;
  }>,
): ReactElement {
  return (
    <Placed placement={props.placement} left={props.left} top={props.top}>
      {/* No size of its own, and not stretched by a column parent either: what it measures is what its rows drew. */}
      <Box ref={props.contentRef} flexDirection="column" flexShrink={0} alignSelf="flex-start">
        <SheetLinesView lines={props.lines} color={props.color} />
      </Box>
    </Placed>
  );
}

/** The notice drawn in place of a popup the terminal cannot hold: the reason and the way back, opaque, at the top of the screen. */
function PopupNotice(
  props: Readonly<{
    reason: PopupNoticeReason;
    color: boolean;
    placement: PopupPlacement;
    columns: number;
    /** The popup's own leaving keys (what `Esc` and `Ctrl+C` do on its step), so the notice says what they do there. */
    legend: { readonly items: readonly LegendItem[]; readonly exit: LegendExit };
  }>,
): ReactElement {
  const lines = withGlyphForm(!props.color, () =>
    popupNoticeLines(props.reason, popupNoticeLegend(props.legend), props.columns),
  );
  return (
    <Placed placement={props.placement} left={0} top={0}>
      <SheetLinesView lines={lines} color={props.color} />
    </Placed>
  );
}

/** The page a step's body is drawn in: its rows and the columns of each row. */
export interface FramePage {
  readonly rows: number;
  readonly innerWidth: number;
}

/**
 * The page `frame`'s current step is drawn in, in `geometry` (`bodyPageRows`, the very rows `popupBody` draws it in): a report's page, a
 * form's whole body, else the window a list draws its rows in, and the inner width every row is cut to; one row of no column when no frame fits
 * (nothing is drawn).
 *
 * A report's own page is not the list window in two ways. It is as short as the report when the report is shorter than the window (the body
 * asks for no more rows than it has): that never changes what fits (such a report fits both) nor how far it scrolls (it does not scroll). And
 * it is a row shorter than the window when the step's filter line takes a body row the window still counts (a 17-line report under a filter
 * line on a 17-row body is drawn cut, `▼ 2 more`): there the window would offer an answer for a line that is not whole, so the page is the
 * report's own. A list's page is its window under its filter line and its heading and above its effect paragraph, so a page moves by the rows
 * it draws.
 */
export function framePage(
  frame: PopupFrame | undefined,
  geometry: PopupGeometry | undefined,
): FramePage {
  if (frame === undefined || geometry?.fits !== true) return { rows: 1, innerWidth: 0 };
  const { spec, state } = currentStep(frame);
  return {
    rows: bodyPageRows(state.content, spec.filter === true, geometry),
    innerWidth: geometry.innerWidth,
  };
}

/**
 * Tells a popup host the terminal's size, and voids its popup's measured frame, BEFORE the frame drawn at that size is committed: the slot
 * renders it ahead of the popup, so its layout effect runs before the popup's own (React runs a parent's children's layout effects in order,
 * each subtree before the next sibling's). After that commit would be too late: the acknowledgement of the frame at the new size would be voided
 * as it is made, the frame never acknowledged, and every key but `Esc` and `Ctrl+C` dropped as unseen (the stand-alone chat did that from a
 * passive effect). It runs on mount too, so a host that starts below the floor tells its popup host so before any popup opens. A step that holds
 * a chord or a secret is closed below the floor here (ADR-0148 §4), in the render the size causes.
 */
function PopupResizeWatch(
  props: Readonly<{
    host?: PopupHost | undefined;
    acknowledgement?: Pick<PopupAcknowledgement<PopupHostSnapshot>, 'invalidate'> | undefined;
    columns: number;
    rows: number;
  }>,
): null {
  const { host, acknowledgement, columns, rows } = props;
  useLayoutEffect(() => {
    acknowledgement?.invalidate();
    host?.resized(columns, rows);
  }, [host, acknowledgement, columns, rows]);
  return null;
}

/** The popup host's top popup, drawn from its reducer state. */
function HostPopup(
  props: Readonly<{
    host: PopupHost;
    acknowledgement: PopupAcknowledgement<PopupHostSnapshot>;
    snapshot: PopupHostSnapshot;
    size: Size;
    color: boolean;
    flush: () => Promise<void>;
  }>,
): ReactElement | null {
  const { host, acknowledgement, snapshot, size, color } = props;
  // The loading clock is a display value, not a field of the snapshot: a tick re-renders this view and changes no identity (ADR-0147 §2).
  const elapsed = useSyncExternalStore(host.clock.subscribe, host.clock.read);
  const node = useRef<DOMElement | null>(null);
  const frame = snapshot.frame;
  const geometry: PopupGeometry | undefined =
    frame === undefined
      ? undefined
      : (() => {
          const { spec, state } = currentStep(frame);
          const filter = spec.filter === true ? state.filter : undefined;
          const kind = frame.spec.kind ?? 'standard';
          // The body's row count depends on the glyph form (a cut ends in the table's ellipsis, `…` or `...`): count it in the form it is drawn in.
          return popupGeometry({
            columns: size.cols,
            rows: size.rows,
            kind,
            placement: snapshot.placement,
            rail: railOf(frame).names.length > 1,
            bodyRows: withGlyphForm(!color, () =>
              naturalBodyRows(
                state.content,
                { ...state, filter },
                snapshot.placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
                popupInnerWidth(size.cols, kind),
              ),
            ),
          });
        })();
  // The page this frame draws its step's body in: a report's page (what a confirmation line must fit whole to be answered, and what a page of
  // it scrolls by) else a list's window, and the inner width its rows are cut to (no line of a confirmation line may be cut either). Read
  // through a ref, so the host always reads the frame that was drawn last.
  const pageRef = useRef<FramePage>({ rows: 1, innerWidth: 0 });
  pageRef.current = framePage(frame, geometry);
  useLayoutEffect(() => {
    host.bindPageRows(() => pageRef.current.rows);
    host.bindInnerWidth(() => pageRef.current.innerWidth);
    return () => {
      host.bindPageRows(undefined);
      host.bindInnerWidth(undefined);
    };
  }, [host]);
  useLayoutEffect(() => {
    if (geometry?.fits !== true) {
      acknowledgement.invalidate();
      return;
    }
    acknowledgement.commit(snapshot, node.current, expectedFrame(geometry), props.flush);
  });
  if (frame === undefined || geometry === undefined) return null;
  const { spec, state } = currentStep(frame);
  if (!geometry.fits)
    return (
      <PopupNotice
        reason={geometry.reason}
        color={color}
        placement={snapshot.placement}
        columns={size.cols}
        legend={withGlyphForm(!color, () => popupLegend(frame))}
      />
    );
  const rail = railOf(frame);
  const parts: PopupFrameParts = {
    title: frame.spec.title,
    origin: frame.spec.origin,
    steps: rail.names,
    stepIndex: rail.index,
    done: rail.done,
    // The legend is judged on the page this frame draws (a report that fits names no scroll; a line cut short or with a row cut, and a form
    // that is not whole, name no answer).
    legend: withGlyphForm(!color, () =>
      popupLegend(frame, pageRef.current.rows, geometry.innerWidth),
    ),
    // The host's live notification, in the legend row while the popup covers the hint row.
    notice: snapshot.notice,
  };
  const lines = withGlyphForm(!color, () =>
    popupFrameLines(
      parts,
      popupBody(
        state.content,
        { ...state, filter: spec.filter === true ? state.filter : undefined },
        geometry,
        // Nothing ticks inline (the accessible mode, ADR-0148 §4).
        snapshot.placement === 'overlay' ? elapsed : undefined,
      ),
      geometry,
    ),
  );
  return (
    <PopupFrameView
      lines={lines}
      color={color}
      placement={snapshot.placement}
      left={geometry.left}
      top={geometry.top}
      contentRef={(element) => {
        node.current = element;
      }}
    />
  );
}

/**
 * The geometry and the body of a framed native prompt in a terminal of `size`: the one geometry function asked for the body's wrapped rows at
 * the popup's inner width, then the body laid out on the page it gives (whether it is wholly on it, and how far a windowed select pages). Both
 * in the glyph form colour asks for. Exported so the matrix and the golden draw the frame exactly as the slot does.
 */
export function nativePopupGeometry(
  snapshot: NativePromptSnapshot,
  placement: PopupPlacement,
  size: Size,
  color: boolean,
): { readonly geometry: PopupGeometry; readonly layout: NativeBodyLayout | undefined } {
  return withGlyphForm(!color, () => {
    const geometry = popupGeometry({
      columns: size.cols,
      rows: size.rows,
      kind: 'standard',
      placement,
      rail: (snapshot.popup?.stepCount ?? 1) > 1,
      bodyRows: nativeNaturalRows(snapshot, popupInnerWidth(size.cols, 'standard')),
    });
    return { geometry, layout: geometry.fits ? nativePopupLayout(snapshot, geometry) : undefined };
  });
}

/**
 * The frame's rows of a framed native prompt on `geometry` (its top edge, its rail with the step names, its body and its legend), in the glyph
 * form colour asks for: what the slot draws and what the matrix and the golden check.
 */
export function nativePopupFrameLines(
  snapshot: NativePromptSnapshot,
  geometry: PopupBoxGeometry,
  layout: NativeBodyLayout,
  color: boolean,
): readonly SheetLine[] {
  const descriptor = snapshot.popup;
  const count = descriptor?.stepCount ?? 1;
  const parts: PopupFrameParts = {
    title: descriptor?.title ?? '',
    origin: descriptor?.origin ?? 'home',
    // The rail's nodes carry the step names the flow gave (a node with none is drawn bare); the top edge says `step 2 of 3` either way.
    steps: Array.from({ length: count }, (_, index) => descriptor?.stepNames?.[index] ?? ''),
    stepIndex: descriptor?.stepIndex ?? 0,
    legend: withGlyphForm(!color, () => nativePopupLegend(snapshot, layout.page !== undefined)),
  };
  return withGlyphForm(!color, () => popupFrameLines(parts, { lines: layout.lines }, geometry));
}

/**
 * The frame of a framed native prompt in its content node, as {@link PopupFrameView} draws it, except a masked field's row: that row goes
 * through the renderer's output phase with the field as it is NOW (`withLiveBullets`), because on a resize the renderer redraws the tree it
 * has before it is rendered again, and a field the resize emptied must not be written with its old bullets (ADR-0148 §4).
 */
function NativeFrameView(
  props: Readonly<{
    lines: readonly SheetLine[];
    color: boolean;
    placement: PopupPlacement;
    left: number;
    top: number;
    contentRef: (node: DOMElement | null) => void;
    /** The masked field's row among `lines`, and the channel's current snapshot; absent ⇒ no masked field. */
    secret?: { readonly index: number; readonly live: () => NativePromptSnapshot } | undefined;
  }>,
): ReactElement {
  const { secret } = props;
  const row = secret === undefined ? undefined : props.lines[secret.index];
  if (secret === undefined || row === undefined)
    return (
      <PopupFrameView
        lines={props.lines}
        color={props.color}
        placement={props.placement}
        left={props.left}
        top={props.top}
        contentRef={props.contentRef}
      />
    );
  return (
    <Placed placement={props.placement} left={props.left} top={props.top}>
      <Box ref={props.contentRef} flexDirection="column" flexShrink={0} alignSelf="flex-start">
        <SheetLinesView lines={props.lines.slice(0, secret.index)} color={props.color} />
        <Transform transform={(text) => withLiveBullets(text, secret.live())}>
          <Text wrap="truncate-end">{row.text}</Text>
        </Transform>
        <SheetLinesView lines={props.lines.slice(secret.index + 1)} color={props.color} />
      </Box>
    </Placed>
  );
}

/** The terminal that gives a popup the most it can have: 76 columns and 21 rows, whatever is larger. */
const LARGEST_TERMINAL: Size = { cols: 200, rows: 200 };

/**
 * Why a framed native prompt that is not wholly on its page is drawn as a notice: below the floor; no room now (a larger terminal would hold it);
 * or too long for any popup (it does not fit even the largest popup a terminal gives, so enlarging the terminal cannot help).
 */
export function nativeNoticeReason(
  snapshot: NativePromptSnapshot,
  placement: PopupPlacement,
  geometry: PopupGeometry,
  color: boolean,
): PopupNoticeReason {
  if (!geometry.fits) return geometry.reason;
  const largest = nativePopupGeometry(snapshot, placement, LARGEST_TERMINAL, color);
  return largest.geometry.fits && largest.layout?.fits === true ? 'no-room' : 'too-long';
}

/** A native prompt a flow drew as a popup: the channel's snapshot in the popup frame, acknowledged by the channel's own acknowledgement. */
function NativePopup(
  props: Readonly<{
    snapshot: NativePromptSnapshot;
    acknowledgement: NativePromptAcknowledgement;
    placement: PopupPlacement;
    size: Size;
    color: boolean;
    flush: () => Promise<void>;
  }>,
): ReactElement | null {
  const { snapshot, acknowledgement, size, color, placement } = props;
  const node = useRef<DOMElement | null>(null);
  const descriptor = snapshot.popup;
  const { geometry, layout } = nativePopupGeometry(snapshot, placement, size, color);
  // The page a windowed select's `PgUp`/`PgDn` move by is the window THIS frame draws: read through a ref, so the channel reads the last one.
  const pageRef = useRef<number | undefined>(undefined);
  pageRef.current = layout?.page;
  useLayoutEffect(() => {
    acknowledgement.bindFramedPage(() => pageRef.current);
    return () => acknowledgement.bindFramedPage(undefined);
  }, [acknowledgement]);
  // Not wholly on its page (ADR-0148 §3): a prompt whose body does not fit is the notice, and nothing on it is acknowledged, so nothing answers.
  const onPage = geometry.fits && layout?.fits === true;
  useLayoutEffect(() => {
    const element = node.current;
    if (
      !onPage ||
      !geometry.fits ||
      element === null ||
      !popupFrameMatches(element, expectedFrame(geometry), size)
    ) {
      acknowledgement.invalidate();
      return;
    }
    acknowledgement.commit(snapshot, element, props.flush);
  });
  if (descriptor === undefined) return null;
  if (!geometry.fits || layout === undefined || !layout.fits)
    return (
      <PopupNotice
        reason={nativeNoticeReason(snapshot, placement, geometry, color)}
        color={color}
        placement={placement}
        columns={size.cols}
        legend={withGlyphForm(!color, () => nativePopupLegend(snapshot))}
      />
    );
  const lines = nativePopupFrameLines(snapshot, geometry, layout, color);
  return (
    <NativeFrameView
      lines={lines}
      color={color}
      placement={placement}
      left={geometry.left}
      top={geometry.top}
      contentRef={(element) => {
        node.current = element;
      }}
      secret={
        layout.secretRow === undefined
          ? undefined
          : { index: 1 + geometry.railRows + layout.secretRow, live: acknowledgement.current }
      }
    />
  );
}

/** Catches a popup that throws while it is drawn: its host closes it unanswered, and the Home stays. */
class PopupErrorBoundary extends Component<
  Readonly<{ onError: (cause: unknown) => void; children: ReactNode }>,
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(cause: unknown): void {
    this.props.onError(cause);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface PopupSlotProps {
  /** The host's popup host and its acknowledgement; absent ⇒ the host has none (a test that wires no popups). */
  readonly host?: PopupHost | undefined;
  readonly acknowledgement?: PopupAcknowledgement<PopupHostSnapshot> | undefined;
  /** The channel's snapshot and acknowledgement, when the host has a native prompt channel. */
  readonly native?:
    | {
        readonly snapshot: NativePromptSnapshot;
        readonly acknowledgement: NativePromptAcknowledgement;
      }
    | undefined;
  /** The renderer's placement: `overlay` in the alternate screen, `replace` inline. */
  readonly placement: PopupPlacement;
  readonly size: Size;
  readonly color: boolean;
  /** The renderer's flush: a frame counts only once it has been written to the terminal. */
  readonly flush: () => Promise<void>;
}

const noSubscribe = (): (() => void) => () => undefined;
const CLOSED_POPUPS: PopupHostSnapshot = {
  open: false,
  depth: 0,
  placement: 'overlay',
  frame: undefined,
};
const closedPopups = (): PopupHostSnapshot => CLOSED_POPUPS;

/** What the slot is drawing, and where: the native channel's framed prompt, or the popup host's top popup. */
export interface SlotDrawing {
  readonly source: 'native' | 'host';
  readonly placement: PopupPlacement;
}

/**
 * **The one predicate** of what the slot draws now: the native channel's prompt when a flow framed it (it wins, as it holds the keyboard
 * first), else the popup host's top popup when the host is wired and one is open, else nothing. The slot decides with it, and so do the
 * hosts when they ask whether the body behind is dimmed ({@link dimsBackdrop}), so the two can never disagree about whether a popup is up.
 * `snapshot` is the host's popup snapshot, which the caller reads as it reads it for the slot.
 */
export function slotDrawing(
  props: Pick<PopupSlotProps, 'host' | 'acknowledgement' | 'native' | 'placement'>,
  snapshot: PopupHostSnapshot,
): SlotDrawing | undefined {
  if (props.native !== undefined && nativeFramed(props.native.snapshot))
    return { source: 'native', placement: props.placement };
  if (
    props.host === undefined ||
    props.acknowledgement === undefined ||
    !snapshot.open ||
    snapshot.frame === undefined
  )
    return undefined;
  return { source: 'host', placement: snapshot.placement };
}

/**
 * Whether the body behind the slot is the backdrop of an open popup, drawn dim ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4): exactly when the slot draws a box over a body that STAYS drawn (the overlay, in the alternate screen; inline a popup replaces the body,
 * so there is nothing to dim) and colour is on (with colour off chalk prints no dim, and the popup is opaque and framed anyway).
 */
export function dimsBackdrop(drawing: SlotDrawing | undefined, color: boolean): boolean {
  return color && drawing?.placement === 'overlay';
}

/**
 * The overlay slot: the last child of a host's root. It draws the open popup, or nothing, and it tells the popup host the terminal's size first
 * ({@link PopupResizeWatch}, ahead of the popup in the slot), so a frame at a new size is always measured after the host knows that size.
 */
export function PopupSlot(props: Readonly<PopupSlotProps>): ReactElement {
  return (
    <>
      <PopupResizeWatch
        host={props.host}
        acknowledgement={props.acknowledgement}
        columns={props.size.cols}
        rows={props.size.rows}
      />
      <SlotBody {...props} />
    </>
  );
}

/** What the slot draws: the native channel's framed prompt, or the popup host's top popup, or nothing. */
function SlotBody(props: Readonly<PopupSlotProps>): ReactElement | null {
  const snapshot = useSyncExternalStore(
    props.host?.subscribe ?? noSubscribe,
    props.host?.getSnapshot ?? closedPopups,
  );
  const drawing = slotDrawing(props, snapshot);
  const native = props.native;
  if (drawing?.source === 'native' && native !== undefined)
    return (
      <NativePopup
        snapshot={native.snapshot}
        acknowledgement={native.acknowledgement}
        placement={props.placement}
        size={props.size}
        color={props.color}
        flush={props.flush}
      />
    );
  const host = props.host;
  const acknowledgement = props.acknowledgement;
  if (
    drawing?.source !== 'host' ||
    host === undefined ||
    acknowledgement === undefined ||
    snapshot.frame === undefined
  )
    return null;
  return (
    <PopupErrorBoundary key={snapshot.frame.runId} onError={(cause) => host.fail(cause)}>
      <HostPopup
        host={host}
        acknowledgement={acknowledgement}
        snapshot={snapshot}
        size={props.size}
        color={props.color}
        flush={props.flush}
      />
    </PopupErrorBoundary>
  );
}
