/**
 * The `/agent` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): the agent the CURRENT chat is bound to, read-only,
 * as a scrollable report. It replaces the docked sheet of [ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and shows the same fields from the same view (`BoundAgentView`: the definition the SESSION holds, never a file): the name, the file label,
 * the provider and the model it runs on, the temperature and the reasoning effort, the tool grant with the mark of a tool this chat does not
 * wire, and the head of the system prompt. Its words are the pure field formatting `chat/agent-notice.ts` keeps for the plain chat's notice (the name,
 * the tool grant with its marks, the effort the session uses), one field to a row and wrapped where the sheet cut, so the two cannot name
 * different facts.
 *
 * **Every field is untrusted** (an agent's name, id, model, tool names and prompt come from a project's YAML or a shared database), and this
 * is one of the report popups whose builders share the FULL scrub of the run cards ({@link scrubPopupText}): the view's own scrub is a floor under
 * it, not the scrub. Its one control is `[c] copy`; `Esc` (and `Ctrl+C`) close it.
 */

import {
  agentTitle,
  effortText,
  EMPTY_PROMPT,
  fieldLead,
  INDENT,
  LABEL_WIDTH,
  nameText,
  NOT_SET,
  toolsParts,
  wrappedTools,
} from '../chat/agent-notice.js';
import type { BoundAgentView } from '../chat/bound-agent-view.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import { copyControlsFor } from './popup-copy.js';
import type { PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, scrubPopupCut, scrubPopupText, wrapHanging } from './popup-text.js';

/** What the popup says when the view of the agent cannot be made. */
const AGENT_REPORT_UNREADABLE = {
  what: 'The agent could not be shown.',
  next: 'Close this popup and open it again.',
} as const;

/**
 * The view with every string passed through the full scrub, whatever scrub the view was built with: the id, the name, the provider, the model,
 * each tool name, the prompt's head, the effort the definition declares and the file label. The numbers and the booleans carry no text.
 */
function scrubbedAgentView(view: BoundAgentView): BoundAgentView {
  const { detail } = view;
  return {
    ...view,
    id: scrubPopupText(view.id),
    name: view.name === undefined ? undefined : scrubPopupCut(view.name),
    sourceLabel: view.sourceLabel === undefined ? undefined : scrubPopupText(view.sourceLabel),
    detail: {
      ...detail,
      // The view cut these with its own `…` (a bounded prompt head, a long tool id): the scrub keeps that mark as the one ellipsis.
      model: scrubPopupCut(detail.model),
      provider: scrubPopupCut(detail.provider),
      tools: detail.tools.map(scrubPopupCut),
      promptHead: scrubPopupCut(detail.promptHead),
      ...(detail.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: scrubPopupCut(detail.reasoningEffort) }),
    },
  };
}

/** One field: its label, then its value, which wraps under itself (nothing is cut: a popup scrolls where a sheet could not). */
function field(label: string, value: string): string[] {
  const lead = fieldLead(label);
  return wrapHanging(`${lead}${value}`, POPUP_TEXT_COLUMNS, lead.length);
}

/**
 * The tool grant as rows: the count that leads (only where a declared tool is not offered) and the names, each with its mark, wrapped BETWEEN
 * names so a mark is never split from its name over two lines, and a name that is wider than the room wrapped onto the rows after it. Nothing
 * is cut or left out: a popup scrolls where a sheet cut, so the whole of every tool id is on screen and in the copy.
 */
function toolsField(view: BoundAgentView): string[] {
  const { lead, items } = toolsParts(view);
  const rows = wrappedTools(
    lead,
    items.map((item) => item.text),
    POPUP_TEXT_COLUMNS - INDENT.length - LABEL_WIDTH,
  );
  return rows.map((row, index) => `${index === 0 ? fieldLead('Tools') : fieldLead('')}${row}`);
}

/**
 * The report's lines: the agent's title, a blank row, then one field per row, each wrapped to the popup's width: the name (and that it is the
 * built-in agent), the file label, the provider and the model, the temperature, the reasoning effort the session uses (with the declared one
 * when it differs), the tool grant with its marks and the head of the system prompt. Every string passes the full scrub first.
 */
export function agentReportLines(view: BoundAgentView): readonly string[] {
  const scrubbed = scrubbedAgentView(view);
  const { detail } = scrubbed;
  return [
    agentTitle(scrubbed),
    '',
    ...field('Name', nameText(scrubbed)),
    ...(scrubbed.sourceLabel === undefined ? [] : field('File', scrubbed.sourceLabel)),
    ...field('Provider', detail.provider),
    ...field('Model', detail.model),
    ...field(
      'Temperature',
      detail.temperature === undefined ? NOT_SET : String(detail.temperature),
    ),
    ...field('Reasoning effort', effortText(scrubbed)),
    ...toolsField(scrubbed),
    ...field('System prompt', detail.promptHead === '' ? EMPTY_PROMPT : detail.promptHead),
  ];
}

/** The popup's one step's content for `view`. */
export function agentContent(view: BoundAgentView): PopupContent {
  return { kind: 'report', page: true, lines: agentReportLines(view) };
}

/** The content of the one step when the view could not be made. */
export function agentUnreadableContent(): PopupContent {
  return { kind: 'error', ...AGENT_REPORT_UNREADABLE };
}

/**
 * The popup's spec: one read-only step whose only control is `[c] copy` (listed while the content is a report, not when the view could not be
 * made), so `Esc` and the copy are the keys it adds to the arrows. `legendKeep` keeps the copy on the legend row ahead of the scroll hint.
 */
export function agentSpec(origin: PopupOrigin, content: PopupContent): PopupSpec {
  return {
    id: 'agent',
    title: '/agent',
    origin,
    steps: [{ name: 'Agent', content, controls: copyControlsFor(content), legendKeep: ['c'] }],
  };
}
