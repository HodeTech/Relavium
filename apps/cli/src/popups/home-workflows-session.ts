/**
 * The `/workflows` popup's state machine on the Home ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D1; its words and rows are
 * `home-workflows-popup.ts`): what is read when, what each key does, and what each hands the host. It decides nothing the flows it starts do not decide
 * again: `[r]` and `[x]` start flows that exist, `[p]` writes a mark, and nothing here starts a run or writes a file.
 *
 * **Reading.** The catalogue is read once when the popup opens, in work the popup starts after the first frame (`startPopupWork`: the owner keeps the
 * database open until it settles), through the `/workflows` popup's own port. `Enter` reads the one workflow's detail the same way (its description, inputs and
 * nodes through the catalog's hardened read, its last three runs for this directory through the history reader), behind a `loading` state; a read that is
 * answered after the person went back, or after the popup closed, lands nowhere (the popup's own context carries the run, this module's token the
 * detail). A fault is a state in the popup, in words; the catalogue's own sentences are scrubbed as every stored word is.
 *
 * **`[r]` run and `[x]` export** close the popup and ask the host for the flow ({@link HomeWorkflowsPort.run}, {@link HomeWorkflowsPort.export}): the
 * `/run` popup at this workflow (its picker skipped once; its form, its `Ctrl+Y` confirmation and its single start are the flow's own) and the export
 * confirmation. The request is the slug and the catalog path the read holds for the row's entry index, never a label, and only a workflow that parsed has
 * one; the host brings this popup back on the detail when the flow ends without a run. **`[p]`** pins or unpins in place through the pin store and reads
 * the rows again, the highlight following the workflow. **`[h]`** and `Enter` on a last run close the popup and open the Runs screen (on that run's
 * detail): the work moves to a screen.
 *
 * **A held or doubled key goes no further than the step it was asked to reach.** `Enter` and every control letter sit behind the popup host's opening
 * guard (a key before the first frame is dropped, nothing answers for half a second after it appeared, and an answer needs a key that arrived after it
 * did). The detail an `Enter` reaches opens at its title with no last run in front, so the next `Enter` of a double tap or of a held key's repeats
 * answers nothing there: a last run has to be walked onto (`↓`) before an `Enter` opens it. `[r]`'s flow drops the auto-repeats of the key that
 * opened it. Nothing here starts a run: the run is the flow's `Ctrl+Y`.
 */

import type { DefinedRead, DefinedRow } from '../history/defined-model.js';
import { isCliError } from '../process/errors.js';
import type { WorkflowDetail } from '../home/workflow-detail.js';
import type { PinPort, PinToggle } from '../render/tui/tab-host-pin.js';
import { toggleWorkflowPin } from '../render/tui/tab-host-pin.js';
import type { PopupContent } from './frame-model.js';
import { stored } from './home-text.js';
import type {
  HomePopupOpenRequest,
  HomeWorkflowRun,
  HomeWorkflowsPort,
  WorkflowsStep,
} from './home-port.js';
import {
  DETAIL_LOADING_CONTENT,
  LAST_RUNS,
  LIST_CONTROLS,
  LIST_ENTER,
  RUNS_CONTROL,
  WORKFLOWS_STEP,
  definedRowOf,
  detailControls,
  detailUnreadableContent,
  homeWorkflowsSpec,
  runIndexOfRow,
  workflowDetailContent,
  workflowRowId,
  workflowsListContent,
  workflowsUnreadableContent,
  type WorkflowDetailView,
} from './home-workflows-popup.js';
import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { fitNotice } from './popup-text.js';
import { macrotask, startPopupWork } from './popup-work.js';

/** The sentence for a row that cannot be run, exported or pinned: what it cannot do, then why. */
function cannot(verb: 'run' | 'export' | 'pin', row: DefinedRow): string {
  const label = stored(row.slug, 18, '?');
  const why =
    row.state === 'not-in-catalog'
      ? 'it is not in the catalog'
      : row.state === 'other-project'
        ? 'it is pinned in another project'
        : stored(row.note ?? 'its file could not be read', 24);
  return fitNotice(`Cannot ${verb} ${label}: ${why}.`, `Cannot ${verb} ${label}.`);
}

/** What a detail reads for one workflow: its file through the catalog and its last runs, or the state that says it cannot be made. */
type DetailRead =
  | {
      readonly kind: 'read';
      readonly detail: WorkflowDetail;
      readonly runs: readonly HomeWorkflowRun[];
    }
  | { readonly kind: 'failed'; readonly reason?: string };

/** The workflow's last runs; a store that cannot answer leaves the detail without them (they are a convenience on that page, and the popup stays). */
function lastRunsOf(workflows: HomeWorkflowsPort, slug: string): readonly HomeWorkflowRun[] {
  try {
    return workflows.lastRuns?.(slug, LAST_RUNS) ?? [];
  } catch {
    return [];
  }
}

/**
 * The detail of the workflow at `path` (`slug` names its runs). The catalogue's own refusal (the file changed, no longer parses) is a state, in its
 * words; anything else is the Home's fault and is thrown for the work owner.
 */
function readDetail(
  workflows: HomeWorkflowsPort,
  path: string | undefined,
  slug: string | undefined,
): DetailRead {
  if (path === undefined || slug === undefined || workflows.describe === undefined)
    return { kind: 'failed' };
  try {
    return { kind: 'read', detail: workflows.describe(path), runs: lastRunsOf(workflows, slug) };
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return { kind: 'failed', reason: stored(cause.message, 90) };
  }
}

/**
 * The row of `next` that stands for `row` of `previous`: a pin of the catalogue by its entry, any other by its pin's row. An entry is the same only
 * when the file at that index is still the one that was listed (its slug AND its path): a workflow file added or removed between the two reads moves
 * the indices, and the row at the old index would then be another workflow.
 */
function sameRow(
  previous: DefinedRead | undefined,
  next: DefinedRead,
  row: DefinedRow,
): DefinedRow | undefined {
  const found = next.model.rows.find((candidate) =>
    row.entryIndex === undefined
      ? candidate.entryIndex === undefined && candidate.pinRowid === row.pinRowid
      : candidate.entryIndex === row.entryIndex,
  );
  if (found?.entryIndex === undefined || row.entryIndex === undefined) return found;
  const same =
    previous?.slugOf(row.entryIndex) === next.slugOf(found.entryIndex) &&
    previous?.pathOf(row.entryIndex) === next.pathOf(found.entryIndex);
  return same ? found : undefined;
}

/** What a pin the store did not refuse says on the channel: its own sentence, or the short form that fits 54 columns. */
const pinNote = (toggled: PinToggle): string =>
  fitNotice(toggled.message, toggled.outcome === 'pinned' ? 'Pinned.' : 'Unpinned.');

/** Open the `/workflows` popup over `request.host` with the port's workflows; see the module header. */
export function openHomeWorkflows(request: HomePopupOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const workflows: HomeWorkflowsPort | undefined = port.workflows;
  if (workflows === undefined) return { opened: false, reason: 'closed' };
  const pause = request.yieldToLoop ?? macrotask;
  /** The catalogue as last read: what the rows on screen were built from, so a row's entry index names the file that was listed. */
  let read: DefinedRead | undefined;
  /** The workflow whose detail is open, with what its read gave. */
  let view: WorkflowDetailView | undefined;
  /** Identifies the detail read that may still land: a read for a detail the person left (or replaced) lands nowhere. */
  let pending: object | undefined;

  /** The slug and the catalog path a request for `row` carries, or the sentence that says why there is none. */
  const requestOf = (
    verb: 'run' | 'export',
    row: DefinedRow,
  ): { readonly slug: string; readonly path: string } | string => {
    if (row.state !== 'ready' || row.entryIndex === undefined) return cannot(verb, row);
    const slug = read?.slugOf(row.entryIndex);
    const path = read?.pathOf(row.entryIndex);
    return slug === undefined || path === undefined
      ? fitNotice(
          `Cannot ${verb} ${stored(row.slug, 18, '?')}: it is not in the catalog any more.`,
          `Cannot ${verb}: it is not in the catalog any more.`,
        )
      : { slug, path };
  };

  const startFlow = (
    context: PopupContext,
    verb: 'run' | 'export',
    row: DefinedRow | undefined,
  ): void => {
    if (row === undefined) return;
    const request = requestOf(verb, row);
    if (typeof request === 'string') {
      context.notify(request);
      return;
    }
    // The popup is closed first: the flow takes the keyboard, and the host puts this popup back, on the step the key was pressed on, when the flow
    // ends without a run.
    const from: WorkflowsStep = context.stepIndex() === WORKFLOWS_STEP.detail ? 'detail' : 'list';
    context.close();
    if (verb === 'run') workflows.run(request.slug, request.path, from);
    else workflows.export(request.slug, from);
  };

  const leaveForRuns = (context: PopupContext, runId?: string): void => {
    context.close();
    workflows.openRuns(runId);
  };

  /** The detail on screen, built from what it holds; the verb of `[p]` follows the pin. */
  const showDetail = (context: PopupContext): void => {
    if (view === undefined) return;
    const content = workflowDetailContent(view, workflows.now());
    context.setContent(WORKFLOWS_STEP.detail, content, detailControls(view.row), false);
  };

  const openDetail = (context: PopupContext, row: DefinedRow | undefined): void => {
    if (row === undefined) return;
    const token = {};
    pending = token;
    view = { row, detail: undefined, runs: [] };
    if (row.state !== 'ready') {
      // Nothing to read: what a row that is no workflow of the catalogue is, and that it can be unpinned.
      showDetail(context);
      context.goToStep(WORKFLOWS_STEP.detail);
      return;
    }
    context.setContent(WORKFLOWS_STEP.detail, DETAIL_LOADING_CONTENT, [], false);
    context.goToStep(WORKFLOWS_STEP.detail);
    const path = row.entryIndex === undefined ? undefined : read?.pathOf(row.entryIndex);
    const slug = row.entryIndex === undefined ? undefined : read?.slugOf(row.entryIndex);
    const live = (): boolean => !context.signal.aborted && pending === token;
    const failed = (reason?: string): void => {
      if (live())
        context.setContent(WORKFLOWS_STEP.detail, detailUnreadableContent(reason), [], false);
    };
    startPopupWork(
      port.workOwner,
      async () => {
        await pause();
        if (!live()) return;
        const result = readDetail(workflows, path, slug);
        if (result.kind === 'failed') {
          failed(result.reason);
          return;
        }
        if (!live()) return;
        view = { row, detail: result.detail, runs: result.runs };
        showDetail(context);
      },
      () => {
        failed();
      },
    );
  };

  /** `[p]`: the workflow in front pinned or unpinned in place, the rows read again, the highlight following the workflow. */
  const pin = (context: PopupContext, row: DefinedRow | undefined): void => {
    if (row === undefined) return;
    const pins: PinPort | undefined = workflows.pins;
    if (pins === undefined) {
      context.notify('Pinning is unavailable in this session.');
      return;
    }
    const slug = row.entryIndex === undefined ? undefined : read?.slugOf(row.entryIndex);
    if (!row.pinned && (row.state !== 'ready' || slug === undefined)) {
      context.notify(cannot('pin', row));
      return;
    }
    const label = stored(row.slug, 18, '?');
    const toggled = toggleWorkflowPin(pins, {
      label,
      slug,
      pinned: row.pinned,
      rowid: row.pinRowid,
    });
    if (toggled.outcome === 'full') {
      // The cap changed nothing. The store's own counts (`50 is the limit; 50 stored, 3 elsewhere`) do not fit the notification's 54 columns with
      // any name, so the sentence is the one without them, whole or without the name.
      context.notify(fitNotice(toggled.message, 'Cannot pin: 50 pins is the limit. Unpin one.'));
      return;
    }
    refreshAfterPin(context, row, toggled);
  };

  /** The rows read again after a pin changed, the highlight (and an open detail) following the workflow; the result is one notification. */
  const refreshAfterPin = (context: PopupContext, row: DefinedRow, toggled: PinToggle): void => {
    const note = pinNote(toggled);
    let next: DefinedRead;
    try {
      next = workflows.read();
    } catch {
      context.notify(fitNotice(`${toggled.message} The list could not be read again.`, note));
      return;
    }
    const previous = read;
    read = next;
    land(context, next);
    if (context.stepIndex() === WORKFLOWS_STEP.detail) {
      const after = sameRow(previous, next, row);
      if (after === undefined || view === undefined) context.goToStep(WORKFLOWS_STEP.list);
      else {
        view = { ...view, row: after };
        showDetail(context);
      }
    }
    context.notify(note);
  };

  /** The catalogue as the list step shows it, with its controls (none for a state that has no row to act on, but `[h]`: the runs are there). */
  const land = (context: PopupContext, data: DefinedRead, initialRow?: string): void => {
    const content = workflowsListContent(data, workflows.now(), initialRow);
    context.setContent(
      WORKFLOWS_STEP.list,
      content,
      content.kind === 'list' ? LIST_CONTROLS : [RUNS_CONTROL],
      content.kind === 'list' ? LIST_ENTER : false,
    );
  };

  const handlers: PopupHandlers = {
    enter: (context, row) => {
      if (context.stepIndex() === WORKFLOWS_STEP.list) {
        openDetail(context, definedRowOf(read, row));
        return;
      }
      const index = runIndexOfRow(row);
      const run = index === undefined ? undefined : view?.runs[index];
      if (run !== undefined) leaveForRuns(context, run.runId);
    },
    control: (context, key, row) => {
      const onList = context.stepIndex() === WORKFLOWS_STEP.list;
      // The workflow a letter acts on: the highlighted row of the catalogue, or the one whose detail is open.
      const target = onList ? definedRowOf(read, row) : view?.row;
      if (key === 'r') startFlow(context, 'run', target);
      else if (key === 'h' && onList) leaveForRuns(context);
      else if (key === 'x' && !onList) startFlow(context, 'export', target);
      else if (key === 'p' && !onList) pin(context, target);
    },
  };

  const opened = host.openForUser(homeWorkflowsSpec(origin), handlers);
  if (!opened.opened) return opened;
  const context = opened.context;
  const live = (): boolean => !context.signal.aborted;
  const landed = (content: PopupContent): void => {
    context.setContent(WORKFLOWS_STEP.list, content, [RUNS_CONTROL], false);
  };
  startPopupWork(
    port.workOwner,
    async () => {
      await pause();
      if (!live()) return;
      try {
        read = workflows.read();
      } catch (cause) {
        // A catalogue the project cannot give is a state in the popup, in the catalogue's own words; anything else is a fault of the Home's.
        if (!isCliError(cause)) throw cause;
        if (live()) landed(workflowsUnreadableContent(stored(cause.message, 120)));
        return;
      }
      if (!live()) return;
      // Reopened on a workflow (a flow handed it back): the highlight is on it, and its detail is open when the flow was started from the detail.
      const at = request.at?.slug;
      const back =
        at === undefined
          ? undefined
          : read.model.rows.find(
              (row) => row.entryIndex !== undefined && read?.slugOf(row.entryIndex) === at,
            );
      land(context, read, back === undefined ? undefined : workflowRowId(back));
      if (back !== undefined && request.at?.step === 'detail') openDetail(context, back);
    },
    () => {
      if (live()) landed(workflowsUnreadableContent());
    },
  );
  return opened;
}
