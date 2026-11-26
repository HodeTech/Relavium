import type {
  SessionPage,
  SessionStore,
  SessionPageCursor,
  SessionPageOptions,
} from '@relavium/db';
import type { NativePromptFlow, NativePromptOption } from '../render/tui/native-prompt-channel.js';
import {
  NATIVE_PICKER_PAGE_SIZE,
  type NativePickerOptions,
  type NativePickerResult,
} from '../render/tui/native-picker.js';
import { formatAgeOfIso, type DisplayPathRoots } from '../render/notation.js';
import { flowLine } from '../render/tui/flow-text.js';
import { placeForDisplay } from '../render/tui/place-label.js';
import { framedFlow, type FramedFlow } from './framed-flow.js';

/**
 * The `/resume` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3; MVP-11
 * unit 6): `/resume` on its top edge, its origin (`from Home`, or `from chat` over the chat the Home hosts), and a rail of two steps, the
 * session ({@link runSessionPicker}) and its restore (a wait, `Restoring session…`, and the retry question of a history that could not be read).
 * One frame holds both: the Home opens it before the picker and closes it after the restore, so nothing closes between the two and the opening
 * settle runs once. There is no Done step: a resume writes nothing, and the conversation that opens is its result. The rail stays where the
 * flow puts it. Never used on the stand-alone chat's pre-chat card, which has no popup slot (`relavium chat resume`'s picker is the raw flow).
 */
export function resumePopup(flow: NativePromptFlow, origin: 'home' | 'chat'): FramedFlow {
  return framedFlow(flow, {
    title: '/resume',
    origin,
    stepNames: ['Session', 'Restore'],
    progress: 'manual',
  });
}
/** The steps of {@link resumePopup}. */
export const RESUME_STEP = { session: 0, restore: 1 } as const;
/** What the restore step says while it runs; its legend says what `Esc` does (`Esc cancels it`). */
export const RESUME_RESTORING = 'Restoring session…';
/** What the Home says when a session of another directory is picked: the one notification a resume of it leaves (the legend golden records this very string). */
export const RESUME_ANOTHER_DIRECTORY = 'This session is in another directory: open Home there';

/**
 * The columns a row's directory line may take: the picker is drawn at 80 columns or wider (a narrower terminal is refused), and the line
 * is indented two. A longer directory is cut at the FRONT, so its end (the part that tells one directory from another) stays.
 */
const PICKER_PLACE_COLUMNS = 78;

export interface SessionPickerDeps {
  readonly store: Pick<SessionStore, 'listSessionPage'>;
  readonly cwd: string;
  /**
   * What the "All directories" scope names each session's directory against (the project and the home, ADR-0145 §8): `~/other`,
   * `packages/app`, `. (project root)`. Absent, the directory is drawn as it is stored; both hosts pass it.
   */
  readonly paths?: DisplayPathRoots | undefined;
  readonly now: () => number;
  readonly assertAdmitting: () => void;
  /** Own every actual read, including a stale or cancelled one, until it settles. */
  readonly runRead: (operation: () => Promise<NativePickerResult>) => Promise<NativePickerResult>;
}

/**
 * A session's row as the picker draws it: its title (or `Untitled — <agent>`) and its age, and in the "All directories" scope its directory.
 * The title, the agent's slug and the directory are words a person or a project wrote, so each goes through the full scrub of a Home flow
 * (`flowLine`: `flowText`, and its line separators folded, because the stand-alone `relavium chat resume` card draws these rows UNFRAMED, where a
 * U+2028 or U+2029 would break one row in two: MVP-11 unit 6, round 1: S7) before it reaches the channel ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, ADR-0145 §5): a title that reads `Press Ctrl+Y now` or carries a legend separator or a key token cannot draw the popup's own words. The
 * ` · ` before the age is the picker's own.
 */
function sessionRow(
  session: SessionPage['sessions'][number],
  deps: Pick<SessionPickerDeps, 'paths'>,
  now: number,
  allDirectories: boolean,
): NativePromptOption {
  const named =
    session.title === undefined
      ? `Untitled — ${flowLine(session.agentSlug)}`
      : flowLine(session.title);
  return {
    value: session.id,
    label: `${named} · ${formatAgeOfIso(session.updatedAt, now)}`,
    // The directory is scrubbed before it is shortened: the ellipsis of a cut is the picker's own (the scrub would blank it as a host glyph).
    ...(allDirectories
      ? { hint: placeForDisplay(flowLine(session.workingDir), deps.paths, PICKER_PLACE_COLUMNS) }
      : {}),
  };
}

/** Cursor closures retain no earlier pages or transcripts. Scope is discovery, never workspace authority. */
export function createSessionPickerSource(deps: SessionPickerDeps): NativePickerOptions['load'] {
  return (query, allDirectories, signal) => {
    const readPage = (
      cursor?: SessionPageCursor,
      direction?: SessionPageOptions['direction'],
    ): Promise<NativePickerResult> =>
      deps.runRead(() =>
        Promise.resolve().then((): NativePickerResult => {
          try {
            deps.assertAdmitting();
            signal.throwIfAborted();
            const page = deps.store.listSessionPage({
              limit: NATIVE_PICKER_PAGE_SIZE,
              title: query,
              ...(allDirectories ? {} : { workingDir: deps.cwd }),
              ...(cursor === undefined ? {} : { cursor }),
              ...(direction === undefined ? {} : { direction }),
            });
            signal.throwIfAborted();
            deps.assertAdmitting();
            const now = deps.now();
            return {
              options: page.sessions.map((session) =>
                sessionRow(session, deps, now, allDirectories),
              ),
              ...(page.next === undefined ? {} : { next: () => readPage(page.next, 'forward') }),
              ...(page.previous === undefined
                ? {}
                : { previous: () => readPage(page.previous, 'backward') }),
            };
          } catch {
            // Expected discovery/SQLite faults have a fixed retry/return card; no raw cause enters the UI.
            return { unavailable: true };
          }
        }),
      );
    return readPage();
  };
}

/**
 * The picker as a stage of a flow: it begins and ends `flow` itself, so it stands alone on the stand-alone chat's pre-chat card (the raw
 * flow) and, inside the Home's `/resume` popup, nests in the popup's own begin and end (`framedFlow`), which keeps ONE frame from the picker to
 * the restore it leads to. The picker is on the step the popup is on.
 */
export async function runSessionPicker(
  deps: SessionPickerDeps & { readonly flow: Pick<NativePromptFlow, 'begin' | 'end' | 'pick'> },
): Promise<string | undefined> {
  deps.assertAdmitting();
  const signal = deps.flow.begin();
  try {
    const choice = await deps.flow.pick({
      message: 'Resume a session',
      load: createSessionPickerSource(deps),
    });
    if (typeof choice !== 'string' || signal.aborted) return undefined;
    deps.assertAdmitting();
    return choice;
  } finally {
    await deps.flow.end();
  }
}
