/**
 * Common native Error ancestry for owned production error families.
 *
 * This base adds no message, name, discriminant, context, cause or serialization policy.
 * Native constructor forwarding preserves each existing family's contract. Membership alone
 * is neither a safe public diagnostic nor an authority/foreign-bundle classification guard;
 * consumers retain their existing typed or structural boundary checks.
 */
export abstract class RelaviumError extends Error {}
