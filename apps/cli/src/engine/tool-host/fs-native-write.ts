import { ToolDispatchError } from '@relavium/core/tool-dispatch-error';
import type { AbortSignalLike } from '@relavium/shared';

import type { NativeMetadataWriteAdapter } from './fs-native-metadata.js';

interface NativeStageInput {
  readonly adapter: NativeMetadataWriteAdapter;
  readonly prepared: unknown;
  readonly before: Buffer | null;
  readonly after: Buffer;
  readonly home: string;
  readonly nonce: string;
  readonly stageMask: number | undefined;
  readonly creationMask: () => Promise<number | undefined>;
  readonly signal?: AbortSignalLike;
}

const PRIMARY = [
  'none',
  'unsupported',
  'access_denied',
  'changed',
  'cancelled',
  'possibly_published',
  'legacy_recovery_required',
  'unknown',
] as const;
const CLEANUP = ['not_needed', 'proven', 'uncertain'] as const;
interface NativeWriteFailureFacts {
  readonly primary: (typeof PRIMARY)[number];
  readonly cleanup: (typeof CLEANUP)[number];
}
const unknownFacts: NativeWriteFailureFacts = Object.freeze({
  primary: 'unknown',
  cleanup: 'uncertain',
});
const failureFacts = new WeakMap<object, NativeWriteFailureFacts>();
/** Host-private inspection; these facts never become error fields, causes or public diagnostics. */
export function nativeWriteFailureFacts(error: unknown): NativeWriteFailureFacts | undefined {
  return typeof error === 'object' && error !== null ? failureFacts.get(error) : undefined;
}
function readNativeFacts(error: unknown): NativeWriteFailureFacts {
  try {
    if (typeof error !== 'object' || error === null) return unknownFacts;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    const message: unknown = descriptor?.value;
    if (typeof message !== 'string' || message.length > 96) return unknownFacts;
    for (const primary of PRIMARY)
      for (const cleanup of CLEANUP)
        if (message === `RELAVIUM_NATIVE_WRITE:${primary}:${cleanup}`) return { primary, cleanup };
  } catch {
    // Hostile reflection grants no native failure facts.
  }
  return unknownFacts;
}

/** A dispatched native write has no safe retry or mode-switch remedy, including cleanup failure. */
class NativeWriteNeedsAttentionError extends ToolDispatchError {
  readonly code = 'execution_failed';
  readonly runErrorCode = 'effect_needs_attention';
  readonly retryable = false;

  constructor(facts: NativeWriteFailureFacts = unknownFacts) {
    super(
      'filesystem write or cleanup could not be confirmed; check the target before repeating it',
      undefined,
      undefined,
      false,
    );
    this.name = 'NativeWriteNeedsAttentionError';
    failureFacts.set(this, Object.freeze(facts));
  }
}

/** Fixed post-claim refusal; private facts never grant settlement or retry authority. */
export function nativeWriteAttentionFailure(error?: unknown): ToolDispatchError {
  return new NativeWriteNeedsAttentionError(
    nativeWriteFailureFacts(error) ?? readNativeFacts(error),
  );
}

/** Own the stage, mask child, publication and cleanup until their native producers settle. */
export async function runNativeStage(input: NativeStageInput): Promise<void> {
  const { adapter, signal } = input;
  let cancellation: unknown;
  try {
    cancellation = adapter.createWriteCancellation();
  } catch (error) {
    throw nativeWriteAttentionFailure(error);
  }
  let stage: unknown;
  let hasStage = false;
  let failed = false;
  let facts: NativeWriteFailureFacts | undefined;
  const cancel = (): void => {
    try {
      adapter.cancelWrite(cancellation);
    } catch (error) {
      facts ??= readNativeFacts(error);
      // Abort listeners must not throw native text outside this owned operation.
      failed = true;
    }
  };
  const checkCancellation = (): void => {
    if (signal?.aborted === true) cancel();
    if (failed) throw new NativeWriteNeedsAttentionError();
  };
  signal?.addEventListener('abort', cancel);
  try {
    checkCancellation();
    const stageMask = input.stageMask;
    stage =
      input.before === null
        ? await adapter.stageNewMetadata(
            input.prepared,
            input.home,
            input.after,
            input.nonce,
            stageMask,
            cancellation,
          )
        : await adapter.stageExistingMetadata(
            input.prepared,
            input.home,
            input.before,
            input.after,
            input.nonce,
            stageMask,
            cancellation,
          );
    hasStage = true;
    checkCancellation();
    const publishMask = await input.creationMask();
    checkCancellation();
    await adapter.publishMetadata(stage, publishMask, cancellation);
  } catch (error) {
    facts ??= nativeWriteFailureFacts(error) ?? readNativeFacts(error);
    // Native exception text can expose metadata or paths. Publication may have
    // occurred, so this is always fatal and never treated as a retry hint.
    failed = true;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (hasStage) {
      try {
        await adapter.releaseMetadataStage(stage);
      } catch (error) {
        const cleanupFacts = readNativeFacts(error);
        facts = { primary: facts?.primary ?? cleanupFacts.primary, cleanup: 'uncertain' };
        failed = true;
      }
    }
  }
  if (failed) throw new NativeWriteNeedsAttentionError(facts);
}
