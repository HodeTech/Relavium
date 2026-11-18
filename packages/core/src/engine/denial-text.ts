import type { ToolDenialClass } from '../tools/types.js';

/**
 * The model-facing text of a refusal that returns to the model
 * ([ADR-0117](../../../../docs/decisions/0117-a-denied-tool-call-returns-to-the-model.md) §2).
 *
 * **One fixed text per class, identical for every target state.** A class that cannot meet that — an SSRF
 * refusal, a confidentiality refusal — never reaches this module: it stays fatal, because its wording could
 * otherwise map which targets exist. The only variable parts are (a) the user's own typed words and (b) the
 * mode's fixed label, both supplied by the host and bounded here; neither depends on the target.
 *
 * The texts are also listed beside the tool contracts in `docs/reference/shared-core/built-in-tools.md`, which
 * is their canonical home; keep the two in step.
 */

/** The longest explanation that is echoed back to the model (code points). */
export const DENIAL_EXPLANATION_MAX = 300;

/** The text for a repeat of an invocation the user already declined in this turn (ADR-0117 §3). */
export const REPEATED_DENIAL_TEXT =
  'The user already declined an identical call in this turn, so it was not run again. ' +
  'Nothing was run or changed. Propose something different, or ask the user what they prefer.';

// Control characters, bidirectional overrides and line separators are replaced with a space; the host
// already sanitised the text for display, so this is a second, independent bound on what reaches a model.
// U+2028/U+2029 are built from code points: a literal one inside a regex source is a line terminator.
const LINE_SEPARATORS = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
const UNSAFE_EXPLANATION = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${LINE_SEPARATORS}\\u202a-\\u202e\\u2066-\\u2069]+`,
  'gu',
);

/** Bound and flatten a host-supplied explanation to one short line; `undefined` when nothing is left. */
export function boundedExplanation(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(UNSAFE_EXPLANATION, ' ').trim();
  if (flat.length === 0) return undefined;
  const points = [...flat];
  return points.length > DENIAL_EXPLANATION_MAX
    ? `${points.slice(0, DENIAL_EXPLANATION_MAX).join('')}…`
    : flat;
}

/** The fixed tool-result text for one refusal class, with the host's bounded explanation where it adds one. */
export function denialResultText(
  denialClass: ToolDenialClass,
  explanation: string | undefined,
): string {
  const detail = boundedExplanation(explanation);
  switch (denialClass) {
    case 'user':
      return (
        'The user declined this tool call. Nothing was run or changed, and the call must not be repeated. ' +
        'Suggest a different approach, or ask the user what they prefer.' +
        (detail === undefined ? '' : ` The user's reason: "${detail}"`)
      );
    case 'mode':
      return (
        `This action is not available in the current mode${detail === undefined ? '' : ` (${detail})`}. ` +
        'Nothing was run or changed. Describe what you would do, so the user can switch modes or do it themselves.'
      );
    case 'unavailable':
      return (
        'No one is available to approve this action in this session, so it was not run. ' +
        'Nothing was changed. Continue without it, or describe what you would have done.'
      );
  }
}
