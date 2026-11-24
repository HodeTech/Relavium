import type { SessionStore, SessionPageCursor, SessionPageOptions } from '@relavium/db';
import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import {
  NATIVE_PICKER_PAGE_SIZE,
  type NativePickerOptions,
  type NativePickerResult,
} from '../render/tui/native-picker.js';
import { formatAgeOfIso, type DisplayPathRoots } from '../render/notation.js';
import { placeForDisplay } from '../render/tui/place-label.js';

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
              options: page.sessions.map((session) => ({
                value: session.id,
                label: `${session.title ?? `Untitled — ${session.agentSlug}`} · ${formatAgeOfIso(session.updatedAt, now)}`,
                ...(allDirectories
                  ? { hint: placeForDisplay(session.workingDir, deps.paths, PICKER_PLACE_COLUMNS) }
                  : {}),
              })),
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

export async function runSessionPicker(
  deps: SessionPickerDeps & { readonly flow: NativePromptFlow },
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
