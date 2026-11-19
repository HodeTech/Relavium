/**
 * The bounds of the four chat limits, as data
 * ([ADR-0136](../../../docs/decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md) §1).
 *
 * One object read by the config schema (`[chat]` and the operator's `[preferences]`), by the session's own
 * admission check and by the documentation, so the loader, the engine and the docs cannot drift. A value outside its
 * bounds is a REJECTION, never a clamp ([ADR-0086](../../../docs/decisions/0086-absolute-admission-ceilings-on-authored-values.md) §1):
 * silently turning `max_turns = 5000` into 1,000 would debug the wrong thing. The lower bounds only exclude nonsense
 * (zero rounds); `max_tool_corrections` may be 0, which the engine already supports — the first round in which nothing
 * ran ends the turn.
 *
 * These bound a CHAT session. A workflow agent node and a one-shot `agent run` keep the engine's own defaults and read
 * nothing here.
 */

/** One limit: its inclusive bounds and the value used when no layer sets it. */
export interface ChatLimit {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export const CHAT_LIMITS = {
  /**
   * Tool rounds per interval **where a person can answer**: the turn pauses and asks to continue. Not read where
   * nobody can answer (that is `max_tool_turns`).
   */
  checkpoint_tool_turns: { min: 1, max: 256, default: 32 },
  /** Tool rounds in a turn **where nobody can answer**: a hard stop with `turn_limit`. */
  max_tool_turns: { min: 1, max: 256, default: 16 },
  /** Consecutive rounds in which no call ran to a result (ADR-0131): the turn tolerates this many corrections. */
  max_tool_corrections: { min: 0, max: 10, default: 3 },
  /** Turns per session. */
  max_turns: { min: 1, max: 1000, default: 50 },
} as const satisfies Record<string, ChatLimit>;

export type ChatLimitKey = keyof typeof CHAT_LIMITS;

/** The four keys, in documentation order. */
export const CHAT_LIMIT_KEYS: readonly ChatLimitKey[] = [
  'checkpoint_tool_turns',
  'max_tool_turns',
  'max_tool_corrections',
  'max_turns',
];

/** Whether `value` is an integer inside the bounds of `key`. */
export function isChatLimitInBounds(key: ChatLimitKey, value: number): boolean {
  const { min, max } = CHAT_LIMITS[key];
  return Number.isInteger(value) && value >= min && value <= max;
}
