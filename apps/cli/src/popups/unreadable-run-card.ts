/**
 * The card of a run whose log could not be read ([MVP-11](../../../../docs/roadmap/phases/mvp-11.md) unit 7; [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §10): `Enter` on an `unreadable` row of the Home's work page opens it. It is a READ-ONLY report popup: it says which run it is and why its
 * log cannot be read, from the closed vocabulary the Home's store keeps ({@link UnreadableRunReason}); it has no control, no answer key and no
 * `Enter` of its own, so the key that opened it, held down, answers nothing here, and `Esc` is the only key that does anything but scroll.
 *
 * **Its text is the snapshot's and nothing else.** It reads no log again, writes nothing, starts nothing and names no path, error message or stack:
 * the only stored words on it are the run's id, its workflow's slug and its status, each passed through the folds of the work page's rows and of
 * page 1's hint ({@link stored}: the one scrub of every Home flow, `flowLine`, with secrets, control and bidirectional characters, host glyphs,
 * answer chords, key tokens and legend separators made inert; the triangles that pass for the page's `▲`/`▼ N more` marker; the brackets and
 * arrows that dress a name up as a key) and cut to a bound, so a hostile name can neither forge a key hint or a row nor take more than its own line.
 * The title and the first line are made of the same text, so what the rows of the page fold, the card folds.
 *
 * **Its one control is `[c] copy`** (ADR-0148 §1: every report popup offers it): the card as drawn, the whole run id included, goes to the host's
 * clipboard as plain text. It changes nothing and answers nothing, so a key held down on it does no harm; `Esc` (and `Ctrl+C`) close it.
 *
 * A data module ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): pure, the clock passed in. Loaded the first time
 * a card is asked for (`unreadable-run-port.ts`), as every popup's code is.
 */

import type { HomeUnreadableRun, UnreadableRunReason } from '../home/home-store.js';
import { formatAgeOfIso, shortId } from '../render/notation.js';
import { foldKeyLookalikes } from '../render/tui/home-attention.js';
import { workRowText } from '../render/tui/home-projection.js';
import { clipLine } from '../render/tui/sheet-frame.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import { copyControlsFor, copyReport } from './popup-copy.js';
import type { PopupHandlers, PopupOpenResult } from './popup-host.js';
import type { PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, wrapHanging, wrapPopupText } from './popup-text.js';
import type { UnreadableRunOpenRequest } from './unreadable-run-port.js';

/** The columns a run's id or workflow name may take on the card: a real id (a UUID) is 36, a slug is short, and a longer one is cut with `…`. */
const NAME_COLUMNS = 64;
/** The columns a status may take (a closed word of the engine; the bound is for a row a hand edited). */
const STATUS_COLUMNS = 24;
/** The code points of a stored value read before the scrub, so a megabyte of name costs what a short one does. */
const READ_CODE_POINTS = 256;
/** What a value says when the store did not know it, or when nothing of it was left to show. */
const UNKNOWN = 'unknown';

/**
 * The words of each reason, with what to do where there is something to do, one paragraph per entry: product constants, never data. The card says
 * which run it is and why it cannot be read; it names no shell command (ADR-0122 §6, ADR-0146 §6).
 */
const REASON_WORDS: Readonly<Record<UnreadableRunReason, readonly string[]>> = {
  'newer-version': [
    "This run's log has a row written by a newer version of Relavium.",
    'Update Relavium and it reads.',
  ],
  'corrupt-row': ["This run's log has a damaged row.", 'Other runs are not affected.'],
  'could-not-read': ["This run's log could not be read just now. Try again."],
};

/** What the card says last, whatever the reason: it only reads. */
const NOTHING_CHANGED = 'Nothing was changed or started.';

/** The label column of the facts. */
const LABEL_WIDTH = 8;

/**
 * A stored value as the card draws it: read to a bound, then folded as the work page's rows fold a name (`workRowText`: the full scrub, and the
 * marker's lookalikes blanked) and as page 1's hint does (`foldKeyLookalikes`: brackets and arrows a name could pass for a key with), cut to
 * `columns`, and `unknown` when nothing of it is left.
 */
function stored(text: string, columns: number): string {
  const read = Array.from(text.slice(0, READ_CODE_POINTS * 2))
    .slice(0, READ_CODE_POINTS)
    .join('');
  const shown = clipLine(foldKeyLookalikes(workRowText(read)), columns);
  return shown === '' ? UNKNOWN : shown;
}

/** One fact of the card: its label, then its value, which wraps under itself. */
function fact(label: string, value: string): string[] {
  const lead = `  ${label.padEnd(LABEL_WIDTH)}  `;
  return wrapHanging(`${lead}${value}`, POPUP_TEXT_COLUMNS, lead.length);
}

/** The id as the title names it: the short form of the run's id as the card shows it. */
function titleId(run: HomeUnreadableRun): string {
  return shortId(stored(run.runId, NAME_COLUMNS));
}

/**
 * The card's lines for `run`: its title, the run (the whole id, the workflow, and the status and age where the summary read knew them), why its
 * log cannot be read and what to do, and that nothing was changed. `nowMs` is the clock the age is measured against.
 */
export function unreadableRunLines(run: HomeUnreadableRun, nowMs: number): readonly string[] {
  const started = run.createdAt === undefined ? '' : formatAgeOfIso(run.createdAt, nowMs);
  return [
    `Run ${titleId(run)} cannot be read`,
    ...fact('Run id', stored(run.runId, NAME_COLUMNS)),
    ...fact(
      'Workflow',
      run.workflowSlug === undefined ? UNKNOWN : stored(run.workflowSlug, NAME_COLUMNS),
    ),
    ...(run.status === undefined ? [] : fact('Status', stored(run.status, STATUS_COLUMNS))),
    ...(started === '' ? [] : fact('Started', started)),
    '',
    ...REASON_WORDS[run.reason].flatMap((paragraph) => wrapPopupText(paragraph)),
    '',
    ...wrapPopupText(NOTHING_CHANGED),
  ];
}

/** The content of the one step. */
export function unreadableRunContent(run: HomeUnreadableRun, nowMs: number): PopupContent {
  return { kind: 'report', lines: unreadableRunLines(run, nowMs) };
}

/**
 * The popup's spec: one read-only step whose only control is `[c] copy`, kept on the legend row ahead of the scroll hint, so `Esc` and the copy
 * are the keys that do more than scroll.
 */
export function unreadableRunSpec(
  origin: PopupOrigin,
  run: HomeUnreadableRun,
  content: PopupContent,
): PopupSpec {
  return {
    id: 'unreadable-run',
    title: `Run ${titleId(run)}`,
    origin,
    steps: [{ name: 'Run', content, controls: copyControlsFor(content), legendKeep: ['c'] }],
  };
}

/** The one handler: `[c]` sends what the card draws (the lines passed through the popup's own last step) to the host's clipboard. */
function copyHandlers(request: UnreadableRunOpenRequest, content: PopupContent): PopupHandlers {
  return {
    control: (context, key) => {
      if (key === 'c' && content.kind === 'report')
        copyReport(
          context,
          { clipboard: request.clipboard, plainGlyphs: request.plainGlyphs },
          'Run',
          content.lines,
        );
    },
  };
}

/**
 * Open the card over `host`. `Esc` and `Ctrl+C` close it through the host's own keys, `[c]` copies it, and nothing else answers. A refused open
 * (a card is waiting, a turn is running) is said by the host in one notification.
 */
export function openUnreadableRunCard(request: UnreadableRunOpenRequest): PopupOpenResult {
  const content = unreadableRunContent(request.run, request.now());
  return request.host.openForUser(
    unreadableRunSpec(request.origin, request.run, content),
    copyHandlers(request, content),
  );
}
