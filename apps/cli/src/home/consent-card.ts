import type { ConsentPrompter, ConsentSubject } from '../engine/mcp-consent-gate.js';
import type { NativeChordPort, NativePromptEscape } from '../render/tui/native-prompt-channel.js';

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
 * Every field of the subject arrives sanitized and bounded by the gate (`subjectOf`); each becomes its own row, never a joined
 * shell string, so an argument boundary is a row boundary.
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

/** The label column of a detail row: wide enough for the longest label plus a space, so the values line up. */
const label = (name: string): string => name.padEnd(12);

/**
 * The card's text for one decision, from the same fields the shell's prompt shows. The question is the shell's, with where the grant
 * lives added; the rows follow the shell's order (server, artifact, executable, authored command, arguments, environment, directory,
 * digest, an earlier approval elsewhere).
 */
export function consentCardText(subject: ConsentSubject): ConsentCardText {
  const details = [
    subject.total > 1
      ? `Program ${String(subject.index)} of ${String(subject.total)}`
      : 'This artifact wants to start a local program.',
    `${label('server')}${subject.serverId} (${subject.provenance})`,
  ];
  if (subject.artifact !== undefined) details.push(`${label('declared in')}${subject.artifact}`);
  details.push(`${label('executable')}${subject.resolvedCommand}`);
  if (subject.authoredCommand !== undefined)
    details.push(`${label('as written')}${subject.authoredCommand}`);
  details.push(
    ...subject.args.map((argument) => `${label('argument')}${argument}`),
    ...subject.env.map(([name, value]) => `${label('env')}${name}=${value}`),
    `${label('directory')}${subject.cwd}`,
    `${label('digest')}${subject.digest}`,
  );
  if (subject.previouslyApprovedIn !== undefined)
    details.push(`(you approved this same program in ${subject.previouslyApprovedIn})`);
  return {
    message: `Allow MCP server '${subject.serverId}' to run this program on this machine?`,
    details,
    allow: CONSENT_ALLOW_LABEL,
    deny: CONSENT_REFUSE_LABEL,
  };
}

/**
 * Ask. Only a `Ctrl+Y` the chord card accepted is `allow`; `Ctrl+N`, `Esc` (a step back or a cancel), `Ctrl+C` and a flow that was
 * cancelled under the card are all `refuse`, as is a signal that has already aborted (no card is opened for it).
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
