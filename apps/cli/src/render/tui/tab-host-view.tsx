import type { ReactElement } from 'react';

import { SheetLinesView } from './permissions-sheet-view.js';
import { tabHostLines, type TabHostState } from './tab-host.js';

/**
 * The Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1) — a PURE ink view over {@link tabHostLines}. It owns no `useInput` (the Home's `RootApp` is the one raw-mode owner) and no state: the
 * strip, the tab's body and the legend are the model's lines, painted as the permissions sheet paints its own. Every state the colour shows
 * also has a glyph or a word (the `▸` on the current tab, the `›` marker and `[d]` of a row, the `✓`/`✗` of an answer, the `▲`/`▼` markers),
 * so the screen reads the same with colour off (ADR-0122 §7.2), and it is the same view in the full-screen and the inline renderer: the
 * lines are bounded by the model, so it never grows past the rows the Home allows.
 */
export interface TabHostViewProps {
  readonly state: TabHostState;
  readonly color: boolean;
  readonly columns: number;
  readonly rows: number;
}

export function TabHostView(props: Readonly<TabHostViewProps>): ReactElement {
  const lines = tabHostLines(props.state, { columns: props.columns, terminalRows: props.rows });
  return <SheetLinesView lines={lines} color={props.color} />;
}
