import type {
  HomeAgentRow,
  HomeGateRow,
  HomeRunRow,
  HomeSessionRow,
  HomeSnapshot,
} from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { formatAgeOfIso, formatElapsed, formatTimeUntil, shortId } from '../notation.js';
import { sanitizeInline } from '../sanitize.js';
import { formatCostShort } from './format.js';
import { glyph, glyphOf } from './glyphs.js';
import { exitKey, keyLabel, legend, type LegendExit, type LegendKey } from './legend.js';

/**
 * Pure projection helpers for the 2.5.B Home strip (ADR-0054) — the read-only display of recent sessions /
 * runs / agents + an "attention" section. Like the chat projection, all logic lives here (clock-injected, no
 * ink) so the `HomeView` is a thin render and every label is unit-tested. Every model/user-derived free-form
 * string (a session title, a gate message) goes through `sanitizeInline` at this display boundary — which strips
 * control sequences AND collapses any newline/tab to a space, so the value cannot spoof extra rows/columns in a
 * one-line strip row; the kebab slugs (`workflowSlug` / `agentSlug`) and the closed enums (`status` / `gateType`)
 * are safe by construction. Cost reuses the canonical {@link formatCostShort} (one home for the µ¢→USD math).
 */

/** The minimum terminal the Home renders in; below it, degrade to a resize prompt (ADR-0054 / §2.5.B). */
export const HOME_MIN_COLS = 80;
export const HOME_MIN_ROWS = 24;

/** Whether the terminal is at least the Home minimum — else the caller renders {@link tooSmallMessage}. */
export function homeFitsTerminal(cols: number, rows: number): boolean {
  return (
    Number.isSafeInteger(cols) &&
    Number.isSafeInteger(rows) &&
    cols >= HOME_MIN_COLS &&
    rows >= HOME_MIN_ROWS
  );
}

/** Whether the Home has nothing to show: no session, run or attention row, and no parked run of this project either. */
export function homeIsEmpty(
  snapshot: HomeSnapshot,
  parkedRuns: readonly unknown[] | undefined,
): boolean {
  return snapshot.isEmpty && (parkedRuns === undefined || parkedRuns.length === 0);
}

/** The single-line degrade shown (and held until a resize) when the terminal is below the Home minimum. */
export function tooSmallMessage(cols: number, rows: number): string {
  return `Terminal too small (${cols}×${rows}) — resize to at least ${HOME_MIN_COLS}×${HOME_MIN_ROWS}.`;
}

/** A gate's deadline as urgency text: "expired" once past (the Phase-1 in-process-timer caveat), else "expires …". */
export function expiryLabel(expiresAt: string | undefined, nowMs: number): string | undefined {
  if (expiresAt === undefined) return undefined;
  const deadlineMs = Date.parse(expiresAt);
  if (Number.isNaN(deadlineMs)) return undefined;
  if (deadlineMs <= nowMs) return 'expired';
  return `expires ${formatTimeUntil(deadlineMs - nowMs)}`;
}

/** Whether a gate's deadline is already past — the renderer escalates an overdue gate from yellow to red. */
export function gateExpired(row: HomeGateRow, nowMs: number): boolean {
  return expiryLabel(row.expiresAt, nowMs) === 'expired';
}

const SEP = '  ·  ';

/** A recent session row → its glanceable line: title · agent · when · cost. An UNTITLED session shows the agent
 *  slug ONCE (the slug is its own label) rather than doubling it as a title fallback AND the trailing field. */
export function sessionLabel(row: HomeSessionRow, nowMs: number): string {
  // Titled: the user-derived label, then the agent it ran. Untitled: just the agent slug (shown once).
  const head =
    row.title === undefined ? [row.agentSlug] : [sanitizeInline(row.title), row.agentSlug];
  return [
    ...head,
    formatAgeOfIso(row.updatedAt, nowMs),
    formatCostShort(row.totalCostMicrocents, row.usageCoverage, row.unpricedCalls),
  ]
    .filter((s) => s.trim().length > 0) // a sanitized-to-whitespace field must not leave a dangling separator
    .join(SEP);
}

/** What the strip says after the cost of a run recorded for another project: it lists runs of every directory, and such a run opens read-only. */
export const OTHER_PROJECT_MARK = 'other project';

/** A run row → workflow (or short id) · status · when (status-appropriate anchor) · cost [· other project]. */
export function runLabel(row: HomeRunRow, nowMs: number): string {
  const name = row.workflowSlug ?? shortId(row.runId);
  const anchor = row.status === 'running' ? row.startedAt : (row.completedAt ?? row.startedAt);
  return [
    name,
    row.status,
    formatAgeOfIso(anchor ?? row.createdAt, nowMs),
    formatCostShort(row.totalCostMicrocents, row.usageCoverage, row.unpricedCalls),
    ...(row.project === undefined ? [] : [OTHER_PROJECT_MARK]),
  ]
    .filter((s) => s.trim().length > 0)
    .join(SEP);
}

/**
 * A run whose event log could not be read (#W15-15) → a short id plus what is missing. There is no workflow
 * slug to fall back on here: the snapshot only carries the id, because the read that would have named the run
 * is the one that failed.
 */
export function unreadableRunLabel(runId: string): string {
  return `${shortId(runId)}${SEP}event log unreadable${SEP}gate detail unavailable`;
}

/** A pending-gate row → workflow (or short id) · gateType · message · expiry-urgency. */
export function gateLabel(row: HomeGateRow, nowMs: number): string {
  const name = row.workflowSlug ?? shortId(row.runId);
  const expiry = expiryLabel(row.expiresAt, nowMs);
  return [
    name,
    row.gateType,
    sanitizeInline(row.message),
    ...(expiry === undefined ? [] : [expiry]),
  ]
    .filter((s) => s.trim().length > 0) // a whitespace-only (sanitized) gate message must not dangle a separator
    .join(SEP);
}

/** A recently-used agent → slug · when last used. */
export function agentLabel(row: HomeAgentRow, nowMs: number): string {
  return [row.agentSlug, formatAgeOfIso(row.lastUsedAt, nowMs)]
    .filter((s) => s.trim().length > 0)
    .join(SEP);
}

/** Whether the run host has a leg that is preparing, executing or cancelling: the one meaning of "a run is active" for the Home. */
export function hostedRunIsLive(snapshot: RunHostSnapshot | undefined): boolean {
  return snapshot !== undefined && (snapshot.active !== undefined || snapshot.launching);
}

/**
 * The run row of the Home's strip ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): the
 * active run's id and its state, in one line, or `undefined` (no row at all) when no run is active. The state is a word, never a
 * colour alone: `starting` until the engine has named the run, `running`, and `cancelling` once the stop was requested. The id is
 * sanitized at this boundary. `last` is how an earlier leg ended; it is a later card's to show, not this row's.
 */
export function hostedRunLabel(snapshot: RunHostSnapshot | undefined): string | undefined {
  if (snapshot === undefined || !hostedRunIsLive(snapshot)) return undefined;
  const active = snapshot.active;
  if (active?.runId === undefined) return `${glyph('starting')} run${SEP}starting`;
  // Once the engine has named the run, `Enter` at the empty prompt brings its view back: the row says so, because nothing else does. The glyph
  // is the run view's own for the same state (`◐ running`, `■ cancelling`), and the word stands beside it.
  const cancelling = active.cancelling;
  return `${glyph(cancelling ? 'stopping' : 'running')} ${sanitizeInline(active.runId)}${SEP}${cancelling ? 'cancelling' : 'running'}${SEP}${HOSTED_RUN_ENTER_CUE}`;
}

/** What `Enter` at the empty prompt does while a leg is live and has a run to show: the item the landing's hint draws. */
export const HOSTED_RUN_ENTER_ITEM: LegendKey = { keys: 'Enter', verb: 'show it' };
/** The words the run row and the landing's hint share: {@link HOSTED_RUN_ENTER_ITEM} as it is written. */
export const HOSTED_RUN_ENTER_CUE = `${keyLabel(HOSTED_RUN_ENTER_ITEM.keys)} ${HOSTED_RUN_ENTER_ITEM.verb}`;

/** Whether a leg is live and has named its run, so `Enter` at the empty prompt can show its view (`openRunView`). */
export function hostedRunCanBeShown(snapshot: RunHostSnapshot | undefined): boolean {
  return snapshot?.active?.runId !== undefined;
}

/** What the exit-guard card is showing: it asks first, then waits for the run to stop. */
export type ExitGuardPhase = 'confirm' | 'stopping';

/**
 * The glyph of the exit-guard card's title row, so the card reads without colour as the other cards do (ADR-0122 §7.2): a warning while the
 * run is still going, the stop square once the person confirmed, and the quiet ring once there is nothing left to stop. Each surface has its
 * own glyph and a word for each state, and "the run is stopping" is not drawn alike: the strip's run row says the word `cancelling`, the run
 * view draws `■ cancelling`, and this card draws `⚠` (still asking) and then `■` (confirmed).
 */
export const EXIT_GUARD_GLYPH = {
  warning: glyphOf('warning', false),
  stopping: glyphOf('stopping', false),
  ended: glyphOf('ended', false),
} as const;

/** The three keys that leave the guard without leaving the Home: nothing changes, the run goes on and so does the Home. */
const EXIT_GUARD_STAY: LegendExit = exitKey.close(['Esc', 'Ctrl+C', 'Ctrl+N'], 'stay');

/**
 * The exit-guard card's lines ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6). The title
 * row is a glyph and a few words; each line is short enough for 80 columns and says what the keys do in words. While it asks, `Ctrl+Y`
 * stops the run and leaves and the other three keys stay; once the person confirmed, the card only says that the run is stopping and for
 * how long the Home waits.
 */
export function exitGuardLines(
  phase: ExitGuardPhase,
  snapshot: RunHostSnapshot | undefined,
  /** The longest a confirmed exit waits for the run: the grace and then the host's settle bound ({@link HOSTED_RUN_EXIT_BOUND_MS}). */
  boundSeconds: number,
): readonly string[] {
  const active = hostedRunIsLive(snapshot) ? snapshot?.active : undefined;
  // `: <run id>` for a leg that has named its run, nothing for one that has not: the card's title names the run when it can.
  const named = active?.runId === undefined ? '' : `: ${sanitizeInline(active.runId)}`;
  if (phase === 'stopping')
    return [
      `${glyph('stopping')} Stopping the run…`,
      `The Home leaves as soon as it has stopped, within about ${formatElapsed(boundSeconds * 1000)}.`,
    ];
  if (!hostedRunIsLive(snapshot))
    return [
      `${glyph('ended')} The run has ended.`,
      legend([{ keys: 'Ctrl+Y', verb: 'leave the Home' }], EXIT_GUARD_STAY),
    ];
  if (active?.cancelling === true)
    return [
      `${glyph('warning')} The run is stopping${named}.`,
      legend(
        [
          {
            keys: 'Ctrl+Y',
            verb: `leave once it stops (about ${formatElapsed(boundSeconds * 1000)})`,
          },
        ],
        EXIT_GUARD_STAY,
      ),
    ];
  return [
    `${glyph('warning')} A workflow run is executing${named}.`,
    'Leaving stops it, and a stopped run cannot be resumed.',
    legend([{ keys: 'Ctrl+Y', verb: 'stop the run and leave' }], EXIT_GUARD_STAY),
  ];
}
