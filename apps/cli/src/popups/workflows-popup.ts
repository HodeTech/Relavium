/**
 * The `/workflows` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): the project's catalog as a scrollable report,
 * the same one the plain chat's notice lists (`catalogParts`, `chat/repl-info.ts`: workflows, then agents, an invalid entry flagged and never
 * dropped; the no-project line; the fault's own words). On the Home `/workflows` stays the tab host's screen; this is a chat's.
 *
 * **Every slug is untrusted** (it is a file's name in a project) and passes the FULL scrub of the run cards ({@link reportText}); so does the
 * reason of a fault, which can carry a project file's text. The popup has no control: `Esc` closes it.
 */

import { catalogParts, CATALOG_EMPTY_NOTICE, NO_PROJECT_NOTICE } from '../chat/repl-info.js';
import { keyToken } from '../render/tui/legend.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';
import type { WorkflowsReading } from './report-port.js';
import { reportText, wrapHanging } from './report-text.js';

/** The loading words while the catalog is scanned. */
export const WORKFLOWS_LOADING = 'Reading the project catalog';

/** The content of the one step while the scan runs. */
export const WORKFLOWS_LOADING_CONTENT: PopupContent = { kind: 'loading', what: WORKFLOWS_LOADING };

/** The content of the one step for what the scan found: the catalog, nothing, no project, or a fault in its own words. */
export function workflowsContent(reading: WorkflowsReading): PopupContent {
  switch (reading.kind) {
    case 'no-project':
      return {
        kind: 'empty',
        what: NO_PROJECT_NOTICE,
        next: `Open Relavium in a project folder, or use /init on the Home. ${keyToken('Esc')} closes.`,
      };
    case 'fault':
      return {
        kind: 'error',
        what: `Could not list the workflows: ${reportText(reading.reason)}`,
        next: `Close this and try again. ${keyToken('Esc')} closes.`,
      };
    case 'catalog': {
      const parts = catalogParts(reading.workflows, reading.agents);
      if (parts.kind === 'empty')
        return {
          kind: 'empty',
          what: CATALOG_EMPTY_NOTICE,
          next: `Add a workflow or an agent to the project. ${keyToken('Esc')} closes.`,
        };
      return {
        kind: 'report',
        lines: parts.sections.flatMap((section) => [
          ...wrapHanging(section.heading),
          ...section.entries.flatMap((entry) =>
            wrapHanging(
              `  ${reportText(entry.slug)}${entry.valid ? '' : ' (invalid)'}`,
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
    next: `Close this and try again. ${keyToken('Esc')} closes.`,
  };
}

/** The popup's spec: one read-only step with no control, starting on the loading state. */
export function workflowsSpec(origin: PopupOrigin): PopupSpec {
  return {
    id: 'workflows',
    title: '/workflows',
    origin,
    steps: [{ name: 'Workflows', content: WORKFLOWS_LOADING_CONTENT }],
  };
}
