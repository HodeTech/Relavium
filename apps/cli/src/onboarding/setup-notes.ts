/**
 * The words of a provider setup that more than one host speaks (the Home, a stand-alone chat, the wizard): which of the wizard's notes only
 * say what a step is, and the one line a skipped setup leaves behind. Plain data and two pure functions, so the hosts import them without
 * importing the wizard's prompt library.
 */

/**
 * The titles of the notes that say what a step IS (the first-run sentence, where the key goes), not what happened. They are shown above the
 * card while it is open and mean nothing once it has closed, so {@link leftoverSetupNote} never lets one of them stand as the notice the
 * Home or a stand-alone chat keeps after the setup (it did: after `Esc` the first-run sentence was the notice).
 */
export const FIRST_RUN_NOTE_TITLE = 'First-run setup';
export const DESTINATION_NOTE_TITLE = 'Provider destination';

/**
 * The note a setup flow left on its card, as the notice for the host to keep: `undefined` when it was only an instruction ({@link
 * FIRST_RUN_NOTE_TITLE}, {@link DESTINATION_NOTE_TITLE}), because a flow that ended without a result of its own says nothing and the
 * host speaks for it ({@link setupSkippedNotice}). A note that reports something (a config that could not be saved, a keychain that is
 * still unavailable) is kept.
 */
export function leftoverSetupNote(note: string | undefined): string | undefined {
  if (note === undefined || note === '') return undefined;
  const instruction = [FIRST_RUN_NOTE_TITLE, DESTINATION_NOTE_TITLE].some((title) =>
    note.startsWith(`${title}: `),
  );
  return instruction ? undefined : note;
}

/** The surfaces that open the native setup: the Home (which has `/providers`) and a stand-alone `relavium chat` (which has not). */
export type SetupSurface = 'home' | 'standalone-chat' | undefined;

/**
 * What a skipped first run says, in one line (MVP-11, ADR-0146 §6): that it was a skip, and how to come back to it. The same words whether
 * the skip came from `Esc`, `Ctrl+C` or the `Skip setup` row of a failed check.
 */
export function setupSkippedNotice(surface: SetupSurface): string {
  return surface === 'standalone-chat'
    ? 'Setup skipped · restart this chat to open provider setup any time'
    : 'Setup skipped · /providers connects a provider any time';
}
