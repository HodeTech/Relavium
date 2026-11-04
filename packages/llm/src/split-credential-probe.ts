/**
 * Package-internal support for `scrub-secrets.ts`'s LF/TAB split-credential scanner. It is not a
 * package export: the scanner's static rules are compiled once, at module load, into the probes this
 * file describes, and a rule that breaks the scanner's two hidden assumptions fails there — with a
 * typed error — instead of throwing a `SyntaxError` from inside `makeLlmError` on a later diagnostic.
 * It imports nothing, so the pure `@relavium/llm/scrub-secrets` leaf still reaches only `terminal-safe`
 * beyond its own package.
 */

export type SplitProbeInvariantCode = 'joined_form_required' | 'mixed_word_boundary';

/**
 * A static scrub rule violates a split-credential scanner invariant. A programming error, never
 * input-driven, and not an exported error family (like `UsageCoverageInvariantError`).
 */
export class SplitProbeInvariantError extends Error {
  readonly code: SplitProbeInvariantCode;

  constructor(code: SplitProbeInvariantCode) {
    super(`scrub rule violates the split-credential scanner invariant: ${code}`);
    this.name = 'SplitProbeInvariantError';
    this.code = code;
  }
}

/** A literal that every scanner match must reach within `window` joined characters of its start. */
export interface SplitProbeAnchor {
  readonly text: string;
  readonly window: number;
}

export interface SplitProbeRule {
  readonly pattern: RegExp;
  readonly joinedPattern?: RegExp;
  readonly boundary: RegExp;
  readonly anchor?: SplitProbeAnchor;
}

export interface SplitProbe {
  /** Non-global, so `test` carries no `lastIndex` state from one diagnostic to the next. */
  readonly preflight: RegExp;
  /** Sticky; every use sets `lastIndex` first. */
  readonly sticky: RegExp;
  /** The rule's boundary rejects every ASCII word character, so word-preceded starts can be skipped. */
  readonly wordBlocksStart: boolean;
  readonly anchor: SplitProbeAnchor | undefined;
}

const ASCII_WORD_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

/**
 * Compile one boundary-bearing rule. Two invariants are checked rather than assumed:
 *
 * - **A joined form exists.** The scanner probes a boundary-free form of the rule. A rule supplies
 *   it as `joinedPattern`, or its `pattern` begins with `\b`, which is stripped. Any other pattern
 *   would lose two real characters and become an invalid expression.
 * - **The boundary treats every ASCII word character alike.** The scanner skips word-preceded starts
 *   as a block when the boundary rejects word characters; a boundary that rejected only some of them
 *   would let the skip hide an eligible start.
 */
export function splitProbe(rule: SplitProbeRule): SplitProbe {
  const canonical = rule.joinedPattern ?? rule.pattern;
  if (rule.joinedPattern === undefined && !canonical.source.startsWith(String.raw`\b`)) {
    throw new SplitProbeInvariantError('joined_form_required');
  }
  const verdicts = new Set(
    Array.from(ASCII_WORD_CHARACTERS, (character) => rule.boundary.test(character)),
  );
  if (verdicts.size !== 1) throw new SplitProbeInvariantError('mixed_word_boundary');
  const source = rule.joinedPattern === undefined ? canonical.source.slice(2) : canonical.source;
  const flags = canonical.flags.replace('g', '');
  return {
    preflight: new RegExp(source, flags),
    sticky: new RegExp(source, `${flags}y`),
    wordBlocksStart: verdicts.has(true),
    anchor: rule.anchor,
  };
}
