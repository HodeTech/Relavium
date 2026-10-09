import {
  effectScope,
  type EffectCorrelation,
  type EffectDispatchPort,
  type EffectIdentity,
  type EffectTier,
} from '@relavium/shared';

import { isMarkedEffectAttentionError } from '../tools/effect-attention-marker.js';
import type { NodeOutcome } from './node-executor.js';

const nativeThen: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;

/**
 * Internal ADR-0103 semantic observation, independent of terminalError and consume-once joins.
 * It retains identities/tier only, never arguments, results or private thrown values. Pending
 * admissions become final attention only after the execution has joined every registered lifetime.
 */
export class EffectReceiptHealth {
  readonly #pending = new Map<string, EffectTier>();
  #stickyAttention = false;

  /** Read only at a host-safe final claim; a transferred child can still resolve a pending row. */
  get needsAttention(): boolean {
    return this.#stickyAttention || [...this.#pending.values()].some((tier) => tier === 3);
  }

  /** Engine-owned effect admission refusals remain attention even without an executor outcome. */
  requireAttention(): void {
    this.#stickyAttention = true;
  }

  /** Known typed failures survive caller catches and cancellation mapping without inspecting causes. */
  observeFailure(error: unknown): void {
    if (isMarkedEffectAttentionError(error)) this.#stickyAttention = true;
  }

  /** The raw executor's typed outcome still counts if the bounded owner has already stopped waiting. */
  observeOutcome(outcome: NodeOutcome): void {
    if (outcome.kind === 'failed' && outcome.error.code === 'effect_needs_attention') {
      this.#stickyAttention = true;
    }
  }

  /** Observe before returning the exact Promise to its existing owner/lifetime registry. */
  invocation<T>(factory: () => Promise<T>, onValue?: (value: T) => void): Promise<T> {
    let raw: Promise<T>;
    try {
      raw = factory();
    } catch (error) {
      this.observeFailure(error);
      throw error;
    }
    this.#observe(raw, onValue ?? (() => undefined), (error) => this.observeFailure(error));
    return raw;
  }

  /** Bind once to the engine-owned correlation; a different node cannot clear this identity. */
  bind(port: EffectDispatchPort, correlation: EffectCorrelation): EffectDispatchPort {
    const scope = effectScope(correlation);
    const identity = (slot: number, toolId: string): string =>
      JSON.stringify([scope, slot, toolId] satisfies [EffectIdentity['scope'], number, string]);
    return {
      prepare: (...args) => {
        const [slot, toolId, tier] = args;
        return this.invocation(
          () => port.prepare(...args),
          (verdict) => {
            // Record the admitted row before the fenced prepare's post-await cancellation guard.
            if (verdict.outcome === 'proceed') this.#pending.set(identity(slot, toolId), tier);
          },
        );
      },
      settle: (...args) => {
        const [slot, toolId, state] = args;
        return this.#completion(
          () => port.settle(...args),
          () => {
            if (state === 'committed') this.#pending.delete(identity(slot, toolId));
            else this.#stickyAttention = true;
          },
        );
      },
      discard: (...args) =>
        this.#completion(
          () => port.discard(...args),
          () => {
            this.#pending.delete(identity(args[0], args[1]));
          },
        ),
    };
  }

  #completion(factory: () => Promise<void>, onAck: () => void): Promise<void> {
    let raw: Promise<void>;
    try {
      raw = factory();
    } catch (error) {
      this.#stickyAttention = true;
      throw error;
    }
    this.#observe(raw, onAck, () => {
      this.#stickyAttention = true;
    });
    return raw;
  }

  #observe<T>(
    raw: Promise<T>,
    onValue: (value: T) => void,
    onError: (error: unknown) => void,
  ): void {
    try {
      if (typeof nativeThen !== 'function') throw new Error('native Promise observer unavailable');
      Reflect.apply(nativeThen, raw, [
        (value: T) => {
          try {
            onValue(value);
          } catch {
            // No semantic observation failure may float out of a detached reaction or certify success.
            this.#stickyAttention = true;
          }
        },
        (error: unknown) => {
          try {
            onError(error);
          } catch {
            this.#stickyAttention = true;
          }
        },
      ]);
    } catch {
      // The lifetime registry independently retains an unobservable operation. This flag alone is
      // never a host-close ACK, and no private observation cause is retained or exposed.
      this.#stickyAttention = true;
    }
  }
}
