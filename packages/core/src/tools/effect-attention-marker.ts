/** Internal error identity, so receipt observation never reflects a host's thrown value. */
const attentionErrors = new WeakSet<object>();

export function markEffectAttentionError(error: object): void {
  attentionErrors.add(error);
}

export function isMarkedEffectAttentionError(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    attentionErrors.has(error)
  );
}
