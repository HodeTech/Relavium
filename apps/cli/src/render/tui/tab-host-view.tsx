import type { ReactElement } from 'react';

import { sanitizeInline } from '../sanitize.js';
import { withGlyphForm } from './glyphs.js';
import { screenText } from './screen-text.js';
import { SheetLinesView } from './sheet-lines-view.js';
import { clampSpans, type SheetLine } from './sheet-frame.js';
import { tabHostLines, type TabHostState } from './tab-host.js';

/**
 * The Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1) — a PURE ink view over {@link tabHostLines}. It owns no `useInput` (the Home's `RootApp` is the one raw-mode owner) and no state: the
 * strip, the tab's body and the legend are the model's lines, painted by `SheetLinesView`, the painter every popup frame uses too. Every state the colour shows
 * also has a glyph or a word (the `▸` on the current tab, the `›` marker and `[d]` of a row, the `✓`/`✗` of an answer, the `▲`/`▼` markers),
 * so the screen reads the same with colour off (ADR-0122 §7.2), and it is the same view in the full-screen and the inline renderer: the
 * lines are bounded by the model, so it never grows past the rows the Home allows. Every line the model hands in passes `sanitizeInline` and the
 * screen's filter (`screenText`) once more here, at the one place a line reaches the terminal: the tabs sanitize what they read, and this is the floor under them (cheap and
 * idempotent, so a line the tabs already cleaned is the very same object).
 */
export interface TabHostViewProps {
  readonly state: TabHostState;
  readonly color: boolean;
  readonly columns: number;
  readonly rows: number;
}

/** `line` with its text sanitized and screen-filtered; the same object when there was nothing to remove, and its spans kept inside the shorter text when there was. */
function drawable(line: SheetLine): SheetLine {
  const text = screenText(sanitizeInline(line.text));
  if (text === line.text) return line;
  return {
    ...line,
    text,
    ...(line.spans === undefined ? {} : { spans: clampSpans(line.spans, text.length) }),
  };
}

export function TabHostView(props: Readonly<TabHostViewProps>): ReactElement {
  // The model builds its rows (and measures them) in the glyph form the colour setting asks for: the plain forms when colour is off.
  const lines = withGlyphForm(!props.color, () =>
    tabHostLines(props.state, { columns: props.columns, terminalRows: props.rows }),
  ).map(drawable);
  return <SheetLinesView lines={lines} color={props.color} />;
}
