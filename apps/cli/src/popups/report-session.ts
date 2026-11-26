/**
 * The four report popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * §6, §10): given what the host asked for ({@link ReportOpenRequest}), it opens the popup the typed line names over the host's popup host.
 * Loaded by a dynamic import the first time a report is asked for (`openReport`, `report-port.ts`), as the doctor's is (`doctor-port.ts`), so no
 * host pays for any of it at start. The words every popup shares (the scrub, the wrap, the work starter, the copy and the refusal phrases) are
 * `popup-text.ts`, `popup-work.ts`, `popup-copy.ts` and `chord-refusal.ts`; this module only routes.
 *
 * - `/agent` and `/help` are built from what the session already holds and opened with their content (no read, nothing to wait for).
 * - `/workflows` opens loading and scans the project's catalog in work the popup starts (`cost-session.ts` reads the same way).
 * - `/cost` (and `/cost --release`) is `cost-session.ts`.
 * - `/export`'s confirmation (not a report: a one-step write that asks first, ADR-0148 §10) is `export-session.ts`.
 *
 * Every one writes nothing into the transcript or a notice (the residue rule, ADR-0148 §6): the host's routing never dispatches the line.
 */

import { agentContent, agentSpec, agentUnreadableContent } from './agent-popup.js';
import { openCostPopup } from './cost-session.js';
import { openExportPopup } from './export-session.js';
import type { PopupContent } from './frame-model.js';
import { helpContent, helpSpec } from './help-popup.js';
import { copyControlsFor, copyReport } from './popup-copy.js';
import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { macrotask, startPopupWork } from './popup-work.js';
import type { ReportKind, ReportOpenRequest, ReportsPort } from './report-port.js';
import {
  workflowsContent,
  workflowsFailedContent,
  workflowsSpec,
  WORKFLOWS_LOADING_CONTENT,
} from './workflows-popup.js';

/** Why a report that the host asked for could not open at all: the port lacks what the report needs (a host's wiring mistake, never reachable from a typed line). */
const MISSING: PopupOpenResult = { opened: false, reason: 'closed' };

/** The handler of `[c] copy` for a step whose lines are known when it opens: what the step shows is what is copied. */
function copyHandlers(
  port: Pick<ReportsPort, 'clipboard' | 'plainGlyphs'>,
  label: string,
  content: PopupContent,
): PopupHandlers {
  return {
    control: (context, key) => {
      if (key === 'c' && content.kind === 'report') copyReport(context, port, label, content.lines);
    },
  };
}

function openAgent(request: ReportOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const view = port.agent;
  if (view === undefined) return MISSING;
  let content;
  try {
    content = agentContent(view());
  } catch (cause) {
    // A defect in the view's builder must not take the prompt down with it: the popup opens and says it could not show the agent.
    port.workOwner?.failure(cause);
    content = agentUnreadableContent();
  }
  return host.openForUser(agentSpec(origin, content), copyHandlers(port, 'Agent', content));
}

function openHelp(request: ReportOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const help = port.help;
  if (help === undefined) return MISSING;
  const content = helpContent(port.surface, help.keys);
  return host.openForUser(helpSpec(origin, content), copyHandlers(port, 'Help', content));
}

function openWorkflows(request: ReportOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const workflows = port.workflows;
  if (workflows === undefined) return MISSING;
  const pause = request.yieldToLoop ?? macrotask;
  // What the step shows now, for `[c] copy`: the catalog once it has landed (the control is offered only then).
  let shown: PopupContent = WORKFLOWS_LOADING_CONTENT;
  const opened = host.openForUser(workflowsSpec(origin), {
    control: (context, key) => {
      if (key === 'c' && shown.kind === 'report')
        copyReport(context, port, 'Workflows', shown.lines);
    },
  });
  if (!opened.opened) return opened;
  const context: PopupContext = opened.context;
  const live = (): boolean => !context.signal.aborted;
  startPopupWork(
    port.workOwner,
    async () => {
      await pause();
      if (!live()) return;
      const reading = await workflows.read();
      if (!live()) return;
      shown = workflowsContent(reading);
      context.setContent(0, shown, copyControlsFor(shown));
    },
    () => {
      if (!live()) return;
      shown = workflowsFailedContent();
      context.setContent(0, shown, copyControlsFor(shown));
    },
  );
  return opened;
}

function openCost(request: ReportOpenRequest): PopupOpenResult {
  const cost = request.port.cost;
  return cost === undefined ? MISSING : openCostPopup(request, cost);
}

function openExport(request: ReportOpenRequest): PopupOpenResult {
  const port = request.port.export;
  return port === undefined ? MISSING : openExportPopup(request, port);
}

/** What opens each report: the one table of this file, typed over every kind of the port, so a kind without an opener does not compile. */
const OPENERS: Readonly<Record<ReportKind, (request: ReportOpenRequest) => PopupOpenResult>> = {
  agent: openAgent,
  cost: openCost,
  workflows: openWorkflows,
  help: openHelp,
  export: openExport,
};

/** Open the report popup `request.line` names; see the module header. A refused open is said by the host in one notification. */
export function openReportPopup(request: ReportOpenRequest): PopupOpenResult {
  return OPENERS[request.line.kind](request);
}
