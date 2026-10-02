import { z } from 'zod';

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

export const SessionToolResultPartSchema = z
  .object({
    type: z.literal('tool_result'),
    toolCallId: SessionToolCallIdSchema,
    /** UTF-8 bytes of the bounded model-facing JSON result, not the full host result or event summary. */
    resultBytes: byteCount,
    outcome: z.enum(['ok', 'error', 'denied', 'cancelled']),
    media: z.array(SessionToolMediaPartSchema).optional(),
  })
  .strict();
export type SessionToolResultPart = z.infer<typeof SessionToolResultPartSchema>;

/** Session-only persistence union; generic durable run/event/IPC content is deliberately unchanged. */
export const SessionContentPartSchema = z.union([
  SessionNonToolContentPartSchema,
  SessionToolCallPartSchema,
  SessionToolResultPartSchema,
]);
export type SessionContentPart = z.infer<typeof SessionContentPartSchema>;
