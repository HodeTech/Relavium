import { z } from 'zod';

export const PreparedReplayOperation = z.enum(['edit', 'append', 'overwrite', 'create']);
export const PreparedReplayCut = z.enum(['after-claim', 'after-publication', 'after-settle']);
export const PreparedReplayVariant = z.enum(['same', 'mismatch', 'malformed', 'reordered']);
export type ReplayOperation = z.infer<typeof PreparedReplayOperation>;
export type ReplayCut = z.infer<typeof PreparedReplayCut>;
export type ReplayVariant = z.infer<typeof PreparedReplayVariant>;
export const PreparedReplayReceipt = z
  .object({
    pid: z.number().int().positive(),
    stage: z.enum(['cut', 'resume']),
    operation: PreparedReplayOperation,
    cut: PreparedReplayCut,
    runId: z.string().min(1),
    gateId: z.string().min(1),
    preparations: z.number().int().nonnegative(),
    executionCalls: z.number().int().nonnegative(),
    publications: z.number().int().nonnegative(),
    settlements: z.number().int().nonnegative(),
    providerCalls: z.number().int().nonnegative(),
    agentExecutions: z.number().int().nonnegative(),
    deliveredResultJson: z
      .string()
      .max(16 * 1024)
      .optional(),
    status: z.enum(['completed', 'failed']).optional(),
    code: z.string().optional(),
  })
  .strict();
