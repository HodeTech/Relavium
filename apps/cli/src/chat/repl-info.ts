import type { CompactionResult, TrimResult } from '@relavium/core';

import type { CatalogEntry } from '../workflows/catalog.js';
import { sanitizeInline, stripTerminalControls } from '../render/tui/chat-projection.js';
import type { SessionCostRow } from '@relavium/db';

import { formatCostUsd } from '../render/tui/format.js';

/**
 * Pure formatters for the in-REPL info commands (2.5.C S4) — `/cost` and `/workflows`. The output is rendered as
 * a notice in the chat view ({@link ChatStoreController.notice}); keeping the formatting pure means it is
 * unit-tested with no FS, no session, and no ink, and every dynamic field (a workflow slug) is sanitized at the
 * boundary so a crafted catalog entry can never forge a notice row or inject an escape.
 */

/** The `(pre-2.6.C)` sentinel row the ADR-0070 migration backfills for a legacy session — one row carrying the whole
 *  legacy total, because the per-attempt increments that would have split it were never kept. */
const LEGACY_SENTINEL = '(pre-2.6.C)';

/**
 * The `/cost` notice — the session's spend, broken down PER MODEL (ADR-0070).
 *
 * The rows are read from `session_costs`, NOT from an in-memory counter: a resumed session's total is seeded from the
 * durable row and covers the whole session, while memory knows only the models used in THIS process — so an in-memory
 * breakdown would visibly fail to sum to the total on the very first `/cost` after a resume. The table's invariant
 * (`SUM(rows) == agent_sessions.total_cost_microcents`) is what makes the total line trustworthy: the rows are
 * GUARANTEED to sum to it, for every session, past and future.
 *
 * Two honesties the panel must carry:
 *   • an `unpriced_calls > 0` row is a model we could not PRICE, not a free one — a $0.0000 row with real tokens
 *     would otherwise read as "this model costs nothing".
 *   • a legacy session predates per-model attribution entirely; its one sentinel row says so rather than implying a
 *     single-model session.
 *
 * The total is `agent_sessions.total_cost_microcents` — the authoritative number, and the one the budget cap enforces
 * against (ADR-0028). It is against Relavium's own event stream, not the provider's invoice: an egress that streamed
 * content but ended without a usage chunk, and a mid-stream failure, are both recorded as 0 on BOTH sides (ADR-0070
 * §3), so the reported spend is a systematic under-estimate of the bill. That is stated here, not buried.
 */
export function costNotice(
  totalCostMicrocents: number,
  rows: readonly SessionCostRow[] = [],
): string {
  const total = `Session cost: ${formatCostUsd(totalCostMicrocents)}`;
  if (rows.length === 0) return total;

  const legacy = rows.find((r) => r.model === LEGACY_SENTINEL);
  if (legacy !== undefined && rows.length === 1) {
    return `${total}\n  ${formatCostUsd(legacy.costMicrocents)}  (per-model breakdown unavailable — this session predates per-model attribution)`;
  }

  const lines = rows.map((r) => {
    const share =
      totalCostMicrocents > 0 ? Math.round((r.costMicrocents / totalCostMicrocents) * 100) : 0;
    const calls = `${r.callCount} ${r.callCount === 1 ? 'call' : 'calls'}`;
    const tokens = `${r.inputTokens + r.outputTokens} tok`;
    const unpriced =
      r.unpricedCalls > 0 ? `  — price unknown for ${r.unpricedCalls} of ${calls}` : '';
    const name =
      r.model === LEGACY_SENTINEL ? 'before per-model attribution' : sanitizeInline(r.model);
    return `  ${formatCostUsd(r.costMicrocents)}  ${String(share).padStart(3)}%  ${name}  (${calls}, ${tokens})${unpriced}`;
  });
  return [total, ...lines].join('\n');
}

/** The `/workflows` notice — the discovered workflow + agent catalogs (each slug sanitized), grouped by kind. A
 *  project that EXISTS but is empty gets one clear line — distinct from the caller's "No .relavium/ project found"
 *  message, so a user can tell an empty project apart from no project at all (path-free, like that message). */
export function catalogNotice(
  workflows: readonly CatalogEntry[],
  agents: readonly CatalogEntry[],
): string {
  if (workflows.length === 0 && agents.length === 0) {
    return 'No workflows or agents found in this project.';
  }
  return [catalogSection('Workflows', workflows), catalogSection('Agents', agents)].join('\n');
}

/** One `kind` section: a count header + one sanitized line per entry (invalid entries flagged, never dropped). */
function catalogSection(heading: string, entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) return `${heading}: none`;
  const rows = entries.map((entry) => {
    const slug = sanitizeInline(entry.slug);
    return `  ${slug}${entry.valid ? '' : ' (invalid)'}`;
  });
  return `${heading} (${entries.length}):\n${rows.join('\n')}`;
}

/** Group large integers with thin separators for a readable token count (`14200` → `14,200`). */
function groupInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Max summary characters shown inline in the `/compact` notice — a long summary is previewed, not dumped
 *  (the FULL summary is preserved in the durable transcript + `chat-export`; ADR-0062 §7). */
const SUMMARY_PREVIEW_CHARS = 800;

/**
 * The `/compact` (and auto-compaction) result notice (ADR-0062) — the token deltas + the summariser spend, plus
 * a preview of the summary (the lossy, paid operation is inspectable, §7). The summary is model output, so it is
 * `stripTerminalControls`-sanitized (OSC-52 / control sequences removed) and length-capped before it reaches the
 * terminal (a long summary is previewed with a pointer to the full text, never a scrollback-flooding dump).
 */
export function compactionNotice(result: CompactionResult): string {
  switch (result.kind) {
    case 'compacted': {
      const summary = stripTerminalControls(result.summary);
      const preview =
        summary.length > SUMMARY_PREVIEW_CHARS
          ? `${summary.slice(0, SUMMARY_PREVIEW_CHARS)}…\n(full summary kept in the session transcript — /export to read it all)`
          : summary;
      return (
        `⟳ Compacted the conversation — ~${groupInt(result.tokensBefore)} → ~${groupInt(result.tokensAfter)} ` +
        `context tokens (summary cost ${groupInt(result.summaryTokens.input)} in / ${groupInt(result.summaryTokens.output)} out).\n` +
        `Summary:\n${preview}`
      );
    }
    case 'nothing_to_compact':
      return 'Nothing to compact — the conversation is already short.';
    case 'failed':
      return `Compaction failed: ${sanitizeInline(result.message)}. Try /trim for a deterministic bound.`;
    case 'cancelled':
      return 'Compaction cancelled — the conversation is unchanged.';
  }
}

/** The `/trim` result notice (ADR-0062) — a deterministic drop, no LLM call. */
export function trimNotice(result: TrimResult): string {
  return result.kind === 'trimmed'
    ? `✂ Trimmed ${result.droppedMessageCount} older message(s) — keeping the last ${result.keptMessageCount}.`
    : `Nothing to trim — ${result.messageCount} message(s), already within the bound.`;
}

/**
 * The `/clear` notice (ADR-0062 §7) — the current conversation has been ended (still persisted + resumable) and a
 * fresh session started. It surfaces the OLD sessionId + the exact `relavium chat-resume` command so the prior
 * conversation is DISCOVERABLE, not merely theoretically recoverable. The id is `sanitizeInline`-guarded: a
 * `sessionId` is only schema-constrained to a non-empty string (the CLI mints a UUID, but `history.db` is shared
 * with other surfaces), so a crafted stored id could otherwise smuggle a terminal escape into this notice.
 */
export function clearedNotice(oldSessionId: string): string {
  const safeId = sanitizeInline(oldSessionId);
  return `✨ Started a fresh conversation. The previous one is saved — resume it with \`relavium chat-resume ${safeId}\`.`;
}

/**
 * The mid-session `/models` model-SWITCH marker ([ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)).
 *
 * It was the INTRO LINE of the reseated session, because until 2.6.C the reseated view opened EMPTY — it announced
 * the new model to a blank screen and told the user what to do next. Now that the conversation carries across the
 * swap (2.6.C / F1), this lands as an **inline marker BENEATH the conversation it interrupts**, so it says what
 * actually changed: `old → new`. The turn count is gone — the turns are visibly there — and so is the "type a
 * message" tail, which was an intro's job on an empty screen.
 *
 * What it must NOT lose: the DISCLOSURE that a host-side reseat carries the transcript **text-only**, so the new
 * model does not see prior tool calls or file contents. ADR-0059 binds that clause (its Decision and Consequences
 * both rest on it); dropping it would need a superseding ADR, not a wording change. Position and phrasing were never
 * bound — only the disclosure.
 *
 * Both ids are `model_catalog` ids (curated), but `sanitizeInline`-guarded defensively: a live-catalog id is
 * provider-sourced and `history.db` is shared across surfaces, so a crafted value must not smuggle a terminal escape
 * into the transcript.
 */
export function modelSwitchNotice(oldModel: string, newModel: string): string {
  return (
    `⇄ model changed ${sanitizeInline(oldModel)} → ${sanitizeInline(newModel)} — the new model sees the text ` +
    `transcript only (not prior tool calls or file contents).`
  );
}
