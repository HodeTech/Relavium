/**
 * The `/agents` popup's state machine on the Home ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D5; its words and rows are
 * `home-agents-popup.ts`): what is read when, what each key does, what `[c]` hands the host.
 *
 * **Reading.** The catalog is read once, in work the popup starts after the first frame (`startPopupWork`: the owner keeps the database open until it
 * settles), through the strip's own port. A `CliError` the catalog raises (an unreadable directory, more files than it lists) is a state in the popup,
 * in the catalog's own words scrubbed as a stored word is; any other fault is the owner's and says only that the agents could not be listed. A read for
 * a popup that has since closed lands nowhere.
 *
 * **`Enter`** opens the detail of a ready agent (its rows are built from the read it holds, so the detail is the agent that was listed); on an invalid
 * one it says why there is none, in one notification, and opens nothing. **`[c]`** closes the popup and asks the host for a chat bound to the agent:
 * the request carries the catalog's own path of the file and the definition the detail was drawn from (read through the port with the row's entry
 * index), or, when the file is no longer in the read, says so and starts nothing.
 */

import type { AgentRow } from '../history/agents-model.js';
import type { AgentsRead } from '../home/agents-port.js';
import { isCliError } from '../process/errors.js';
import {
  AGENT_CHAT_CONTROL,
  AGENTS_STEP,
  agentDetailContent,
  agentsListContent,
  agentsUnreadableContent,
  entryIndexOfAgentRow,
  homeAgentsSpec,
} from './home-agents-popup.js';
import type { PopupContent } from './frame-model.js';
import { stored } from './home-text.js';
import type { HomePopupOpenRequest } from './home-port.js';
import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { macrotask, startPopupWork } from './popup-work.js';
import { fitNotice } from './popup-text.js';

/** A notification about an agent, whole beside the popup's way back (54 columns): the slug is cut, never the words that say what happened. */
function notice(slug: string, rest: string): string {
  return fitNotice(`${stored(slug, 20, 'This agent')} ${rest}`, `This agent ${rest}`);
}

/** Open the `/agents` popup over `request.host` with the port's agents; see the module header. */
export function openHomeAgents(request: HomePopupOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const agents = port.agents;
  if (agents === undefined) return { opened: false, reason: 'closed' };
  const pause = request.yieldToLoop ?? macrotask;
  /** The catalog as read: the rows on screen were built from it, so a row's entry index names the file that was listed. */
  let read: AgentsRead | undefined;
  /** The agent whose detail is open. */
  let detailOf: AgentRow | undefined;

  const handlers: PopupHandlers = {
    enter: (context, row) => {
      const index = entryIndexOfAgentRow(row);
      const agent =
        index === undefined ? undefined : read?.model.rows.find((r) => r.entryIndex === index);
      if (agent === undefined) return;
      if (agent.state !== 'ready') {
        context.notify(
          notice(
            agent.slug,
            `cannot be opened: ${stored(agent.note ?? 'its file could not be read', 30)}`,
          ),
        );
        return;
      }
      detailOf = agent;
      const content = agentDetailContent(agent);
      context.setContent(
        AGENTS_STEP.detail,
        content,
        content.kind === 'report' ? [AGENT_CHAT_CONTROL] : [],
      );
      context.goToStep(AGENTS_STEP.detail);
    },
    control: (context, key) => {
      if (key !== AGENT_CHAT_CONTROL.key || context.stepIndex() !== AGENTS_STEP.detail) return;
      chat(context);
    },
  };

  /** `[c]`: hand the host the agent the detail showed, and close; a file that is no longer in the read starts nothing and says so. */
  const chat = (context: PopupContext): void => {
    const agent = detailOf;
    if (agent === undefined || read === undefined) return;
    const path = read.pathOf(agent.entryIndex);
    const listed = read.definitionOf(agent.entryIndex);
    if (path === undefined || listed === undefined) {
      context.notify(notice(agent.slug, 'cannot be started: its file is not in the catalog.'));
      return;
    }
    context.close();
    agents.chat({ path, listed });
  };

  const opened = host.openForUser(homeAgentsSpec(origin), handlers);
  if (!opened.opened) return opened;
  const context = opened.context;
  const live = (): boolean => !context.signal.aborted;
  const land = (content: PopupContent): void => {
    context.setContent(AGENTS_STEP.list, content);
  };
  startPopupWork(
    port.workOwner,
    async () => {
      await pause();
      if (!live()) return;
      try {
        read = agents.read();
      } catch (cause) {
        // A catalog the project cannot give is a state in the popup, in the catalog's own words; anything else is a fault of the Home's.
        if (!isCliError(cause)) throw cause;
        if (live()) land(agentsUnreadableContent(stored(cause.message, 120)));
        return;
      }
      if (live()) land(agentsListContent(read.model.rows));
    },
    () => {
      if (live()) context.setContent(AGENTS_STEP.list, agentsUnreadableContent());
    },
  );
  return opened;
}
