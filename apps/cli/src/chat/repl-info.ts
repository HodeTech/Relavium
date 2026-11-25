import type { CompactionResult, TrimResult } from '@relavium/core';

import type { CatalogEntry } from '../workflows/catalog.js';
import { sanitizeInline, stripTerminalControls } from '../render/tui/chat-projection.js';
import type { SessionCostRow } from '@relavium/db';
import { isUsageCoverageComplete, type UsageCoverage } from '@relavium/shared';

import { formatUsdExact } from '../render/notation.js';
import type { Surface } from '../render/surface.js';
import { formatReportedCost } from '../render/tui/format.js';
import { glyph } from '../render/tui/glyphs.js';

/**
 * Pure formatters for the in-REPL info commands (2.5.C S4) — `/cost` and `/workflows`. The output is rendered as
 * a notice in the chat view ({@link ChatStoreController.notice}); keeping the formatting pure means it is
 * unit-tested with no FS, no session, and no ink, and every dynamic field (a workflow slug) is sanitized at the
 * boundary so a crafted catalog entry can never forge a notice row or inject an escape.
 */

/**
 * One line of the `/cost` report in parts: the words the host writes before and after, and the model id between them, which is text a
 * provider or a shared database holds and so is never written here but by the surface that draws it ({@link costNotice} sanitises it for the
 * transcript, the `/cost` popup scrubs it with the full floor of a surface that has a chord step). A line with no model has none.
 */
export interface CostLine {
  readonly head: string;
  readonly model?: string;
  readonly tail: string;
}

/** The `/cost` report as structured lines: what {@link costNotice} joins into a notice and the popup draws as a report (one source of wording). */
export interface CostParts {
  /** `Session cost: ...`: the one total line. */
  readonly total: string;
  /** What qualifies the total: the release note, the durability warning, the models seen only by usage. */
  readonly notes: readonly CostLine[];
  /** One line per model row of the breakdown. */
  readonly rows: readonly CostLine[];
}

/** A {@link CostLine} as one line of text, its model (when it has one) passed through `mapModel`. */
export function costLineText(line: CostLine, mapModel: (model: string) => string): string {
  return `${line.head}${line.model === undefined ? '' : mapModel(line.model)}${line.tail}`;
}

/**
 * The structure of the `/cost` notice: its total, its notes and its rows, every word in place and every model id raw. {@link costNotice} is
 * these parts joined; the `/cost` popup draws the same parts, so the two cannot name different facts or word one differently.
 */
export function costParts(
  totalCostMicrocents: number,
  rows: readonly SessionCostRow[],
  opts: {
    readonly durabilityBroken?: boolean;
    readonly released?: number;
    readonly coverage?: UsageCoverage;
    readonly models?: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
  } = {},
): CostParts {
  const total = `Session cost: ${formatReportedCost(
    totalCostMicrocents,
    opts.coverage,
    rows.reduce((sum, row) => sum + row.unpricedCalls, 0),
  )}`;
  const modelCoverage = new Map(opts.models?.map((entry) => [entry.model, entry.coverage]));
  // ADR-0074 §1 requires the surface that RENDERS the committed amount to also expose clearing it, and to say
  // when the record behind it is no longer durable (#W15-3). Both were reachable in code and invisible here.
  const notes: CostLine[] = [];
  if (opts.released !== undefined && opts.released > 0) {
    notes.push({
      head: `Released ~${formatUsdExact(opts.released)} of estimated-but-unconfirmed spend back to the cap.`,
      tail: '',
    });
  }
  if (opts.durabilityBroken === true) {
    // Says only what is true: the cap IS still being enforced in this process; what is broken is the record's
    // survival. A user who reads "the cap is off" would behave very differently from one who reads this.
    notes.push({
      head:
        'warning: a conservative commitment could not be written durably — the cap still holds in this ' +
        'session, but a resume would not see it. Use /cost --release to clear it deliberately.',
      tail: '',
    });
  }
  // A usage-only model has no realized-money row. Keep it visible without inventing a completed call.
  for (const entry of opts.models ?? []) {
    if (!rows.some((row) => !row.isLegacy && row.model === entry.model))
      notes.push({
        head: '  ',
        model: entry.model,
        tail: ` — ${formatReportedCost(0, entry.coverage)}`,
      });
  }
  const lines = rows.map((r): CostLine => {
    const share =
      totalCostMicrocents > 0 ? Math.round((r.costMicrocents / totalCostMicrocents) * 100) : 0;
    const money = `  ${formatReportedCost(r.costMicrocents, modelCoverage.get(r.model) ?? opts.coverage, r.unpricedCalls)}  ${String(share).padStart(3)}%`;

    // The legacy row is handled PER ROW, not per panel. A resumed pre-2.6.C session that spends AGAIN carries BOTH the
    // legacy aggregate and real model rows — the likeliest way a user meets this table — and rendering the aggregate
    // through the normal path would print `$0.0420  40%  before per-model attribution  (0 calls, 0 tok)`: real money,
    // zero calls, zero tokens, with the "unavailable" disclosure gone from the panel entirely. Its counts are
    // structurally 0 (the per-attempt increments it would have needed were never kept), so it must never claim them.
    //
    // The branch is on the row's `isLegacy` FLAG, never on its model string. A string compare would misrender a user's
    // custom model that happens to be named LEGACY_COST_SENTINEL as "breakdown unavailable" and hide its real spend.
    if (r.isLegacy) {
      return {
        head: `${money}  before per-model attribution — breakdown unavailable (this spend predates it)`,
        tail: '',
      };
    }

    // ADR-0074 §1/§4 — the conservative estimate, rendered as *estimated, possibly billed* and NEVER added into
    // the money figure. It is what the cap is actually holding against this model, so a user refused a turn on a
    // `$0.0000` session can see why. Same wording as `relavium logs`, so the two surfaces cannot drift.
    const held =
      r.conservativeMicrocents > 0
        ? `  — ~${formatUsdExact(r.conservativeMicrocents)} estimated, possibly billed`
        : '';
    // A commitment made BEFORE any realized egress on this model leaves a row with no calls and no tokens. Saying
    // "(0 calls, 0 tok)" would assert the model was used zero times for zero money, while an estimate
    // against it is holding the cap — the opposite of what the panel is for.
    if (r.callCount === 0 && r.conservativeMicrocents > 0) {
      return { head: `${money}  `, model: r.model, tail: `  (no completed call)${held}` };
    }
    const calls = `${r.callCount} ${r.callCount === 1 ? 'call' : 'calls'}`;
    const tokens = `${r.inputTokens + r.outputTokens} tok`;
    const unpriced =
      r.unpricedCalls > 0 ? `  — price unknown for ${r.unpricedCalls} of ${calls}` : '';
    return {
      head: `${money}  `,
      model: r.model,
      tail: `  (${calls}, ${tokens})${unpriced}${held}`,
    };
  });
  return { total, notes, rows: lines };
}

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
 *   • a row that predates per-model attribution says so, per row — a resumed legacy session that spends again has
 *     BOTH its sentinel and real model rows, and the sentinel must never claim the calls and tokens it does not have.
 *
 * The total is `agent_sessions.total_cost_microcents`, the authoritative realized sum used by the cap alongside
 * conservative holds (ADR-0028/0074). An incomplete usage receipt adds no guessed realized charge; ADR-0104's
 * durable coverage qualifies that known sum, and usage-only models remain visible. It is not a provider invoice.
 *
 * The wording is {@link costParts}'; this is the plain text of it, a model id sanitised for the transcript.
 */
export function costNotice(
  totalCostMicrocents: number,
  rows: readonly SessionCostRow[],
  opts: {
    readonly durabilityBroken?: boolean;
    readonly released?: number;
    readonly coverage?: UsageCoverage;
    readonly models?: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
  } = {},
): string {
  const parts = costParts(totalCostMicrocents, rows, opts);
  return [
    parts.total,
    ...[...parts.notes, ...parts.rows].map((line) => costLineText(line, sanitizeInline)),
  ].join('\n');
}

/** One entry of a catalog section: the slug is text a project's files hold (a file name), never written here but by the surface that draws it. */
export interface CatalogRowParts {
  readonly slug: string;
  readonly valid: boolean;
}

/** One kind of the catalog: its heading (`Workflows (2):` or `Agents: none`) and its entries. */
export interface CatalogSectionParts {
  readonly heading: string;
  readonly entries: readonly CatalogRowParts[];
}

/** The structure of the `/workflows` notice: nothing found at all, or the two sections. */
export type CatalogParts =
  | { readonly kind: 'empty' }
  | { readonly kind: 'sections'; readonly sections: readonly CatalogSectionParts[] };

/** What `/workflows` says when there is no `.relavium/` directory from the working directory up: path-free, like the empty-project line below. */
export const NO_PROJECT_NOTICE = 'No .relavium/ project found from the current directory.';

/** The words a project that EXISTS but holds nothing is told: distinct from the caller's "No .relavium/ project found" message, path-free like it. */
export const CATALOG_EMPTY_NOTICE = 'No workflows or agents found in this project.';

/** One `kind` section: a count header + one entry per slug (invalid entries flagged, never dropped). */
function catalogSectionParts(
  heading: string,
  entries: readonly CatalogEntry[],
): CatalogSectionParts {
  return {
    heading: entries.length === 0 ? `${heading}: none` : `${heading} (${entries.length}):`,
    entries: entries.map((entry) => ({ slug: entry.slug, valid: entry.valid })),
  };
}

/** The structure of the `/workflows` notice: what {@link catalogNotice} joins and the popup draws. */
export function catalogParts(
  workflows: readonly CatalogEntry[],
  agents: readonly CatalogEntry[],
): CatalogParts {
  if (workflows.length === 0 && agents.length === 0) return { kind: 'empty' };
  return {
    kind: 'sections',
    sections: [catalogSectionParts('Workflows', workflows), catalogSectionParts('Agents', agents)],
  };
}

/** The `/workflows` notice — the discovered workflow + agent catalogs (each slug sanitized), grouped by kind. A
 *  project that EXISTS but is empty gets one clear line — distinct from the caller's "No .relavium/ project found"
 *  message, so a user can tell an empty project apart from no project at all (path-free, like that message). */
export function catalogNotice(
  workflows: readonly CatalogEntry[],
  agents: readonly CatalogEntry[],
): string {
  const parts = catalogParts(workflows, agents);
  if (parts.kind === 'empty') return CATALOG_EMPTY_NOTICE;
  return parts.sections
    .map((section) =>
      [
        section.heading,
        ...section.entries.map(
          (entry) => `  ${sanitizeInline(entry.slug)}${entry.valid ? '' : ' (invalid)'}`,
        ),
      ].join('\n'),
    )
    .join('\n');
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
        `context tokens (summary usage: ${groupInt(result.summaryTokens.input)} in / ${groupInt(result.summaryTokens.output)} out${result.summaryUsageCoverage === undefined || !isUsageCoverageComplete(result.summaryUsageCoverage) ? '; known observations, usage incomplete' : ''}).\n` +
        `Summary:\n${preview}`
      );
    }
    case 'nothing_to_compact':
      return 'Nothing to compact — the conversation is already short.';
    case 'budget_refused':
      return `Compaction budget refused: ${sanitizeInline(result.message)}. The conversation is unchanged.`;
    case 'failed':
      return `Compaction failed: ${sanitizeInline(result.message)}. Try /trim for a deterministic bound.`;
    case 'cancelled':
      return 'Compaction cancelled — the conversation is unchanged.';
    case 'policy_refused':
      return `Compaction refused: ${sanitizeInline(result.message)}`;
  }
}

/** The `/trim` result notice (ADR-0062) — a deterministic drop, no LLM call. */
export function trimNotice(result: TrimResult): string {
  switch (result.kind) {
    case 'trimmed':
      return `✂ Trimmed ${result.droppedMessageCount} older message(s) — keeping the last ${result.keptMessageCount}.`;
    case 'nothing_to_trim':
      return `Nothing to trim — ${result.messageCount} message(s), already within the bound.`;
    case 'policy_refused':
      return `Trim refused: ${sanitizeInline(result.message)}`;
  }
}

/** Where a `/clear` notice is shown: the Home's hosted chat (it has `/resume`), or a stand-alone `relavium chat` (it has no Home). */
export type ClearedNoticeSurface = Extract<Surface, 'home' | 'standalone-chat'>;

/**
 * The `/clear` notice (ADR-0062 §7) — the current conversation has been ended (still persisted + resumable) and a
 * fresh session started.
 *
 * The notice names no shell command and no session id (MVP-11 OD-20, ADR-0145 §7.4): it is shown inside the TUI, and a command
 * there must exist on the surface that shows it. `/resume` lives on the Home, so the Home's hosted chat names it directly, and a
 * stand-alone chat (which has no Home and no `/resume`) names the Home in words and says `relavium` alone. The shell line that
 * names the saved session's id is printed when the chat has closed (`resumeHint`), never in the transcript.
 *
 * `surface` defaults to the Home because the Home's controller calls this with no argument; the stand-alone chat passes its own.
 * The notice takes no session id: it names none (above), and a parameter that was never read invited the one thing it must not do.
 */
export function clearedNotice(surface: ClearedNoticeSurface = 'home'): string {
  return surface === 'home'
    ? '✨ Started a fresh conversation. The previous one is saved; /resume continues it.'
    : '✨ Started a fresh conversation. The previous one is saved; to continue it, start Relavium without arguments and use /resume on the Home.';
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
 * What it must NOT lose: the DISCLOSURE that a host-side reseat carries the transcript **text-only**. ADR-0059 binds
 * that clause (its Decision and Consequences both rest on it); dropping it would need a superseding ADR, not a
 * wording change. Position and phrasing were never bound — only the disclosure.
 *
 * The phrasing IS load-bearing in one direction, though, and the original got it wrong (2026-07-12 amendment to
 * ADR-0059). "…not prior tool calls **or file contents**" understated what the new model can see: a file attached
 * with `@` is framed into the USER MESSAGE TEXT (chat.ts — `persister.beginUserTurn(line)` gets the full framed line,
 * not the compact display form), so it is part of the durable transcript and DOES cross the reseat. Only a file a
 * TOOL read is lost, because that arrives as a `tool_result` and the engine never carries tool pairs across a turn
 * boundary at all. A user reading the old wording would have believed an `@`-attached secret was invisible to the new
 * model when it is not — an understatement about data exposure, which is the dangerous direction to be wrong in.
 *
 * **ADR-0128 (2026-11-15) refines the clause, in the same direction.** The new model now also sees bounded,
 * content-free *receipts* — a tool's name and recorded outcome, never its arguments or result — so "text transcript
 * only" would be false the other way round. The wording therefore says exactly what is and is not carried: tool
 * arguments and results (including a file a tool read) are not; content-free records of tool names and outcomes are.
 *
 * **ADR-0133 (2026-11-16) refines it once more, in the same direction.** The question tool's record also carries the
 * question and the person's answer, so a reseat hands that text to the NEW model — possibly another provider. Saying
 * only "names and outcomes" would understate what leaves, the dangerous direction to be wrong in; the wording names it.
 *
 * Both ids are `model_catalog` ids (curated), but `sanitizeInline`-guarded defensively: a live-catalog id is
 * provider-sourced and `history.db` is shared across surfaces, so a crafted value must not smuggle a terminal escape
 * into the transcript.
 */
export function modelSwitchNotice(oldModel: string, newModel: string): string {
  return (
    `${glyph('modelSwitch')} model changed ${sanitizeInline(oldModel)} → ${sanitizeInline(newModel)} — the new model sees the text ` +
    `transcript plus content-free records of earlier tool calls (tool name and outcome), and for the question tool ` +
    `what you were asked and how you answered. Prior tool arguments and results (including files a tool read) are ` +
    `not carried; text you sent — @-attached file contents included — is.`
  );
}

/** Fixed pre-egress disclosure; never a model id, guessed window or request body. */
export const COMPACTION_UNKNOWN_WINDOW_NOTICE =
  'The model context window is unknown. Manual compaction is bounded best effort; request fit cannot be guaranteed.';
