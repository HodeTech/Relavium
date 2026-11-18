import { z } from 'zod';

import { utf8ByteLength } from './bytes.js';
import { SessionNonToolContentPartSchema, SessionToolMediaPartSchema } from './content.js';

/** ADR-0095/0098: the session-owned identity is independent of provider ids and completed-turn counts. */
export interface SessionToolCallIdentity {
  readonly turnKey: number;
  readonly slot: number;
}

export function parseSessionToolCallId(id: string): SessionToolCallIdentity | undefined {
  // Bound before matching: two safe integers need at most 16 decimal digits each.
  if (id.length > 46) return undefined;
  const match = /^session-tool:([1-9]\d*):(0|[1-9]\d*)$/.exec(id);
  if (match === null) return undefined;
  const turnKey = Number(match[1]);
  const slot = Number(match[2]);
  return Number.isSafeInteger(turnKey) && Number.isSafeInteger(slot)
    ? { turnKey, slot }
    : undefined;
}

export const SessionToolCallIdSchema = z
  .string()
  .refine(
    (id) => parseSessionToolCallId(id) !== undefined,
    'expected an engine-assigned session tool-call id',
  );

export function createSessionToolCallId(turnKey: number, slot: number): string {
  return SessionToolCallIdSchema.parse(`session-tool:${String(turnKey)}:${String(slot)}`);
}

/** The registry outcome supplies this name; syntax cannot itself prove registry membership. */
export const SessionToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
/** The one tool whose result row may carry a question record. */
export const SESSION_ASK_TOOL_NAME = 'ask_user';
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SessionToolCallPartSchema = z
  .object({
    type: z.literal('tool_call'),
    id: SessionToolCallIdSchema,
    name: SessionToolNameSchema,
    /** UTF-8 bytes of the JSON arguments the model issued; no raw arguments or digest. */
    argsBytes: byteCount,
  })
  .strict();
export type SessionToolCallPart = z.infer<typeof SessionToolCallPartSchema>;

/**
 * The ceilings a stored `ask_user` record keeps, in UTF-8 bytes. They equal the tool's argument bounds
 * (`ASK_USER_BOUNDS` in `@relavium/core`, pinned equal by a core test): a record is only ever a copy of what the card showed
 * and what the person chose, so the stored form can never be larger than the call that produced it.
 */
export const SESSION_ASK_BOUNDS = Object.freeze({
  headerBytes: 24,
  questionBytes: 150,
  labelBytes: 60,
  questionsPerRecord: 4,
  optionsPerQuestion: 4,
  /** The person's own text — one line, in code points. */
  ownTextCodePoints: 500,
});

// Control characters (a newline or an escape included), line and paragraph separators and unpaired surrogates have no
// place in a one-line stored string: the record is replayed into a model request and a terminal.
const ASK_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u;

const askText = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => utf8ByteLength(value) <= maxBytes, `at most ${String(maxBytes)} UTF-8 bytes`)
    .refine((value) => !ASK_FORBIDDEN.test(value), 'one line without control characters');

/** One question of a recorded `ask_user` call, with the person's answer to it (none when the call was skipped). */
export const SessionAskItemSchema = z
  .object({
    header: askText(SESSION_ASK_BOUNDS.headerBytes),
    /**
     * The question text — kept for an `answered` item, where the card necessarily showed it (every question must be answered
     * before a call can be sent). A `skipped` call stores none: Ctrl+S ends the whole call from any tab, so most of its
     * questions were never shown, and what the person never saw must not outlive the turn in a user-role request. A stored
     * skipped item that does carry one (a row written before this rule) is read, and ignored by every consumer.
     */
    question: askText(SESSION_ASK_BOUNDS.questionBytes).optional(),
    /** The option labels the person chose, in the order the question offered them. */
    selected: z
      .array(askText(SESSION_ASK_BOUNDS.labelBytes))
      .max(SESSION_ASK_BOUNDS.optionsPerQuestion)
      .optional(),
    /** The person's own text, already masked of secret-shaped runs by the engine. */
    other: z
      .string()
      .min(1)
      .refine(
        (value) => [...value].length <= SESSION_ASK_BOUNDS.ownTextCodePoints,
        `at most ${String(SESSION_ASK_BOUNDS.ownTextCodePoints)} code points`,
      )
      .refine((value) => !ASK_FORBIDDEN.test(value), 'one line without control characters')
      .optional(),
  })
  .strict();
export type SessionAskItem = z.infer<typeof SessionAskItemSchema>;

/**
 * What the person was asked and what they answered
 * ([ADR-0133](../../../docs/decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md)): the conversational
 * content of an `ask_user` call, kept so a later turn and a resumed session can ground on it. `answered` items carry a choice,
 * the person's own text, or both, with the question the card showed; `skipped` items carry only their header (the person
 * may have skipped before ever reaching the question). A call that showed no card is not recorded.
 */
export const SessionAskRecordSchema = z
  .object({
    status: z.enum(['answered', 'skipped']),
    items: z.array(SessionAskItemSchema).min(1).max(SESSION_ASK_BOUNDS.questionsPerRecord),
  })
  .strict()
  .superRefine((record, ctx) => {
    record.items.forEach((item, index) => {
      const chosen = (item.selected?.length ?? 0) + (item.other === undefined ? 0 : 1);
      const ok =
        record.status === 'answered' ? chosen > 0 : chosen === 0 && item.selected === undefined;
      if (!ok)
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message:
            record.status === 'answered'
              ? 'an answered question carries a choice or text'
              : 'a skipped question carries no answer',
        });
      if (record.status === 'answered' && item.question === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'question'],
          message: 'an answered question carries its question text',
        });
    });
  });
export type SessionAskRecord = z.infer<typeof SessionAskRecordSchema>;

export const SessionToolResultPartSchema = z
  .object({
    type: z.literal('tool_result'),
    toolCallId: SessionToolCallIdSchema,
    /** UTF-8 bytes of the bounded model-facing JSON result, not the full host result or event summary. */
    resultBytes: byteCount,
    outcome: z.enum(['ok', 'error', 'denied', 'cancelled']),
    media: z.array(SessionToolMediaPartSchema).optional(),
    /** ADR-0133: only an `ask_user` call that showed a card carries this; the pairing is checked with its call. */
    ask: SessionAskRecordSchema.optional(),
  })
  .strict();
export type SessionToolResultPart = z.infer<typeof SessionToolResultPartSchema>;

/** One completed dispatch; no provider id, model arguments or host result crosses this boundary. */
export const SessionToolHistoryEntrySchema = z
  .object({ call: SessionToolCallPartSchema, result: SessionToolResultPartSchema })
  .strict()
  .refine((entry) => entry.call.id === entry.result.toolCallId, 'tool identities must match')
  .refine(
    (entry) =>
      entry.result.ask === undefined ||
      (entry.call.name === SESSION_ASK_TOOL_NAME && entry.result.outcome === 'ok'),
    'only a successful ask_user call carries a question record',
  );
export type SessionToolHistoryEntry = z.infer<typeof SessionToolHistoryEntrySchema>;
export const SessionToolHistorySchema = z
  .array(SessionToolHistoryEntrySchema)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.call.id)).size === entries.length,
    'tool identities must be unique',
  );

/** Session-only persistence union; generic durable run/event/IPC content is deliberately unchanged. */
export const SessionContentPartSchema = z.union([
  SessionNonToolContentPartSchema,
  SessionToolCallPartSchema,
  SessionToolResultPartSchema,
]);
export type SessionContentPart = z.infer<typeof SessionContentPartSchema>;
