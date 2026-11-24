/**
 * What the completeness guard (`legend-completeness.test.ts`) reads: the files that may write a hint-shaped string, how many each
 * writes, and the strings it is allowed not to cover. The shape is {@link isHintShaped} (`hint-shape.ts`).
 *
 * **This is the list the conversion to the builder shrinks.** Step 3 moves a producer onto `legend()`, and the literals of its file
 * disappear: the guard then fails until the count here is lowered (and the entry deleted at zero), so the ledger can only get shorter
 * and a hint written by hand in a file that was already converted is caught. Adding a literal to a file that is listed fails too, until a
 * recorder says what it emits.
 */

/** Production files that write hint-shaped strings by hand, and how many such strings each writes (`apps/cli/src`, `/` separators). */
export const HINT_LITERAL_FILES: Readonly<Record<string, number>> = {
  'chat/effort-notice.ts': 1,
  'chat/starting-mode-hint.ts': 1,
  'commands/agent-run.ts': 1,
  'commands/repl-commands.ts': 3,
  'engine/providers.ts': 5,
  'home/drive-home.tsx': 3,
  'home/run-launch.ts': 1,
  'onboarding/wizard.ts': 1,
  'render/scrollback.ts': 1,
  'render/tui/attachment-bar.tsx': 1,
  'render/tui/chat-ink.tsx': 7,
  'render/tui/chat-input.ts': 1,
  'render/tui/chat-projection.ts': 6,
  'render/tui/checkpoint-card-view.tsx': 2,
  'render/tui/checkpoint-card.ts': 2,
  'render/tui/help-sheet.ts': 1,
  'render/tui/home-app.tsx': 2,
  'render/tui/home-attention.ts': 7,
  'render/tui/home-controller.ts': 3,
  'render/tui/home-notice.ts': 1,
  'render/tui/home-projection.ts': 4,
  'render/tui/home-view.tsx': 18,
  'render/tui/mention-view.tsx': 1,
  'render/tui/model-picker-view.tsx': 5,
  'render/tui/native-picker.ts': 2,
  'render/tui/native-prompt-channel.ts': 2,
  'render/tui/native-prompt-view.tsx': 11,
  'render/tui/native-select-window.ts': 4,
  'render/tui/palette-view.tsx': 1,
  'render/tui/permissions-sheet.ts': 12,
  'render/tui/question-card-model.ts': 1,
  'render/tui/question-card-view.tsx': 2,
  'render/tui/question-card.ts': 17,
  'render/tui/reverse-search-view.tsx': 1,
  'render/tui/run-card-model.ts': 8,
  'render/tui/shell.ts': 1,
  'render/tui/tab-host-active.ts': 5,
  'render/tui/tab-host-history.ts': 5,
  'render/tui/tab-host-node.ts': 1,
  'render/tui/tab-host.ts': 1,
  'render/tui/tool-review-card.ts': 16,
  'render/tui/tool-review-screen.ts': 19,
  'render/tui/tool-review-view.tsx': 8,
};

/**
 * A place that may hold a hint-shaped string without being a producer of one, and why. `file` is a path under `apps/cli/src`; a path
 * that ends in `/` is a directory and covers everything under it. `contains` narrows an entry to the one string that contains it, and
 * such an entry fails when it no longer matches anything, so a stale allowance cannot hide a real hint later.
 */
export interface NotALegend {
  readonly file: string;
  readonly contains?: string;
  readonly reason: string;
}

export const NOT_A_LEGEND: readonly NotALegend[] = [
  {
    file: 'render/tui/legend-golden/',
    reason:
      'this directory: the recorders drive the producers and quote what they say, and the guard’s own tables and tests name keys; none of it is shown to a person',
  },
  {
    file: 'render/tui/surface-matrix/',
    reason:
      'the surface matrix harness (MVP-11 Step 3): test support whose rows are fixtures describing surfaces, not a producer of a legend',
  },
];
