import type { z } from 'zod';

/** Shared by payload and event validators; a released invocation has no later receipt authority. */
export function refineUsageDispositionReceipt(
  payload: {
    readonly disposition: { readonly kind: string };
    readonly receiptPending?: true | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (payload.receiptPending === true && payload.disposition.kind !== 'incomplete')
    ctx.addIssue({
      code: 'custom',
      path: ['receiptPending'],
      message: 'receiptPending requires an incomplete disposition',
    });
}
