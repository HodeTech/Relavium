/**
 * The one glyph table of the CLI ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5 and §9; the cells are
 * [MVP-11 §4.10](../../../../../docs/roadmap/phases/mvp-11.md#410-the-visual-language)): every status and marker glyph a surface draws, its plain
 * ASCII form, and, for a status, the word that always stands beside it. Every status table, selection marker, scroll marker and tool marker reads
 * it, and `glyph-table-only.test.ts` holds the rest of the application's non-test source to a reasoned allow-list of the symbol characters it
 * may still write itself (key labels, box-drawing gutters, the markdown, banner and scrollback renderers, secret masks, and seven lead-in glyphs
 * that have no plain form yet).
 *
 * - **A status carries a word.** A glyph is never the only carrier of a state ({@link wordOf}); the shapes (rules, rail, selection, markers)
 *   carry none. A surface that has a more exact word (`needs attention`, `already decided`) keeps it and takes only the glyph.
 * - **Two forms, one rule.** The Unicode glyph is drawn by default; the ASCII form is drawn exactly when colour is off (`NO_COLOR`, `--no-color`,
 *   `FORCE_COLOR=0`), the same trigger that gives the banner its ASCII box (ADR-0068). A view decides with its own `color` prop and either calls
 *   {@link glyphOf} itself or, for a pure model that builds its rows, runs the model inside {@link withGlyphForm}, so the layout is measured on
 *   the form that is drawn. A non-UTF-8 locale is NOT detected anywhere today and this module does not detect one: the switch for that belongs to
 *   Phase 2.6.L (ADR-0145 §5). The mapping is by role, never by text: a string a model, a user, a project or a provider wrote is never rewritten.
 * - **ASCII forms** are at most three columns, distinct from each other (the declared {@link SHARED_GLYPH_ROLES} excepted) and never a key
 *   label: the legend writes letters and chords in brackets (`[v]`, `[Ctrl+Y]`), so no form here starts with one.
 * - **Host glyphs.** The glyphs the host draws as a status or marker must not be reproduced by text a model wrote where it is drawn next to the
 *   host's own. {@link blankHostGlyphs} is the CLI's set: the core's refusal set, the box-drawing block, the retired glyphs and every role of this
 *   table that does not say `hostBlanked: false`. Three roles say it, the shapes that are also ordinary text: `•` (the bullet of a list a person
 *   or an author writes), `▲` and `▼` (a triangle in a path, a name, a rating). Blanking them rewrote an author's bullet list into spaces and made
 *   the MCP consent card refuse to start a program whose directory held one. Every other glyph keeps the guard: `↻`, `◇` and `★` lead a history
 *   or active-run row from which a person reads a status, and `⇄`, `›`, `▸` lead a transcript row, so a forged one beside the host's own would
 *   mislead; a path that holds such a glyph is refused by the consent card (the fail-closed side). This refines ADR-0145 §5, which said "every
 *   glyph of the table". {@link blankMarkerGlyphs} is the narrower set a transcript guard blanks in model text; `host-glyphs.test.ts` pins the
 *   relation by behaviour.
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), so the later extraction to a shared package is mechanical.
 */

export type GlyphKind = 'status' | 'shape';

/** The semantic colour names a view maps to its own palette (and omits when colour is off): the one list of them, so no surface invents another. */
export type GlyphTone = 'green' | 'red' | 'yellow' | 'cyan' | 'gray' | 'magenta';

export interface GlyphEntry {
  /** What is drawn by default. One terminal column wide (a test pins it with the renderer's own width function). */
  readonly glyph: string;
  /** The plain form: printable ASCII, at most three columns, distinct from every other role's unless the role is a declared sharer. */
  readonly ascii: string;
  readonly kind: GlyphKind;
  /** A status only: the word that stands beside the glyph wherever the surface has no more exact one. */
  readonly word?: string;
  /** A status only: the colour the glyph and its word take by default (a surface with a graver or lighter state overrides it). */
  readonly tone?: GlyphTone;
  /** A marker a transcript guard blanks in model text (`›`, `▸`, `⇄`): the glyphs a reply must not be able to draw where a person's turn, a tool call or a model switch is drawn. */
  readonly guarded?: true;
  /**
   * `false` for a glyph that is also ordinary text (a bullet, a triangle), so that text an author, a path or a project wrote is NOT blanked of it
   * (see the module header). Absent means blanked: a glyph that joins the table is guarded until someone decides, in a line of the table, that it
   * is not a forgeable marker.
   */
  readonly hostBlanked?: false;
}

/**
 * The roles, in the order of ADR-0145 §5. Each ASCII form carries its reason.
 */
const ENTRIES = {
  // ── statuses: a glyph, a plain form, and the word that stands beside it ──────────────────────────────────────────────────────────────
  /** `ok` reads as done in any font and is the only two-letter form that needs no explanation. */
  completed: { glyph: '✓', ascii: 'ok', kind: 'status', word: 'completed', tone: 'green' },
  /** A lone `x` is the cross itself. */
  failed: { glyph: '✗', ascii: 'x', kind: 'status', word: 'failed', tone: 'red' },
  /** Two bars are the pause symbol (`‖` retires `⏸`: ADR-0145 §5). */
  paused: { glyph: '‖', ascii: '||', kind: 'status', word: 'paused', tone: 'yellow' },
  /** A slash is the stroke of `⊘`; a run that was stopped on purpose, a call that was refused and a step that never ran share it. */
  cancelled: { glyph: '⊘', ascii: '/', kind: 'status', word: 'cancelled', tone: 'gray' },
  /** Shares `cancelled`'s glyph: the two read apart by their words and are never the same row. */
  skipped: { glyph: '⊘', ascii: '/', kind: 'status', word: 'skipped', tone: 'gray' },
  /** A tilde is motion in progress; the half-filled circle is the same idea. */
  running: { glyph: '◐', ascii: '~', kind: 'status', word: 'running', tone: 'cyan' },
  /** Two dots: about to begin (`◌`, a dotted circle). */
  starting: { glyph: '◌', ascii: '..', kind: 'status', word: 'starting', tone: 'cyan' },
  /** An empty circle is a letter `o`. */
  pending: { glyph: '○', ascii: 'o', kind: 'status', word: 'pending', tone: 'gray' },
  /** Shares `pending`'s glyph: nothing is going on any more, and the surface's own sentence says what ended. */
  ended: { glyph: '○', ascii: 'o', kind: 'status', word: 'ended', tone: 'gray' },
  /** The `@` of "you are here": the step a rail stands on, between the finished and the pending ones. */
  currentStep: { glyph: '◉', ascii: '@', kind: 'status', word: 'current', tone: 'cyan' },
  /** A letter, because the arrow `↻` has no one-column ASCII picture; the word beside it does the work. */
  retrying: { glyph: '↻', ascii: 'r', kind: 'status', word: 'retrying', tone: 'yellow' },
  /** An empty diamond. */
  held: { glyph: '◇', ascii: '<>', kind: 'status', word: 'held', tone: 'yellow' },
  /** The exclamation mark of the warning sign. */
  warning: { glyph: '⚠', ascii: '!', kind: 'status', word: 'warning', tone: 'yellow' },
  /** A solid block for the solid square. */
  stopping: { glyph: '■', ascii: '#', kind: 'status', word: 'stopping', tone: 'yellow' },
  /** An answered question: the filled dot of the question card's tab strip, a plus for "added". */
  answered: { glyph: '●', ascii: '+', kind: 'status', word: 'answered', tone: 'green' },
  /** A pinned row (`★`): the letter, because the star `*` is a bullet's. */
  pinned: { glyph: '★', ascii: 'P', kind: 'status', word: 'pinned', tone: 'yellow' },
  // ── shapes: markers, rules and the rail; no word ─────────────────────────────────────────────────────────────────────────────────────
  /** The rail of a popup's steps: a dashed line is a run of dots. */
  railLine: { glyph: '╌', ascii: '.', kind: 'shape' },
  /** The heavy rule of a sheet. */
  heavyRule: { glyph: '━', ascii: '=', kind: 'shape' },
  /** The thin rule of a card, a frame and a sheet's title. */
  thinRule: { glyph: '─', ascii: '-', kind: 'shape' },
  /** The one selection marker (the selected row is also drawn inverse, because `>` alone could not tell it from the prompt). */
  selection: { glyph: '›', ascii: '>', kind: 'shape', guarded: true },
  /** Your turn: the same glyph as the prompt; bold, where the selection is inverse, and the two never share a surface row. */
  yourTurn: { glyph: '›', ascii: '>', kind: 'shape', guarded: true },
  /** A tool call: an arrow with a stem, as a call goes out. */
  toolCall: { glyph: '▸', ascii: '->', kind: 'shape', guarded: true },
  /** More rows above the window. */
  moreAbove: { glyph: '▲', ascii: '^', kind: 'shape', hostBlanked: false },
  /** More rows below the window. */
  moreBelow: { glyph: '▼', ascii: 'v', kind: 'shape', hostBlanked: false },
  /** A dot of a choice: the filled radio of the question card, `(•)`. */
  bullet: { glyph: '•', ascii: '*', kind: 'shape', hostBlanked: false },
  /** The model-switch marker, two arrows against each other. */
  modelSwitch: { glyph: '⇄', ascii: '<->', kind: 'shape', guarded: true },
  /** The text caret of a field the host draws. */
  caret: { glyph: '█', ascii: '_', kind: 'shape' },
  /** The bar that heads the active step of the run view. */
  activeBar: { glyph: '▌', ascii: '|', kind: 'shape' },
  /** The lead of a produced media deliverable's line. */
  media: { glyph: '◆', ascii: '&', kind: 'shape' },
  /**
   * The pencil: the lead of the question card's own-answer row (the core's own `ASK_USER_OWN_ANSWER_GLYPH`, which its refusal rejects in model
   * text) and of a proposed patch's line. The plain form is the letter `e`, for edit. It is a role so that the host-glyph set and the table
   * agree about every glyph the host draws; the two surfaces that write it still write it themselves until the plain form is wired (Phase 2.6.L).
   */
  pencil: { glyph: '✎', ascii: 'e', kind: 'shape' },
} as const satisfies Record<string, GlyphEntry>;

export type GlyphRole = keyof typeof ENTRIES;

/** The roles that are a status, and so carry a word. */
export type StatusGlyphRole = {
  readonly [Role in GlyphRole]: (typeof ENTRIES)[Role]['kind'] extends 'status' ? Role : never;
}[GlyphRole];

/** The table, for a test or a reader that lists it. A surface reads {@link glyphOf}, {@link glyph} and {@link wordOf}. */
export const GLYPHS: Readonly<Record<GlyphRole, GlyphEntry>> = ENTRIES;

function isGlyphRole(key: string): key is GlyphRole {
  return Object.hasOwn(ENTRIES, key);
}

/** The roles of the table, in its order. */
export const GLYPH_ROLES: readonly GlyphRole[] = Object.keys(ENTRIES).filter(isGlyphRole);

/**
 * The groups of roles that share ONE glyph and ONE plain form on purpose. A group needs a reason: the roles are told apart by their words or by
 * the surface they are drawn on, never by the glyph. The table test fails for two roles that share without being declared here.
 */
export const SHARED_GLYPH_ROLES: readonly (readonly GlyphRole[])[] = [
  // the selection is `›` with inverse, your turn `›` with bold; the two never share a row (ADR-0145 §5)
  ['selection', 'yourTurn'],
  // a step that never ran and a run that was stopped read apart by their words
  ['cancelled', 'skipped'],
  // a run that ended and a step that has not begun are both an empty circle with a word beside it
  ['pending', 'ended'],
];

/** Is `role` a status, and so a role whose {@link wordOf} is defined. */
export function isStatusRole(role: GlyphRole): role is StatusGlyphRole {
  return GLYPHS[role].kind === 'status';
}

/**
 * The glyph of `role` in the form asked for: the Unicode glyph, or, when `ascii` is true, the plain form. Pure. Pass `!color`, the one trigger
 * of the plain forms (a non-UTF-8 locale is not detected: Phase 2.6.L).
 */
export function glyphOf(role: GlyphRole, ascii: boolean): string {
  const entry = GLYPHS[role];
  return ascii ? entry.ascii : entry.glyph;
}

/** The word that stands beside a status glyph. */
export function wordOf(role: StatusGlyphRole): string {
  return ENTRIES[role].word;
}

/** The colour a status takes by default; a surface with a graver or lighter state of the same glyph (`needs attention` in red) names its own. */
export function toneOf(role: StatusGlyphRole): GlyphTone {
  return ENTRIES[role].tone;
}

// ── the form a pure model builds its rows in ─────────────────────────────────────────────────────────────────────────────────────────────

let activeForm: 'unicode' | 'ascii' = 'unicode';

/**
 * Runs `run`, a synchronous model that builds rows, so that every {@link glyph} call inside it answers in the form asked for. A view that has
 * the `color` prop and calls a pure model wraps the call in it (`withGlyphForm(!color, () => model(...))`), so the model measures, aligns and
 * clips its rows on the glyphs that will be drawn, and a plain form that is wider than its glyph can never push a row past its bound. The form
 * is restored when `run` returns or throws; an asynchronous `run` is refused (it throws), because the form would not be the one in force when
 * its continuation ran.
 */
export function withGlyphForm<T>(ascii: boolean, run: () => T): T {
  const before = activeForm;
  activeForm = ascii ? 'ascii' : 'unicode';
  try {
    const result = run();
    if (isThenable(result)) throw new TypeError('withGlyphForm runs a synchronous function only');
    return result;
  } finally {
    activeForm = before;
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/** The glyph of `role` in the form {@link withGlyphForm} put in force: the Unicode glyph outside one. */
export function glyph(role: GlyphRole): string {
  return glyphOf(role, activeForm === 'ascii');
}

/** Whether the plain forms are in force ({@link withGlyphForm}), for a model that draws a mark of its own besides the table's (a bracket that must not read as a key). */
export function plainFormInForce(): boolean {
  return activeForm === 'ascii';
}

/**
 * A mark and the word that stands beside it, `✓ completed`. A mark that IS the word is written once: the plain form of a check that says `ok`
 * is `ok`, and `ok ok` reads as a stutter while the word is already there. Every other pairing is the mark, a space and the word.
 */
export function markWithWord(mark: string, word: string): string {
  return mark === word ? word : `${mark} ${word}`;
}

/** The glyph and its word, `✓ completed`, in the form in force: for a surface that has no more exact word. */
export function glyphWithWord(role: StatusGlyphRole): string {
  return markWithWord(glyph(role), wordOf(role));
}

/** The columns a status glyph is given in a list so the words after it line up: one for a Unicode glyph, two for a plain form (`ok`, `||`). */
export function statusCellWidth(ascii: boolean): number {
  return ascii ? 2 : 1;
}

/** The glyph of a status padded to its list column in the form asked for, so a list of rows keeps its words aligned. */
export function statusCellOf(role: StatusGlyphRole, ascii: boolean): string {
  return glyphOf(role, ascii).padEnd(statusCellWidth(ascii));
}

/** {@link statusCellOf} in the form {@link withGlyphForm} put in force. */
export function statusCell(role: StatusGlyphRole): string {
  return statusCellOf(role, activeForm === 'ascii');
}

/** Spaces as wide as a status cell: the column of a row that carries no status, so the rows around it keep their words aligned. */
export function blankStatusCell(ascii: boolean): string {
  return ' '.repeat(statusCellWidth(ascii));
}

/** The longest word of any status: the width a column of status words is padded to (`completed`, `cancelled`). */
export const STATUS_WORD_WIDTH: number = Math.max(
  ...GLYPH_ROLES.filter(isStatusRole).map((role) => wordOf(role).length),
);

// ── host glyphs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The glyphs the core's question refusal rejects besides the box-drawing range (`HOST_GLYPH` in `packages/core/src/tools/ask-user.ts`: the
 * cursor, the own-answer glyph, the field's block cursor). The core owns that set and this module does not import it (all three are also roles
 * of the table, so this list is the declared floor, not the source of the set); `host-glyphs.test.ts` calls the core's own refusal and fails
 * when it refuses something the CLI set does not blank.
 */
const CORE_REFUSAL_GLYPHS = ['›', '✎', '█'] as const;

/** The box-drawing block, U+2500 to U+257F: the characters every rule, frame and gutter of the host is drawn from. */
const BOX_DRAWING_CLASS = '\\u2500-\\u257F';

/**
 * Glyphs that left the table but that an earlier build drew, so that a text still carrying one is blanked as it was (a set only ever gains):
 * the pause sign that `‖` replaced, the run strip's play sign that `◐` replaced, and the native prompt's cursor that `›` replaced.
 */
const RETIRED_GLYPHS = ['⏸', '▶', '❯'] as const;

/** Every character of the table in its Unicode form, once. */
export const TABLE_GLYPHS: readonly string[] = [
  ...new Set(GLYPH_ROLES.map((role) => ENTRIES[role].glyph)),
];

/**
 * The glyphs of the table that {@link blankHostGlyphs} blanks: those of every role that does not say `hostBlanked: false`. A glyph two roles
 * share is blanked when either of them is (`⊘`, `›`, `○`), so a declared sharing can never un-blank a glyph by one of its roles.
 */
export const HOST_BLANKED_GLYPHS: readonly string[] = [
  ...new Set(
    GLYPH_ROLES.filter((role) => !('hostBlanked' in ENTRIES[role])).map(
      (role) => ENTRIES[role].glyph,
    ),
  ),
];

/** The marker glyphs a transcript guard blanks in model text: `›`, `▸`, `⇄`. */
export const MARKER_GLYPHS: readonly string[] = [
  ...new Set(
    GLYPH_ROLES.filter((role) => 'guarded' in ENTRIES[role]).map((role) => ENTRIES[role].glyph),
  ),
];

function glyphClass(glyphs: readonly string[], extra = ''): RegExp {
  return new RegExp(`[${glyphs.join('')}${extra}]`, 'gu');
}

const HOST_GLYPH_PATTERN = glyphClass(
  [...CORE_REFUSAL_GLYPHS, ...HOST_BLANKED_GLYPHS, ...RETIRED_GLYPHS],
  BOX_DRAWING_CLASS,
);
const MARKER_GLYPH_PATTERN = glyphClass(MARKER_GLYPHS);
/** The plain radio shapes and the selection `>` at the start of a text, before a digit or a space. */
const ASCII_HOST_SHAPE = /\((?:[*xXoO])\)|^>(?=[\d\s])/gu;

/**
 * `text` with every host glyph replaced by a space: the core's refusal set, the box-drawing block, the glyph of every role that is not
 * `hostBlanked: false` ({@link HOST_BLANKED_GLYPHS}) and the retired ones. For text an author wrote that is drawn inside a host card (a gate's
 * message, an MCP consent's subject), where a glyph of the host's own could draw a row the host did not. Blanking is destructive (a `✓` an
 * author wrote goes), which is right behind a card's gutter and wrong in a transcript: use {@link blankMarkerGlyphs} there. The bullet and the
 * two triangles are left alone: they are ordinary text.
 */
export function blankHostGlyphs(text: string): string {
  return text.replace(HOST_GLYPH_PATTERN, ' ');
}

/**
 * What the host draws in its PLAIN form that a model could write too: the radio of a chosen option (`(*)`, and its relatives `(x)` and
 * `(o)`), and the selection marker `>` at the start of a line, followed by a digit or a space (`>1 (*) Delete` imitates the host's own
 * `> 1 ( ) Keep it`). The core's question refusal rejects `(•)`, `( )`, `[x]`, `[ ]` and a list marker such as `> ` at the start, but it
 * does not know the ASCII shapes, and it must not change (ADR-0145 §5: the engine does not change). Each shape is replaced by spaces of the
 * same width, so a layout measured on the text is unchanged; ordinary text, and a `(*)` or `>` anywhere else, is left alone. Apply it to
 * every string a model wrote that a card draws, in the Unicode form too (it costs nothing there and keeps one rule).
 */
export function blankAsciiHostShapes(text: string): string {
  return text.replace(ASCII_HOST_SHAPE, (shape) => ' '.repeat(shape.length));
}

/**
 * `text` with the marker glyphs (`›`, `▸`, `⇄`) replaced by a space. This is what a transcript guard blanks in model text: a reply must not be
 * able to draw a person's turn, a tool call or a model switch, while a `✓`, a `●` or a rule an ordinary answer contains is left alone (blanking
 * those would damage ordinary output). It is not wired into the transcript yet: the margin that makes the speaker marker trustworthy, and the
 * interim guard on the rendered rows, are the chat step's (ADR-0145 §6).
 */
export function blankMarkerGlyphs(text: string): string {
  return text.replace(MARKER_GLYPH_PATTERN, ' ');
}
