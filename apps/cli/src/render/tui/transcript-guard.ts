import type { MarkdownDisplayLine, MarkdownSpan } from '../markdown/types.js';
import { blankMarkerGlyphs, GLYPHS, glyphOf, speakerMarker } from './glyphs.js';
import type { TranscriptEntry } from './session-view-model.js';
import { wrapWords, type DisplayLine } from './viewport.js';

/**
 * The interim guard of the speaker marker ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6, MVP-11 step 7a):
 * text that is not the host's cannot DRAW THE HOST'S OWN GLYPHS in the transcript: the person's turn (`›`), a tool call (`▸`) or a model switch (`⇄`).
 * That is what it guarantees, and all of it: the three glyphs, exactly. It does not stop a lookalike (see "What it does not claim").
 *
 * **Why it lives at the rows.** The marker is the host's mark of who spoke, so a reply that starts a row with it would put words in the person's
 * mouth. The proper cure is a margin the model's text can never occupy (the transcript grid, a later step of this MVP); until then the glyphs are
 * blanked from every row that is not the host's, AFTER the row is laid out. A markdown layout can start a row with a glyph that was in the middle of
 * the source (a bold heading, a wrapped line, a list item), so a rule on the source or on the start of a row misses it; a rule on the finished row
 * cannot. It replaces the glyph by a space, which is one column like the glyph, so a row measures what it measured and the scroll, the selection and
 * the mouse's row-to-line mapping do not move.
 *
 * **The whole row, not its start.** A leading-only rule is bypassed by a zero-width or a combining character in front of the glyph. These three
 * glyphs do not occur in an ordinary answer, so blanking them anywhere costs nothing.
 *
 * **What it does not claim.** With colour off the host draws `>` and `->`, which are ordinary characters and cannot be blanked from a reply
 * (ADR-0145 §6): the grid closes that, and nothing here pretends to. The text forms (`/edit`, `/copy`, `/scrollback`) are not guarded: their prefix
 * for the person's turn is the host's own `> `, which cannot be blanked, and blanking would only damage what a person copies.
 *
 * **An accepted residual, until the transcript grid (unit 9, ADR-0145 §6).** A glyph that only LOOKS like the marker is not the host's glyph and is
 * not blanked: `˃` (U+02C3), `ᐳ` (U+1433), `❯` (U+276F), `⟩` (U+27E9), `>`, `»` and the like. A reply that starts a row with one of them, or with a
 * strong code span (bold and cyan, the marker's own styling with colour on), can imitate the look of the person's turn, and no rule on the text can
 * tell it from an ordinary answer: blanking `>`, `❯` or `»` at the start of a row would damage ordinary code fences and quotations
 * (`> npm run build`). What makes the marker trustworthy is a margin the model's text can never occupy, which is the grid's; until then a row's
 * look is not proof of who wrote it, and what protects the person is that the host's three glyphs cannot be drawn by anyone else.
 *
 * A data module: no `ink`, no `react`, no `node:` import (ADR-0145 §10).
 */

/**
 * What the text forms (the `/edit` document, `/copy`, `/scrollback`) start the person's turn with, in every form of the screen: the plain
 * ASCII mark of the role and a space. It is derived from the glyph table so the two cannot drift, and a test pins it to `> `.
 */
export const TEXT_FORM_YOUR_TURN = `${GLYPHS.yourTurn.ascii} `;

/**
 * The first row of the person's turn with the host's marker drawn in it: the ASCII mark the text form starts it with is replaced by the glyph in
 * the form asked for (`ascii` is `!color`), and the glyph is carried as data (`marker`) so that a renderer never looks for it in the text. A row
 * that does not start with the text form's mark (it cannot, by construction) is returned unmarked: a renderer then draws plain text, and nothing
 * can be mistaken for a marker.
 *
 * The rest of the row is the person's own words (what they typed or pasted, and a `[📎 …]` note for what they attached) and is left as it is: it
 * cannot start a row, because the host's marker does. Only the rows after this one are guarded ({@link guardEntryRows}).
 */
export function markYourTurn(row: DisplayLine, ascii: boolean): DisplayLine {
  const lead = glyphOf('yourTurn', true);
  if (!row.text.startsWith(lead)) return row;
  const marker = speakerMarker(ascii);
  return { ...row, text: `${marker}${row.text.slice(lead.length)}`, marker };
}

/** `spans` with the marker glyphs blanked from every span's text; the very same array when nothing was blanked. */
function guardSpans(spans: readonly MarkdownSpan[]): readonly MarkdownSpan[] {
  let changed = false;
  const guarded = spans.map((span) => {
    const text = blankMarkerGlyphs(span.text);
    if (text === span.text) return span;
    changed = true;
    return { ...span, text };
  });
  return changed ? guarded : spans;
}

/** One laid-out markdown row (the live tail's, or a finished reply's) with the marker glyphs blanked from its text and from every span. */
export function guardMarkdownLine(line: MarkdownDisplayLine): MarkdownDisplayLine {
  const text = blankMarkerGlyphs(line.text);
  const spans = guardSpans(line.spans);
  return text === line.text && spans === line.spans ? line : { ...line, text, spans };
}

/** One transcript row with the marker glyphs blanked from its text and, when it has them, from every span. The row's style and marker are kept. */
export function guardDisplayLine(line: DisplayLine): DisplayLine {
  const text = blankMarkerGlyphs(line.text);
  const spans = line.spans === undefined ? undefined : guardSpans(line.spans);
  if (text === line.text && spans === line.spans) return line;
  return { ...line, text, ...(spans === undefined ? {} : { spans }) };
}

/**
 * The indexes of the rows of `text`, wrapped at `cols` the way `wrapText` wraps it, that BEGIN a logical line of it (the first row of the text, and the
 * first row after each newline). A row that only continues a wrapped line is not one: a word of a name or a path can start it, whoever wrote the line.
 */
export function logicalLineStarts(text: string, cols: number): ReadonlySet<number> {
  const starts = new Set<number>();
  let row = 0;
  for (const line of text.split('\n')) {
    starts.add(row);
    row += wrapWords(line, cols).length;
  }
  return starts;
}

/**
 * What {@link guardEntryRows} needs beyond the rows. `ascii` is `!color`: the form of the host's marker. `lineStarts` is, for a notice that names a
 * `hostLead`, the rows that begin a logical line ({@link logicalLineStarts}); without it nothing of a notice is kept.
 */
export interface GuardContext {
  readonly ascii: boolean;
  readonly lineStarts?: ReadonlySet<number> | undefined;
}

/**
 * The rows of a notice. A notice is the host's own sentence, but it carries words that are not (a command's output, a name, a path, a model id), so
 * EVERY row is guarded, and a notice that sets nothing keeps nothing. Two host sentences lead their logical lines with a glyph of the set on purpose:
 * the question record's `›` and the model-switch notice's `⇄`. The host that builds such a notice says which (`hostLead`, data on the entry, never a
 * reading of its text), and then a row that begins a logical line keeps THAT glyph at its start and nothing else; the rest of the row is guarded.
 */
function guardNoticeRows(
  rows: readonly DisplayLine[],
  hostLead: 'yourTurn' | 'modelSwitch' | undefined,
  lineStarts: ReadonlySet<number> | undefined,
  ascii: boolean,
): DisplayLine[] {
  const lead = hostLead === undefined ? undefined : GLYPHS[hostLead].glyph;
  // The person's `›` is `>` with colour off, one column either way, and it is the draw that decides: a record built outside the colour setting (the
  // one rebuilt from a resumed session) is drawn in the same form as the live one, which was built inside it. The model switch's `⇄` has a
  // three-column ASCII form that would move the row, so it is drawn as it was built.
  const drawn = ascii && hostLead === 'yourTurn' ? GLYPHS.yourTurn.ascii : lead;
  return rows.map((row, index) => {
    if (
      lead === undefined ||
      drawn === undefined ||
      lineStarts?.has(index) !== true ||
      !row.text.startsWith(lead)
    )
      return guardDisplayLine(row);
    const rest = guardDisplayLine({ ...row, text: row.text.slice(lead.length) });
    return { ...rest, text: `${drawn}${rest.text}` };
  });
}

/**
 * The finished rows of one transcript entry, guarded by the entry's role. The one place the policy is written:
 *
 * - `user`: the first row is the person's turn and carries the host's marker ({@link markYourTurn}); every row after it, a wrapped row or a line
 *   after a newline, is guarded, so a pasted line or a `[📎 …]` note that starts with a glyph cannot draw a second turn.
 * - `assistant`: every row, the reply's and its summary and hint, is guarded: the reply is the model's, and the summary names a model, a provider's
 *   words and a tool.
 * - `notice`: see {@link guardNoticeRows}.
 * - `tools`: not guarded here. The host draws its own `▸` in the middle of a row, so the rows cannot be blanked as a whole; the two words in them
 *   that are not the host's, the tool's id and its target, are blanked where the row is built (`formatToolCall`).
 */
export function guardEntryRows(
  entry: TranscriptEntry,
  rows: readonly DisplayLine[],
  context: GuardContext,
): DisplayLine[] {
  switch (entry.role) {
    case 'tools':
      return [...rows];
    case 'user':
      return rows.map((row, index) =>
        index === 0 ? markYourTurn(row, context.ascii) : guardDisplayLine(row),
      );
    case 'notice':
      return guardNoticeRows(rows, entry.hostLead, context.lineStarts, context.ascii);
    case 'assistant':
      return rows.map(guardDisplayLine);
  }
}
