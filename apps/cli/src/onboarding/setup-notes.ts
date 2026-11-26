/**
 * The words of a provider setup that more than one host speaks (the Home, a stand-alone chat, the setup itself): which of the setup's notes
 * only say what a step is, the one line a skipped or closed setup leaves behind, and the sentences of the key step (ADR-0146 §6) built from the
 * provider table. Plain data and pure functions (a fenced data module), so the hosts import them without importing the setup. Every value a
 * caller puts in one of these sentences (a provider's name, a host, a variable, a model) is passed in already scrubbed: these functions only
 * compose.
 */

import type { Surface } from '../render/surface.js';

/**
 * The titles of the notes that say what a step IS (the first-run sentence, where the key goes), not what happened. They are shown above the
 * card while it is open and mean nothing once it has closed, so {@link leftoverSetupNote} never lets one of them stand as the notice the
 * Home or a stand-alone chat keeps after the setup (it did: after `Esc` the first-run sentence was the notice).
 */
export const FIRST_RUN_NOTE_TITLE = 'First-run setup';
export const DESTINATION_NOTE_TITLE = 'Provider destination';

/** The fixed start of the key step's note ({@link keyStepNote}): an instruction, never kept as a notice. */
export const KEY_STEP_NOTE_PREFIX = 'Stored in your OS keychain, never on disk.';

/**
 * What the key step says about the key before it is pasted (ADR-0146 §6, G20): where it is kept and the one place it is sent. `host` is the
 * origin that will receive it, as the provider resolver pinned it (a stored custom endpoint changes it).
 */
export function keyStepNote(host: string): string {
  return `${KEY_STEP_NOTE_PREFIX} Sent only to ${host}, once, to check it.`;
}

/** The key step's wait while the key is checked (G20): the request is disclosed in words, with the host it goes to. */
export function keyCheckText(provider: string, host: string): string {
  return `Checking your ${provider} key · one request to ${host}`;
}

/** What the key step names when the resolver cannot say which origin the key would go to (a refused custom endpoint): never a guess. */
export const UNKNOWN_KEY_HOST = 'the configured endpoint';

/** The next step a connected Home names (ADR-0146 §6, G18): `/init` is named, never offered. */
export const SETUP_NEXT_STEP = 'Type a message to start, or /init to set up this folder';

/**
 * The note a setup flow left on its card, as the notice for the host to keep: `undefined` when it was only an instruction ({@link
 * FIRST_RUN_NOTE_TITLE}, {@link DESTINATION_NOTE_TITLE}, the key step's {@link keyStepNote}), because a flow that ended without a result of
 * its own says nothing and the host speaks for it ({@link setupSkippedNotice}). A note that reports something (a config that could not be
 * saved, a keychain that is still unavailable) is kept.
 */
export function leftoverSetupNote(note: string | undefined): string | undefined {
  if (note === undefined || note === '') return undefined;
  const instruction =
    [FIRST_RUN_NOTE_TITLE, DESTINATION_NOTE_TITLE].some((title) => note.startsWith(`${title}: `)) ||
    note.startsWith(KEY_STEP_NOTE_PREFIX);
  return instruction ? undefined : note;
}

/** The surfaces that open the native setup: the Home (which has `/providers`) and a stand-alone `relavium chat` (which has not). */
export type SetupSurface = Extract<Surface, 'home' | 'standalone-chat'>;

/**
 * What a skipped first run says, in one line (MVP-11, ADR-0146 §6): that it was a skip, and how to come back to it. On the Home it is the line
 * of a REMEMBERED skip (`Esc` on the popup's first step, or the `Skip setup` row of a failed check, written to the global config): the popup
 * does not open by itself again, and `/providers` is the way back, so it says nothing of "for now" or "next launch". On a stand-alone chat's
 * card, which remembers nothing, it is the line of every way out, and names the way back there. On the Home it is one NOTIFICATION, so it fits
 * the 54 columns a notification has inside a popup at 80×24 (`POPUP_NOTICE_MAX_COLUMNS`): `anytime`, where the ADR's sentence has `any time`
 * (55 columns).
 */
export function setupSkippedNotice(surface: SetupSurface | undefined): string {
  return surface === 'standalone-chat'
    ? 'Setup skipped · restart this chat to open provider setup any time'
    : 'Setup skipped · /providers connects a provider anytime';
}

/**
 * The Home's one notification when an `Esc` skip could not be remembered: the global config exists (a skip never rewrites it, which would
 * strip a hand-made file's comments and order) or cannot be written. The popup opens by itself again at the next launch.
 */
export const SETUP_SKIP_NOT_SAVED = 'Setup skipped · not saved, it opens again next launch';

/**
 * What the Home says when its automatic first run was LEFT without a skip being remembered (`Ctrl+C`, `Not now` on the environment-key consent
 * or the keychain step, a cancelled key check): nothing was stored and nothing written, so the popup opens by itself again at the next launch
 * (MVP-11 unit 6, C-F5). On a stand-alone chat's card it is the card's one skip line ({@link setupSkippedNotice}), which says the same there.
 */
export function setupClosedNotice(surface: SetupSurface | undefined): string {
  return surface === 'standalone-chat'
    ? setupSkippedNotice(surface)
    : 'Setup closed · it opens again next launch';
}

/** What a configuration write says when it was saved but its durability after a crash could not be confirmed. */
export const SAVED_UNCONFIRMED = 'Saved, but persistence after a crash is unconfirmed.';
