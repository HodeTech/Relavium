import type { ConsentPrompter, ConsentSubject } from '../engine/mcp-consent-gate.js';
import { CliError } from '../process/errors.js';
import type { NativeChordPort, NativePromptEscape } from '../render/tui/native-prompt-channel.js';
import { authorLine } from '../render/tui/run-card-model.js';

/**
 * The MCP consent card of a hosted leg
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4,
 * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7).
 *
 * It asks the person the shell's own question through the Home's native chord card instead of clack: `Ctrl+Y` allows, `Ctrl+N`,
 * `Esc` and `Ctrl+C` refuse, and a bare letter or a paste answers nothing (the chord card's guards, `chord-guard.ts`). Refusing is the
 * default and the card's only side effect is its decision: it returns a {@link ConsentDecision} and NEVER starts anything. What
 * follows an `allow` (the grant written to the per-machine log, the program started) belongs to the consent gate and its caller,
 * and a refusal reaches neither: the gate throws before it records or resolves a spawn, so nothing is started.
 *
 * **The words say what the grant is.** The gate writes an approved program to the per-machine grant log (`mcp-consent.ndjson`), and
 * the next invocation does not ask about the same declaration again. The card therefore says "on this machine" and never "for this
 * run": the ADR's table row that says "for this run" describes a narrower grant than the code writes, and a card that understated
 * what `Ctrl+Y` does would be a consent that is not informed.
 *
 * Every field of the subject arrives sanitized and bounded by the gate (`subjectOf`), and each path exactly as it is on disk or not at
 * all; each becomes its own row, never a joined shell string, so an argument boundary is a row boundary.
 *
 * **What a server's author wrote cannot pass for the card's own keys.** The text the declaration authors (the server's id and where it
 * is declared, the command as written, every argument, each environment name and value) is the text a hostile artifact controls, and
 * it sits on the same screen as the answer keys. It goes through the same scrub the run card's gate message does (`authorLine`: the
 * untrusted-text floor, folded so a chord cannot be spelled past the match, host glyphs and answer-chord tokens made inert), so no row
 * can read `Ctrl+Y refuses`. The text that IS the decision is shown as the gate composed it: the executable that will run, its
 * directory and the digest are paths and hex, and a path is never rewritten on its way to a consent.
 *
 * **A path that cannot be shown as it is, is refused, not rewritten (M1).** A repository ships the program it names, so the path of the
 * executable (or the directory it runs in, or the directory of an earlier approval) is as hostile as any argument: `./tools/Ctrl+Y
 * refuses this - Ctrl+N allows/srv` is a real path. Rewriting it would show the person a different program than the one that runs, and
 * showing it would put a forged key legend on the card. So a path the scrub would change (a control or invisible character, a host
 * glyph such as a box-drawing line, `✓` or `◐`, or an answer-chord token) is never put on a card at all: the card is not built, the
 * program is not offered, and the run is refused in fixed words that carry no path ({@link CONSENT_PATH_REFUSED}). A program that holds
 * a grant already is not asked about, so this never reaches it. The half of this that is not about keys (a control or invisible
 * character, a path past the gate's length bound) is the gate's: it refuses such a path before any prompter is called, the shell's
 * question included, in its own words (`CONSENT_PATH_UNSHOWN`, which name no command, since no prompt can approve such a path), because
 * a prompter only ever sees the gate's cleaned text and would otherwise name the visible twin of the file that runs. The half that is
 * about keys (a host glyph, an answer-chord token) is this card's alone, and the shell's question can still approve it: that question is
 * a plain yes or no that a path cannot forge.
 */

export type ConsentDecision = 'allow' | 'refuse';

/** What `Ctrl+Y` does, in the words of the grant the shell already writes. */
export const CONSENT_ALLOW_LABEL = 'Allow, and remember it on this machine';
export const CONSENT_REFUSE_LABEL = 'Refuse, and start nothing';

/** The card as the chord prompt takes it. */
export interface ConsentCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** What a start says when a program's path cannot be put on the card: fixed words, no path, and where it can be approved. */
export const CONSENT_PATH_REFUSED =
  'Not started: a local program has a path the card cannot show safely. Approve it with relavium run.';

/**
 * Whether the scrub would change `path`, ignoring only the normalization every comparison shares: a path the scrub leaves alone is one
 * the card shows exactly as it is (spaces, accents in either composition and compatibility forms included), and any other (a control or
 * invisible character, a host glyph, an answer-chord token) is one a hostile repository could use to draw its own key row.
 *
 * The gate hands the card a path only when its own sanitizer and bound would leave it unchanged and it holds no character that draws
 * nothing (`exactPath` in the gate), so the text checked here is the path on disk, not a cleaned twin of it: a check that ran on the
 * cleaned text passed `tools/srv` with a zero-width space as `tools/srv`. What is left for this check is what only a card must refuse:
 * a host glyph and an answer-chord token.
 */
function wouldBeRewritten(path: string): boolean {
  return authorLine(path) !== path.normalize('NFKC');
}

/** The label column of a detail row: wide enough for the longest label plus a space, so the values line up. */
const label = (name: string): string => name.padEnd(12);

/**
 * The card's text for one decision, from the same fields the shell's prompt shows. The question is the shell's, with where the grant
 * lives added; the rows follow the shell's order (server, artifact, executable, authored command, arguments, environment, directory,
 * digest, an earlier approval elsewhere).
 */
export function consentCardText(subject: ConsentSubject): ConsentCardText {
  // Before a single row is built: a card with a forged path is never made (M1).
  if (
    [subject.resolvedCommand, subject.cwd, subject.previouslyApprovedIn].some(
      (path) => path !== undefined && wouldBeRewritten(path),
    )
  )
    throw new CliError('invalid_invocation', CONSENT_PATH_REFUSED);
  const details = [
    subject.total > 1
      ? `Program ${String(subject.index)} of ${String(subject.total)}`
      : 'This artifact wants to start a local program.',
    `${label('server')}${authorLine(subject.serverId)} (${authorLine(subject.provenance)})`,
  ];
  if (subject.artifact !== undefined)
    details.push(`${label('declared in')}${authorLine(subject.artifact)}`);
  details.push(`${label('executable')}${subject.resolvedCommand}`);
  if (subject.authoredCommand !== undefined)
    details.push(`${label('as written')}${authorLine(subject.authoredCommand)}`);
  details.push(
    ...subject.args.map((argument) => `${label('argument')}${authorLine(argument)}`),
    ...subject.env.map(
      ([name, value]) => `${label('env')}${authorLine(name)}=${authorLine(value)}`,
    ),
    `${label('directory')}${subject.cwd}`,
    `${label('digest')}${subject.digest}`,
  );
  if (subject.previouslyApprovedIn !== undefined)
    details.push(`(you approved this same program in ${subject.previouslyApprovedIn})`);
  return {
    message: `Allow MCP server '${authorLine(subject.serverId)}' to run this program on this machine?`,
    details,
    allow: CONSENT_ALLOW_LABEL,
    deny: CONSENT_REFUSE_LABEL,
  };
}

/**
 * Ask. Only a `Ctrl+Y` the chord card accepted is `allow`; `Ctrl+N`, `Esc` (a step back or a cancel), `Ctrl+C` and a flow that was
 * cancelled under the card are all `refuse`, as is a signal that has already aborted (no card is opened for it) or that aborts while the
 * card is open (the card closes, so a stopped leg is not left waiting on a question nobody can answer).
 */
export async function askConsent(
  port: NativeChordPort,
  subject: ConsentSubject,
  options?: { readonly signal?: AbortSignal; readonly escape?: NativePromptEscape },
): Promise<ConsentDecision> {
  if (options?.signal?.aborted === true) return 'refuse';
  const text = consentCardText(subject);
  const answer = await port.chord({
    message: text.message,
    details: text.details,
    allow: text.allow,
    deny: text.deny,
    escape: options?.escape ?? 'cancel',
    // The card closes with the work it asks about: a leg that is stopped while it waits must not leave it open.
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  return answer === 'allow' ? 'allow' : 'refuse';
}

/** The consent gate's prompter, answered by the native card: `true` only on an `allow`. */
export function createNativeConsentPrompter(
  port: NativeChordPort,
  options?: { readonly escape?: NativePromptEscape },
): ConsentPrompter {
  return async (subject, promptOptions) =>
    (await askConsent(port, subject, {
      ...(promptOptions?.signal === undefined ? {} : { signal: promptOptions.signal }),
      ...(options?.escape === undefined ? {} : { escape: options.escape }),
    })) === 'allow';
}
