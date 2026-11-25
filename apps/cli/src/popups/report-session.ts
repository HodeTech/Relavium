/**
 * The four report popups' opener ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * §6, §10): given what the host asked for ({@link ReportOpenRequest}), it opens the popup the typed line names over the host's popup host.
 * Loaded by a dynamic import the first time a report is asked for (`openReport`, `report-port.ts`), the doctor's pattern, so no host pays for
 * any of it at start.
 *
 * - `/agent` and `/help` are built from what the session already holds and opened with their content (no read, nothing to wait for).
 * - `/workflows` opens loading and scans the project's catalog in work the popup starts (`cost-session.ts` reads the same way).
 * - `/cost` (and `/cost --release`) is `cost-session.ts`.
 *
 * Every one writes nothing into the transcript or a notice (the residue rule, ADR-0148 §6): the host's routing never dispatches the line.
 */

import { agentContent, agentSpec, agentUnreadableContent } from './agent-popup.js';
import { openCostPopup } from './cost-session.js';
import type { PopupContext, PopupOpenResult } from './popup-host.js';
import { helpContent, helpSpec } from './help-popup.js';
import type { ReportOpenRequest } from './report-port.js';
import { macrotask, startReportWork } from './report-work.js';
import { workflowsContent, workflowsFailedContent, workflowsSpec } from './workflows-popup.js';

/** Why a report that the host asked for could not open at all: the port lacks what the report needs (a host's wiring mistake, never reachable from a typed line). */
const MISSING: PopupOpenResult = { opened: false, reason: 'closed' };

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
  return host.openForUser(agentSpec(origin, content));
}

function openHelp(request: ReportOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const help = port.help;
  if (help === undefined) return MISSING;
  return host.openForUser(helpSpec(origin, helpContent(port.surface, help.keys)));
}

function openWorkflows(request: ReportOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const workflows = port.workflows;
  if (workflows === undefined) return MISSING;
  const pause = request.yieldToLoop ?? macrotask;
  const opened = host.openForUser(workflowsSpec(origin));
  if (!opened.opened) return opened;
  const context: PopupContext = opened.context;
  const live = (): boolean => !context.signal.aborted;
  startReportWork(
    port.workOwner,
    async () => {
      await pause();
      if (!live()) return;
      const reading = await workflows.read();
      if (!live()) return;
      context.setContent(0, workflowsContent(reading));
    },
    () => {
      if (live()) context.setContent(0, workflowsFailedContent());
    },
  );
  return opened;
}

/** Open the report popup `request.line` names; see the module header. A refused open is said by the host in one notification. */
export function openReportPopup(request: ReportOpenRequest): PopupOpenResult {
  switch (request.line.kind) {
    case 'agent':
      return openAgent(request);
    case 'help':
      return openHelp(request);
    case 'workflows':
      return openWorkflows(request);
    case 'cost':
      return request.port.cost === undefined ? MISSING : openCostPopup(request, request.port.cost);
  }
}
