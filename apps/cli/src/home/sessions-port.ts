import type { SessionStore } from '@relavium/db';

import { scrubbedBounded } from '../history/run-detail-model.js';
import { formatAgeOfIso } from '../render/notation.js';
import type { SessionRow, SessionsPort } from '../render/tui/tab-host-sessions.js';

/**
 * What the Home's `/agents` Sessions tab reads ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the newest saved conversations of this project, from the SAME store read the `/resume` picker pages
 * (`listSessionPage`, scoped to the picker's working directory), so the tab lists exactly the conversations the picker would offer first, and
 * a row's id is the one `resumeChat` is asked for. Thin, like `agents-port.ts`: the store call, then the sanitizing floor.
 */

/** The most conversations the tab lists: one page of the store's own bound (the store caps a page at 100). */
export const SESSIONS_LIST_MAX = 20;

/** The longest title a row keeps, in code points; the row clips it to the screen's width when it is drawn. */
const TITLE_CHARS = 120;

/** A session's title as a label: scrubbed and bounded, and `Untitled` when it has none or nothing of it survives the scrub. */
function titleOf(title: string | undefined): string {
  const label = title === undefined ? '' : scrubbedBounded(title, TITLE_CHARS).trim();
  return label === '' ? 'Untitled' : label;
}

export interface SessionsPortDeps {
  /** The store's page read; the one the `/resume` picker uses. May throw (a store that cannot be read): the tab then says it cannot list. */
  readonly store: Pick<SessionStore, 'listSessionPage'>;
  /** The working directory the picker scopes to: discovery, never workspace authority. */
  readonly cwd: string;
  /** The wall clock, for the age a row shows. */
  readonly now: () => number;
}

/** The sessions list of the project: its newest page read now, every time, as rows whose labels are sanitized and whose ids are the store's. */
export function createSessionsPort(deps: SessionsPortDeps): SessionsPort {
  return {
    read: () => {
      const page = deps.store.listSessionPage({ limit: SESSIONS_LIST_MAX, workingDir: deps.cwd });
      const now = deps.now();
      return {
        rows: page.sessions.map(
          (session): SessionRow => ({
            id: session.id,
            title: titleOf(session.title),
            agent: scrubbedBounded(session.agentSlug),
            age: formatAgeOfIso(session.updatedAt, now),
          }),
        ),
        more: page.next !== undefined,
      };
    },
  };
}
