import { DEFAULT_CHAT_AGENT_ID } from '../../chat/default-agent.js';
import type {
  HomeAgentRow,
  HomeRunRow,
  HomeSessionRow,
  HomeSnapshot,
  HomeUnreadableRun,
} from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { formatAgeOfIso, formatElapsed, shortId } from '../notation.js';
import { sanitizeInline } from '../sanitize.js';
import { flowLine } from './flow-text.js';
import { expiryLabel } from './home-deadline.js';
import { formatCostShort } from './format.js';
import { glyph, glyphOf } from './glyphs.js';
import { exitKey, keyLabel, legend, waitMark, type LegendExit, type LegendKey } from './legend.js';
import { clipLine } from './sheet-frame.js';
import { displayWidth } from './viewport.js';

/**
 * Pure projection helpers for the 2.5.B Home strip (ADR-0054) — the read-only display of recent sessions /
 * runs / agents + an "attention" section. Like the chat projection, all logic lives here (clock-injected, no
 * ink) so the `HomeView` is a thin render and every label is unit-tested. Every stored string a work-page row draws (a
 * session title, an agent, a workflow, a run id) goes through the Home's full row scrub (`flowLine`) and then through the triangles the page's
 * own overflow marker could be imitated by ({@link workRowText}) before the row is cut to its width (MVP-11 unit 7: see "The work page's
 * rows" below); the closed enums (`status`) are safe by construction.
 * Cost reuses the canonical {@link formatCostShort} (one home for the µ¢→USD math).
 */

// The Home's terminal floor (`home-floor.ts`) and a deadline's words (`home-deadline.ts`) live in leaves, so the run cards can read them without
// importing this module (it reaches the card through `flow-text.ts`); they are found here too.
export { deadlinePassed, expiryLabel } from './home-deadline.js';
export { HOME_MIN_COLS, HOME_MIN_ROWS, homeFitsTerminal, tooSmallMessage } from './home-floor.js';

/** Whether the Home has nothing to show: no session, run or attention row, and no parked run of this project either. */
export function homeIsEmpty(
  snapshot: HomeSnapshot,
  parkedRuns: readonly unknown[] | undefined,
): boolean {
  return snapshot.isEmpty && (parkedRuns === undefined || parkedRuns.length === 0);
}

/**
 * {@link expiryLabel} in its compact form, for the room a cramped line has (page 1's head, MVP-11 unit 7 round 2): `5m left`, `1h left`, and
 * `expired` once the deadline has passed (the one word that stays whole: under no colour nothing else says overdue). The same moment, the
 * same rounding, the same clock; only the words are shorter.
 */
export function compactExpiryLabel(
  expiresAt: string | undefined,
  nowMs: number,
): string | undefined {
  const label = expiryLabel(expiresAt, nowMs);
  if (label === undefined || label === 'expired') return label;
  return `${label.slice('expires in '.length)} left`;
}

/**
 * How long a parked run has waited, as the words of its row (MVP-11 unit 7 round 2: a row with no deadline carried no time, so eight runs
 * were told apart by their ids alone): `waiting 2h`, `waiting 5m`, `waiting 3d`, and `waiting <1m` inside the first minute. `since` is the
 * moment the run's record last changed, which for a run that waits is when it parked (`RunGates.parkedSince`, `home/run-gates.ts`).
 * No words for a time that does not parse or one more than a minute ahead of the clock (a clock behind the log: the row claims nothing).
 * From a year on it is one closed word, `waiting 1y+` (round 2 sitting #2: a hand-edited `updated_at` of 1970 read `waiting 20783d`), so
 * the field is never wider than `waiting 364d`.
 */
export function waitingLabel(since: string | undefined, nowMs: number): string | undefined {
  if (since === undefined) return undefined;
  const age = formatAgeOfIso(since, nowMs);
  if (age === 'just now') return 'waiting <1m';
  const waited = /^(\d+)([mhd]) ago$/u.exec(age);
  if (waited === null) return undefined;
  const [, count = '', unit = ''] = waited;
  return unit === 'd' && Number(count) >= 365 ? 'waiting 1y+' : `waiting ${count}${unit}`;
}

const SEP = '  ·  ';

// ---- The work page's rows (MVP-11 unit 7: the rows simplified) --------------------------------------------------------------------
// One row per item, its fields joined by the legend's own ` · `, cut at its width and never wrapped. Every stored field (a title, an agent,
// a workflow, a run id) passes the Home's full row scrub (`flowLine`: secrets, control, bidirectional, invisible and line-separator
// characters, host glyphs, answer chords, and the legend's separators and key tokens made inert) and then the triangles that pass for the
// page's own `▲`/`▼ N more` marker are blanked ({@link workRowText}) BEFORE it is cut, so the row's own
// separators are the only ones on it and a cut never splits an escape. A run is named by the first eight characters of its id (`shortId`),
// last on its row: the whole id is in its detail. A cut is ALWAYS the one ellipsis glyph `…` (the glyph table's), and a stored `…` is never
// drawn as it is: the scrub's compatibility fold makes it three dots (`rec…` is drawn `rec...`, the rule the status line keeps too), so on one
// screen a `…` is the Home's own cut and `...` is text a title or a name brought, and the two can never be mistaken for each other.

/** The separator between a work-page row's fields. */
const ROW_SEP = ' · ';

/**
 * What a field of a row is, for the order a narrow row gives its fields up in ({@link fitRow}): its `name` (cut at its tail), its `cost`, its
 * `age`, a `detail` (a run's id, a session's agent), or a field it `keep`s whatever the width (the status word, the gate's kind).
 */
export type RowFieldRole = 'name' | 'cost' | 'age' | 'detail' | 'keep';

export interface RowField {
  readonly text: string;
  readonly role: RowFieldRole;
  /** Joined to the field before it by a space, not the separator: `failed 2h ago`. */
  readonly glued?: boolean;
}

/** The most columns a row's name takes, however wide the terminal: a long name never pushes the row's facts off it. */
export const ROW_NAME_COLUMNS = 40;

/** The fewest columns a name keeps once its tail is given up, before the row gives up what comes after the tail in its order. */
export const ROW_NAME_FLOOR = 12;

/** One step of what a narrow row gives up: its name's tail (down to {@link ROW_NAME_FLOOR}), or every field of a role. */
type GiveUp = 'name-tail' | 'cost' | 'age' | 'detail';

/** How a kind of row fits its width: the order it gives its fields up in, and the most columns its name takes however wide the row. */
export interface RowFit {
  readonly order: readonly GiveUp[];
  readonly nameColumns: number;
}

/**
 * How a RUN's row fits (a parked, a failed, a recent run; an agent): the workflow's tail first, then the cost (before the status word, which
 * stays: colour is never the only carrier), then the age (or the deadline), then the id. The id and the status word survive the longest: the
 * id is how two runs of one workflow are told apart, so the workflow is bounded to {@link ROW_NAME_COLUMNS} even on a wide row.
 */
export const RUN_ROW_FIT: RowFit = {
  order: ['name-tail', 'cost', 'age', 'detail'],
  nameColumns: ROW_NAME_COLUMNS,
};

/**
 * How a SESSION's row fits: the cost first, then the age, then the title's tail, then the agent. A session is known by its title, so the title
 * is the last thing cut and is bounded only by the row (two titles that differ at their end must not read the same: `…, part 1`, `…, part 2`).
 */
export const SESSION_ROW_FIT: RowFit = {
  order: ['cost', 'age', 'name-tail', 'detail'],
  nameColumns: Number.POSITIVE_INFINITY,
};

/** What joins `field` to the field before it: a space for a glued one (`failed 2h ago`), else the separator. */
function joinerOf(field: RowField): string {
  return field.glued === true ? ' ' : ROW_SEP;
}

/** The words a field draws: the name as the row has it now for the name field, else its own. */
function wordsOf(field: RowField, name: string | undefined): string {
  return field.role === 'name' ? (name ?? '') : field.text;
}

/** The row with `dropped` left out and its name as `name` (none: no name field). A field with no words leaves no separator behind. */
function joinRow(
  lead: string | undefined,
  fields: readonly RowField[],
  dropped: readonly RowFieldRole[],
  name: string | undefined,
): string {
  let out = '';
  for (const field of fields) {
    const text = dropped.includes(field.role) ? '' : wordsOf(field, name);
    if (text.trim().length === 0) continue;
    out = out === '' ? text : `${out}${joinerOf(field)}${text}`;
  }
  if (lead === undefined || out === '') return lead ?? out;
  return `${lead} ${out}`;
}

/** The row with `dropped` left out when it fits `max` with its name whole or, once the tail may go, cut to no fewer than `floor` columns. */
function fittedWith(
  lead: string | undefined,
  fields: readonly RowField[],
  dropped: readonly RowFieldRole[],
  name: string | undefined,
  floor: number,
  max: number,
): string | undefined {
  const full = joinRow(lead, fields, dropped, name);
  if (displayWidth(full) <= max) return full;
  if (name === undefined) return undefined;
  const room = max - (displayWidth(full) - displayWidth(name));
  return room >= floor ? joinRow(lead, fields, dropped, clipLine(name, room)) : undefined;
}

/**
 * A work-page row in at most `maxColumns` columns: `lead` (a glyph, never cut) and the fields, given up step by step in the order of `fit`
 * ({@link RUN_ROW_FIT}, {@link SESSION_ROW_FIT}), the name first bounded to the fit's columns: until the name's tail is given up the name is
 * whole; after, it is cut (an ellipsis shows the cut) to no fewer than {@link ROW_NAME_FLOOR} columns. Past the last step the name is cut below its floor, then dropped; what is
 * `keep` (the status word, the gate's kind) is never given up, and only the row's own cut at its end, the last resort, can reach it. The fields
 * arrive scrubbed.
 */
export function fitRow(
  lead: string | undefined,
  fields: readonly RowField[],
  maxColumns = Number.POSITIVE_INFINITY,
  fit: RowFit = RUN_ROW_FIT,
): string {
  const max = Number.isNaN(maxColumns)
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(maxColumns));
  const named = fields.find((field) => field.role === 'name')?.text;
  const name =
    named === undefined || named.trim().length === 0 ? undefined : clipLine(named, fit.nameColumns);
  const dropped: RowFieldRole[] = [];
  let floor = Number.POSITIVE_INFINITY;
  for (const step of [undefined, ...fit.order]) {
    if (step === 'name-tail') floor = ROW_NAME_FLOOR;
    else if (step !== undefined) dropped.push(step);
    const row = fittedWith(
      lead,
      fields,
      dropped,
      name,
      Math.min(floor, displayWidth(name ?? '')),
      max,
    );
    if (row !== undefined) return row;
  }
  const bare = joinRow(lead, fields, dropped, name);
  const room = name === undefined ? 0 : max - (displayWidth(bare) - displayWidth(name));
  const kept = room >= 2 && name !== undefined ? clipLine(name, room) : undefined;
  return clipLine(joinRow(lead, fields, dropped, kept), max);
}

/** An inclusive range of code points: a block of Unicode, or the part of it that is named. */
export type CodeRange = readonly [from: number, to: number];

/** A character class (the inside of a regular expression's brackets) of `ranges`, built from the code points so no escape is written in the source. */
export function classOfRanges(ranges: readonly CodeRange[]): string {
  return ranges
    .map(([from, to]) =>
      from === to
        ? String.fromCodePoint(from)
        : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
    )
    .join('');
}

/**
 * The triangles a stored name may not carry onto the work page (MVP-11 unit 7, round 2: F3): every one that draws like the page's own overflow
 * marker, `▲ N more` and `▼ N more`, which stands in the marker column of a row, where a session's or a run's name starts. The shared scrub
 * leaves `▲` and `▼` alone ({@link blankHostGlyphs}: they are ordinary text in a path, a name, a rating) so the work page blanks them in the
 * names it draws, and nowhere else. The ranges, each named:
 *
 * - U+23E9 to U+23EF the media triangles (`⏩ ⏪ ⏫ ⏬ ⏭ ⏮ ⏯`), U+23F4 to U+23F7 the medium triangles (`⏴ ⏵ ⏶ ⏷`);
 * - U+25B2 to U+25C5 the black and white triangles and pointers (`▲ △ ▴ ▵ ▶ ▷ ▸ ▹ ► ▻ ▼ ▽ ▾ ▿ ◀ ◁ ◂ ◃ ◄ ◅`);
 * - U+25E2 to U+25E5 the black corner triangles, U+25EC to U+25EE the triangles with a dot or a black half, U+25F8 to U+25FA and U+25FF the
 *   corner triangles;
 * - U+2B9C to U+2BA0 the equilateral arrowheads and the triangle-headed arrow `⮠` that follows them, U+2BC5 to U+2BC8 the centred medium
 *   triangles (`⯅ ⯆ ⯇ ⯈`);
 * - U+1F53A to U+1F53D the red triangles (`🔺 🔻 🔼 🔽`), U+1F780 to U+1F783 the black isosceles right triangles.
 */
export const MARKER_LOOKALIKE_RANGES: readonly CodeRange[] = [
  [0x23e9, 0x23ef],
  [0x23f4, 0x23f7],
  [0x25b2, 0x25c5],
  [0x25e2, 0x25e5],
  [0x25ec, 0x25ee],
  [0x25f8, 0x25fa],
  [0x25ff, 0x25ff],
  [0x2b9c, 0x2ba0],
  [0x2bc5, 0x2bc8],
  [0x1f53a, 0x1f53d],
  [0x1f780, 0x1f783],
];

const MARKER_LOOKALIKES = new RegExp(`[${classOfRanges(MARKER_LOOKALIKE_RANGES)}]`, 'gu');

/**
 * The plain form of the marker, `^ N more` and `v N more` (the form without colour draws these, never a triangle), at the START of a name: a
 * lone `^` or `v`, a space, a number and the word `more`. A name that only begins with the letter `v` (`v2 migration`, `vet`) is not this shape.
 */
const PLAIN_MARKER_SHAPE = /^(\s*)[\^v](?=\s+\d[\d,]*\s+more(?![\p{L}\p{N}]))/iu;

/**
 * A stored name with every triangle that could pass for the work page's `▲`/`▼ N more` marker replaced by a space ({@link MARKER_LOOKALIKE_RANGES}),
 * and the plain form's `^ N more` or `v N more` at its start blanked the same way: a name that was changed loses the spaces it begins with, so no
 * row of the page begins with a marker the allocator did not draw. A name with none of them comes back exactly as it was.
 */
export function blankMarkerLookalikes(text: string): string {
  const blanked = text.replace(MARKER_LOOKALIKES, ' ').replace(PLAIN_MARKER_SHAPE, '$1 ');
  return blanked === text ? text : blanked.trimStart();
}

/**
 * A stored field as a work-page row draws it: the Home's full row scrub ({@link flowLine}), then {@link blankMarkerLookalikes}. Every stored
 * field of a row (a title, an agent, a workflow, a run id) passes it before the row is cut.
 */
export function workRowText(stored: string): string {
  return blankMarkerLookalikes(flowLine(stored));
}

/** A run's id as its row names it: the first eight characters of the scrubbed id. The work page dims it where a row ends with it. */
export function rowId(runId: string): string {
  return shortId(workRowText(runId));
}

/**
 * A row as a label drew it, split before the `id` it ends with (the id the work page draws dim, last): the row up to the id, and the id. A row
 * that does not end with the id (the id was given up, or the row's own cut reached it) is all lead, with no id: only a whole id is dimmed.
 */
export function splitRowId(
  text: string,
  id: string | undefined,
): { readonly lead: string; readonly id: string | undefined } {
  if (id === undefined || id.length === 0 || !text.endsWith(id))
    return { lead: text, id: undefined };
  return { lead: text.slice(0, text.length - id.length), id };
}

/**
 * The three glyphs that lead an Attention row (a parked run, a failed run, a run that cannot be read), each padded on the right to the width of
 * the widest of the three IN THE FORM IN FORCE, so the names start in one column whichever kind leads (MVP-11 unit 7, round 2): the glyphs
 * are one column each, but without colour `||` is two and `x` and `!` are one.
 */
const ATTENTION_LEADS = ['paused', 'failed', 'warning'] as const;

/** The lead of an Attention row of `kind` ({@link ATTENTION_LEADS}): its glyph in the form in force, padded to the widest of the three. */
export function attentionLead(kind: (typeof ATTENTION_LEADS)[number]): string {
  const widest = Math.max(...ATTENTION_LEADS.map((name) => displayWidth(glyph(name))));
  const lead = glyph(kind);
  return `${lead}${' '.repeat(Math.max(0, widest - displayWidth(lead)))}`;
}

/** A stored name as a row draws it: scrubbed, or none when it is absent. */
function rowName(stored: string | undefined): string | undefined {
  return stored === undefined ? undefined : workRowText(stored);
}

/** The time a run row's age is counted from: a running run from its start, a finished one from its end, a queued one from its creation. */
function runAnchor(row: HomeRunRow): string {
  const anchor = row.status === 'running' ? row.startedAt : (row.completedAt ?? row.startedAt);
  return anchor ?? row.createdAt;
}

/** What {@link formatReportedCost} puts between an amount and the one note a verified-nothing run has (`$0.0002 known; usage unverified`). */
const KNOWN_UNVERIFIED = ' known; usage unverified';

/**
 * A row's cost: the Home's compact cost ({@link formatCostShort}), and for the one qualifier every unverified run carries SHORTER than the
 * report's sentence: `$0.0002 usage unverified` (24 columns) for `$0.0002 known; usage unverified` (31). The qualifier's words stay (a qualified
 * cost never reads as clean, ADR-0145; `free` is only ever a verified, fully priced zero): only the connective `known;` goes, and the full sentence
 * is in the run's own views. Every other qualified cost (pending usage, unknown calls, unknown prices) keeps its words as they are.
 */
function rowCost(
  microcents: number,
  coverage: HomeRunRow['usageCoverage'],
  unpricedCalls: number | undefined,
): string {
  const cost = formatCostShort(microcents, coverage, unpricedCalls);
  return cost.endsWith(KNOWN_UNVERIFIED)
    ? `${cost.slice(0, -KNOWN_UNVERIFIED.length)} usage unverified`
    : cost;
}

function costOf(row: HomeRunRow | HomeSessionRow): string {
  return rowCost(row.totalCostMicrocents, row.usageCoverage, row.unpricedCalls);
}

/**
 * The fields that name a session: its title, and the agent that ran it unless that is the built-in chat agent (MVP-11 unit 7, round 2: every
 * row of a Home that mostly chats said `relavium-chat`, which tells the rows nothing). An UNTITLED session shows its agent ONCE, as its name,
 * whichever agent it is: it is all the row has to be known by. The built-in agent is told by its id ({@link DEFAULT_CHAT_AGENT_ID}); a file
 * of the repository that is named the same is shown as the built-in agent here, and is told apart in the chat's own views.
 */
function sessionHead(row: HomeSessionRow): readonly RowField[] {
  const agent = workRowText(row.agentSlug);
  const title = rowName(row.title);
  if (title === undefined || title.trim().length === 0) return [{ text: agent, role: 'name' }];
  if (row.agentSlug === DEFAULT_CHAT_AGENT_ID) return [{ text: title, role: 'name' }];
  return [
    { text: title, role: 'name' },
    { text: agent, role: 'detail' },
  ];
}

/**
 * A session row: `title · agent · age · cost`, one row (every session the Home lists is this directory's, so no directory line; the built-in
 * chat agent is not named, {@link sessionHead}). A narrow row gives up the cost, the age, the title's tail, then the agent
 * ({@link SESSION_ROW_FIT}).
 */
export function sessionLabel(row: HomeSessionRow, nowMs: number, maxColumns?: number): string {
  const head = sessionHead(row);
  return fitRow(
    undefined,
    [
      ...head,
      { text: formatAgeOfIso(row.updatedAt, nowMs), role: 'age' },
      { text: costOf(row), role: 'cost' },
    ],
    maxColumns,
    SESSION_ROW_FIT,
  );
}

/**
 * A run of the Runs section: `workflow · status · age · cost · id` (the age from the status' own moment; the cost stays, it is where a person
 * sees spend; the status word stays, colour is never the only carrier). A run whose workflow cannot be named has no name field: its id names it.
 */
export function runLabel(row: HomeRunRow, nowMs: number, maxColumns?: number): string {
  return fitRow(
    undefined,
    [
      { text: rowName(row.workflowSlug) ?? '', role: 'name' },
      { text: row.status, role: 'keep' },
      { text: formatAgeOfIso(runAnchor(row), nowMs), role: 'age' },
      { text: costOf(row), role: 'cost' },
      { text: rowId(row.runId), role: 'detail' },
    ],
    maxColumns,
  );
}

/** A failed run under Attention: `✗ workflow · failed 2h ago · cost · id` (the glyph from the table, in the form in force, {@link attentionLead}). */
export function failedRunLabel(row: HomeRunRow, nowMs: number, maxColumns?: number): string {
  return fitRow(
    attentionLead('failed'),
    [
      { text: rowName(row.workflowSlug) ?? '', role: 'name' },
      { text: 'failed', role: 'keep' },
      { text: formatAgeOfIso(runAnchor(row), nowMs), role: 'age', glued: true },
      { text: costOf(row), role: 'cost' },
      { text: rowId(row.runId), role: 'detail' },
    ],
    maxColumns,
  );
}

/**
 * A run whose event log could not be read (#W15-15): `⚠ workflow · cannot be read · id`, its workflow only when the summary read could name
 * it, and the run's first eight characters LAST, as on every other row (round 2: it led this row alone). `Enter` on it says why (a read-only
 * card); the row says only that it cannot be read. A narrow row gives up the workflow's tail, then the id; `cannot be read` never.
 */
export function unreadableRunLabel(run: HomeUnreadableRun, maxColumns?: number): string {
  return fitRow(
    attentionLead('warning'),
    [
      { text: rowName(run.workflowSlug) ?? '', role: 'name' },
      { text: 'cannot be read', role: 'keep' },
      { text: rowId(run.runId), role: 'detail' },
    ],
    maxColumns,
  );
}

/** A recently-used agent: `agent · when last used`. */
export function agentLabel(row: HomeAgentRow, nowMs: number, maxColumns?: number): string {
  return fitRow(
    undefined,
    [
      { text: workRowText(row.agentSlug), role: 'name' },
      { text: formatAgeOfIso(row.lastUsedAt, nowMs), role: 'age' },
    ],
    maxColumns,
  );
}

/** Whether the run host has a leg that is preparing, executing or cancelling: the one meaning of "a run is active" for the Home. */
export function hostedRunIsLive(snapshot: RunHostSnapshot | undefined): boolean {
  return snapshot !== undefined && (snapshot.active !== undefined || snapshot.launching);
}

/**
 * The run row of the Home's strip ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): the
 * active run's short id and its state, in one line, or `undefined` (no row at all) when no run is active. The state is a word, never a
 * colour alone: `starting` until the engine has named the run, `running`, and `cancelling` once the stop was requested. The run host's
 * snapshot carries no workflow name, so the run is named as the Home's other words name it, by the first eight characters of its id (MVP-11
 * unit 7, round 1: OB74; the whole id was cut by the row), never the whole id. The id is stored text: the Home's full row scrub
 * (`flowLine`) runs over it BEFORE it is cut, so no control, bidirectional, invisible or separator character and no key reaches the row.
 * `last` is how an earlier leg ended; it is a later card's to show, not this row's.
 */
export function hostedRunLabel(snapshot: RunHostSnapshot | undefined): string | undefined {
  if (snapshot === undefined || !hostedRunIsLive(snapshot)) return undefined;
  const active = snapshot.active;
  if (active?.runId === undefined) return `${glyph('starting')} run${SEP}starting`;
  // Once the engine has named the run, `Enter` at the empty prompt brings its view back: the row says so, because nothing else does. The glyph
  // is the run view's own for the same state (`◐ running`, `■ cancelling`), and the word stands beside it.
  const cancelling = active.cancelling;
  return `${glyph(cancelling ? 'stopping' : 'running')} ${shortId(flowLine(active.runId))}${SEP}${cancelling ? 'cancelling' : 'running'}${SEP}${HOSTED_RUN_ENTER_CUE}`;
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
 * The rows the exit guard draws above its lines: the sheet's heavy rule (ADR-0147 §1). Every host that counts the card's rows adds it, so the
 * frame's arithmetic and the drawn card cannot disagree.
 */
export const EXIT_GUARD_RULE_ROWS = 1;

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
  /** The card's lockout holds `Ctrl+Y` now (the controller's `exitGuardLock`, a display value): it reads `(wait)` (ADR-0145 §3). */
  locked = false,
): readonly string[] {
  const wait = waitMark(locked);
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
      legend([{ keys: 'Ctrl+Y', verb: 'leave the Home', ...wait }], EXIT_GUARD_STAY),
    ];
  if (active?.cancelling === true)
    return [
      `${glyph('warning')} The run is stopping${named}.`,
      legend(
        [
          {
            keys: 'Ctrl+Y',
            verb: `leave once it stops (about ${formatElapsed(boundSeconds * 1000)})`,
            ...wait,
          },
        ],
        EXIT_GUARD_STAY,
      ),
    ];
  return [
    `${glyph('warning')} A workflow run is executing${named}.`,
    'Leaving stops it, and a stopped run cannot be resumed.',
    legend([{ keys: 'Ctrl+Y', verb: 'stop the run and leave', ...wait }], EXIT_GUARD_STAY),
  ];
}
