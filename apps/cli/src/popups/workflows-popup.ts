/**
 * The `/workflows` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): the project's catalog as a scrollable report,
 * the same one the plain chat's notice lists (`catalogParts`, `chat/repl-info.ts`: workflows, then agents, an invalid entry flagged and never
 * dropped; the no-project line; the fault's own words). On the Home `/workflows` stays the tab host's screen; this is a chat's.
 *
 * **Every slug is untrusted** (it is a file's name in a project) and passes the FULL scrub of the run cards ({@link scrubPopupText}); so does the
 * reason of a fault, which can carry a project file's text. Its one control is `[c] copy`, offered with the catalog; `Esc` closes it.
 */

import {
  catalogParts,
  CATALOG_EMPTY_NOTICE,
  invalidMark,
  NO_PROJECT_NOTICE,
} from '../chat/repl-info.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';
import { scrubPopupText, wrapHanging } from './popup-text.js';
import type { WorkflowsReading } from './report-port.js';

/** The loading words while the catalog is scanned. */
const WORKFLOWS_LOADING = 'Reading the project catalog';

/** What the error state says first when the scan ran and found a fault: the fault's own words follow on the next line. */
export const WORKFLOWS_FAULT = 'Could not list the workflows.';

/** The content of the one step while the scan runs. */
export const WORKFLOWS_LOADING_CONTENT: PopupContent = { kind: 'loading', what: WORKFLOWS_LOADING };

/** The content of the one step for what the scan found: the catalog, nothing, no project, or a fault in its own words. */
export function workflowsContent(reading: WorkflowsReading): PopupContent {
  switch (reading.kind) {
    case 'no-project':
      return {
        kind: 'empty',
        what: NO_PROJECT_NOTICE,
        next: 'Open Relavium in a project folder, or use /init on the Home.',
      };
    case 'fault':
      // The fault's own words are the second line, scrubbed: they are what a project or a catalog cap wrote and are as long as they are.
      return {
        kind: 'error',
        what: WORKFLOWS_FAULT,
        next: scrubPopupText(reading.reason),
      };
    case 'catalog': {
      const parts = catalogParts(reading.workflows, reading.agents);
      if (parts.kind === 'empty')
        return {
          kind: 'empty',
          what: CATALOG_EMPTY_NOTICE,
          next: 'Add a workflow or an agent to the project.',
        };
      return {
        kind: 'report',
        lines: parts.sections.flatMap((section) => [
          ...wrapHanging(section.heading),
          ...section.entries.flatMap((entry) =>
            wrapHanging(
              `  ${scrubPopupText(entry.slug)}${entry.valid ? '' : invalidMark(entry.reason, scrubPopupText)}`,
              undefined,
              6,
            ),
          ),
        ]),
      };
    }
  }
}

/** The content of the one step when the scan could not run at all: by words only (the fault went to the owner). */
export function workflowsFailedContent(): PopupContent {
  return {
    kind: 'error',
    what: 'The project catalog could not be read.',
    next: 'Close this and try again.',
  };
}

/**
 * The popup's spec: one read-only step starting on the loading state, with no control yet. `[c] copy` arrives with the catalog
 * ({@link copyControlsFor}: only a report is offered a copy, not the loading, empty or failed states), and `legendKeep` keeps it on the legend
 * row ahead of the scroll hint.
 */
export function workflowsSpec(origin: PopupOrigin): PopupSpec {
  return {
    id: 'workflows',
    title: '/workflows',
    origin,
    steps: [{ name: 'Workflows', content: WORKFLOWS_LOADING_CONTENT, legendKeep: ['c'] }],
  };
}
