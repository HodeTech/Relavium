import type { DisplayPathRoots } from '../render/notation.js';
import { sanitizeInline } from '../render/sanitize.js';
import { blankMarkerGlyphs } from '../render/tui/glyphs.js';
import { PROJECT_ROOT_WORDS, placeForDisplay } from '../render/tui/place-label.js';

/** The columns the directory of the banner may take: the banner is one line of the transcript, and the id and the agent come first. */
const BANNER_PLACE_COLUMNS = 48;

/**
 * A stored string made safe for the banner: the inline sanitiser, then the glyphs of the speaker marker blanked (ADR-0145 §6). The inline renderer
 * writes the banner to the terminal before Ink mounts, so it never passes the transcript's row guard, and the host's own `›`, `▸` and `⇄` must not
 * be drawable by a session id or a directory name (the same rule as the ids of the model-switch notice).
 */
const safeForBanner = (text: string): string => blankMarkerGlyphs(sanitizeInline(text));

/**
 * Where the resumed session lives, as the banner says it ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8): the
 * directory the session was started in, shortened against the directory the person launched from and their home. A resumed chat is anchored to
 * its own directory, not to the one it was resumed from, so its commands run THERE; the banner is the one place that says so before the first
 * command card does. The directory the person is already in is `this directory`, not `. (project root)`: a banner is a sentence.
 */
function resumePlace(directory: string, launchRoots: DisplayPathRoots): string {
  const place = placeForDisplay(directory, launchRoots, BANNER_PLACE_COLUMNS, safeForBanner);
  return place === PROJECT_ROOT_WORDS ? 'this directory' : place;
}

/**
 * The line a resumed chat opens with. The session id is stored text (`history.db` accepts any non-empty string), so it passes the inline
 * sanitiser before it reaches the terminal; the directory is shortened first and made safe by {@link placeForDisplay}. The last words are the
 * ones the idle hint uses (`type /exit to end`), so the two places that say how to leave say it the same way.
 */
export function resumeIntro(input: {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turns: number;
  /** The directory the session was started in (its workspace anchor). */
  readonly directory: string;
  /** What the directory is shortened against: the directory the resume was launched from, and the home. */
  readonly launchRoots: DisplayPathRoots;
}): string {
  const turns = `${String(input.turns)} prior ${input.turns === 1 ? 'turn' : 'turns'}`;
  return `Resuming session ${safeForBanner(input.sessionId)} — ${input.agentId}, ${turns}, in ${resumePlace(input.directory, input.launchRoots)}. Type a message, or /exit to end.`;
}
