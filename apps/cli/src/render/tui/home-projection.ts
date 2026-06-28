import type {
  HomeAgentRow,
  HomeGateRow,
  HomeRunRow,
  HomeSessionRow,
} from '../../home/home-store.js';
import { sanitizeInline } from './chat-projection.js';
import { formatCostShort } from './format.js';

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
  return cols >= HOME_MIN_COLS && rows >= HOME_MIN_ROWS;
}

/** The single-line degrade shown (and held until a resize) when the terminal is below the Home minimum. */
export function tooSmallMessage(cols: number, rows: number): string {
  return `Terminal too small (${cols}×${rows}) — resize to at least ${HOME_MIN_COLS}×${HOME_MIN_ROWS}.`;
}

/** A short, display-safe id (the first 8 of a UUID) — for a run with no workflow slug to label it. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * A compact relative time from an ISO timestamp vs `nowMs`: "just now" (<1m or a future skew), "Xm ago",
 * "Xh ago", then "Xd ago". An unparseable timestamp yields "" (the caller renders nothing rather than `NaN`).
 */
export function relativeTime(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return '';
  const deltaSec = Math.floor((nowMs - thenMs) / 1000);
  if (deltaSec < 60) return 'just now'; // includes a small future skew (deltaSec < 0)
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** A gate's deadline as urgency text: "expired" once past (the Phase-1 in-process-timer caveat), else "expires …". */
export function expiryLabel(expiresAt: string | undefined, nowMs: number): string | undefined {
  if (expiresAt === undefined) return undefined;
  const deadlineMs = Date.parse(expiresAt);
  if (Number.isNaN(deadlineMs)) return undefined;
  if (deadlineMs <= nowMs) return 'expired';
  return `expires ${relativeIn(deadlineMs - nowMs)}`;
}

/** "in 30s" / "in 5m" / "in 2h" / "in 3d" — the forward-looking counterpart of {@link relativeTime}. */
function relativeIn(deltaMs: number): string {
  const sec = Math.max(1, Math.floor(deltaMs / 1000)); // floor a sub-second remaining to "in 1s", never "in 0s"
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.floor(hr / 24)}d`;
}

const SEP = '  ·  ';

/** A recent session row → its glanceable line: title (or agent) · agent · when · cost. An UNTITLED session
 *  shows the agent slug as both the title fallback and the trailing agent field (by design — the row stays
 *  uniform: a label, then the agent it ran). */
export function sessionLabel(row: HomeSessionRow, nowMs: number): string {
  const title = sanitizeInline(row.title ?? row.agentSlug);
  return [
    title,
    row.agentSlug,
    relativeTime(row.updatedAt, nowMs),
    formatCostShort(row.totalCostMicrocents),
  ]
    .filter((s) => s.trim().length > 0) // a sanitized-to-whitespace field must not leave a dangling separator
    .join(SEP);
}

/** A run row → workflow (or short id) · status · when (status-appropriate anchor) · cost. */
export function runLabel(row: HomeRunRow, nowMs: number): string {
  const name = row.workflowSlug ?? shortId(row.runId);
  const anchor = row.status === 'running' ? row.startedAt : (row.completedAt ?? row.startedAt);
  return [
    name,
    row.status,
    relativeTime(anchor ?? row.createdAt, nowMs),
    formatCostShort(row.totalCostMicrocents),
  ]
    .filter((s) => s.trim().length > 0)
    .join(SEP);
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
  return [row.agentSlug, relativeTime(row.lastUsedAt, nowMs)]
    .filter((s) => s.trim().length > 0)
    .join(SEP);
}
