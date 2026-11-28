import type { MarginRole } from './chat-grid.js';
import { GLYPHS } from './glyphs.js';

/**
 * Who spoke, on the transcript's grid ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6, MVP-11 unit 9): the
 * host's marks of the person's turn (`›`), a tool call (`▸`) and a model switch (`⇄`) are drawn in a MARGIN that the host owns, and every word a
 * person or a model wrote is laid out in the CONTENT column to its right (`chat-grid.ts`). A row's mark is a role of the closed `MarginRole` set,
 * carried as data on the row (`DisplayLine.margin`) and drawn by `marginCell`, which takes no text; nothing reads a row's text to decide its mark.
 *
 * **The screen's two filters (review round 1 of unit 9, OQ4 as revised).** The margin is exact in the layout, but a terminal can measure a
 * character wider than the layout does and wrap a row into the next row's margin. So every drawn row of text that is not the host's goes through
 * the screen's filter (`screen-text.ts`: the fillers a terminal may draw wider, and an orphan mark at a row's start) and has the three glyphs
 * blanked again, as step 7a did (`chat-projection.ts` `screenRow`, and the live region's `screenModelText` / `screenStreamRow`). A glyph and the
 * space that replaces it are one column, so no row moves. The inline renderer's words get the same care: a row of a reply or a notice that starts
 * with one of them carries its own entry's word (`startsWithMarginWord`, `chat-grid.ts`).
 *
 * **What is not claimed.** The text forms (`/edit`, `/copy`, `/scrollback`) are flat text: they start the person's turn with the host's own `> `
 * ({@link TEXT_FORM_YOUR_TURN}), and a model line `> x` looks the same there; they are neither filtered nor blanked (that would only damage what is
 * copied). The name of this module is older than the grid: what it holds is the text form's prefix and the notices' leads.
 *
 * A data module: no `ink`, no `react`, no `node:` import (ADR-0145 §10).
 */

/**
 * What the text forms (the `/edit` document, `/copy`, `/scrollback`) start the person's turn with, in every form of the screen: the plain
 * ASCII mark of the role and a space. It is derived from the glyph table so the two cannot drift, and a test pins it to `> `.
 */
export const TEXT_FORM_YOUR_TURN = `${GLYPHS.yourTurn.ascii} `;

/** One logical line of a notice as the screen draws it: its words, and the margin role the host's lead gives it. */
export interface NoticeLine {
  readonly text: string;
  readonly margin?: MarginRole;
}

/**
 * The logical lines of a notice's text as the screen draws them. A notice is the host's sentence, but it carries words that are not (a command's
 * output, a name, a path, a model id), so a line gets a mark only from data the host set: `hostLead`, which a host that builds a notice whose
 * logical lines lead with a mark of its own names (the question record's `›`, the model-switch notice's `⇄`; never a reading of the text). Then a
 * logical line that begins with that lead, in either form of the glyph table (the glyph, or its plain form when it was built without colour), and a
 * space has the two taken out of its text and carries the lead as its margin role. Every other line, and every line of a notice that names no lead,
 * is its text as it is, unmarked. This function rewrites no word: the screen's filter and blank come after it, on the drawn rows.
 */
export function noticeLines(
  text: string,
  hostLead: 'yourTurn' | 'modelSwitch' | undefined,
): readonly NoticeLine[] {
  const lines = text.split('\n');
  if (hostLead === undefined) return lines.map((line) => ({ text: line }));
  const leads = [GLYPHS[hostLead].glyph, GLYPHS[hostLead].ascii].map((lead) => `${lead} `);
  return lines.map((line) => {
    const lead = leads.find((candidate) => line.startsWith(candidate));
    return lead === undefined
      ? { text: line }
      : { text: line.slice(lead.length), margin: hostLead };
  });
}
