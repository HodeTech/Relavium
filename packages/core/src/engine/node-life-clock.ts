import type { GateTransition, RunEvent } from '@relavium/shared';

/** Derived evidence only. An invalid or absent basis cannot grant a parked node a fresh timeout. */
export type NodeLifeClock =
  | { readonly kind: 'valid'; readonly startedAtMs: number }
  | { readonly kind: 'invalid' };

interface Life {
  readonly startedAtMs: number;
  attempt: number;
  nextRetry: number | undefined;
  budgetContinuation: boolean;
  valid: boolean;
}

/** ADR-0103: retry numbering resets independently of a parked agent's logical timeout life. */
export class NodeLifeClockReducer {
  readonly #lives = new Map<string, Life>();

  apply(event: RunEvent, transition: GateTransition | undefined): void {
    if (event.type === 'node:started' && event.nodeType === 'agent') {
      const attempt = event.attemptNumber ?? 1;
      const timestamp = Date.parse(event.timestamp);
      const prior = this.#lives.get(event.nodeId);
      if (attempt === 1) {
        if (prior?.budgetContinuation === true) {
          prior.valid &&= Number.isFinite(timestamp) && prior.nextRetry === undefined;
          prior.budgetContinuation = false;
          prior.attempt = 1;
          prior.nextRetry = undefined;
        } else {
          // A genuine running-crash restart opens a new life, rather than inheriting T0 forever.
          this.#lives.set(event.nodeId, {
            startedAtMs: timestamp,
            attempt,
            nextRetry: undefined,
            budgetContinuation: false,
            valid: Number.isFinite(timestamp),
          });
        }
      } else if (prior !== undefined) {
        prior.valid &&=
          Number.isFinite(timestamp) &&
          prior.nextRetry === attempt &&
          prior.attempt === attempt - 1 &&
          !prior.budgetContinuation;
        prior.attempt = attempt;
        prior.nextRetry = undefined;
      } else {
        this.#lives.set(event.nodeId, {
          startedAtMs: timestamp,
          attempt,
          nextRetry: undefined,
          budgetContinuation: false,
          valid: false,
        });
      }
    } else if (event.type === 'node:retrying') {
      const life = this.#lives.get(event.nodeId);
      if (life !== undefined) {
        life.valid &&=
          life.attempt === event.attemptNumber &&
          life.nextRetry === undefined &&
          !life.budgetContinuation &&
          Number.isFinite(Date.parse(event.timestamp));
        life.nextRetry = event.attemptNumber + 1;
      }
    } else if (
      event.type === 'node:completed' ||
      event.type === 'node:failed' ||
      event.type === 'node:skipped'
    ) {
      this.#lives.delete(event.nodeId);
    }
    if (transition?.kind === 'budget_decided' && transition.decision === 'approved') {
      const life = this.#lives.get(transition.gate.nodeId);
      if (life !== undefined) {
        life.valid &&= !life.budgetContinuation && life.nextRetry === undefined;
        life.budgetContinuation = true;
      } else {
        // A later first start must not silently repair a missing pre-approval start.
        this.#lives.set(transition.gate.nodeId, {
          startedAtMs: Number.NaN,
          attempt: 1,
          nextRetry: undefined,
          budgetContinuation: true,
          valid: false,
        });
      }
    } else if (transition?.kind === 'human_decided') {
      this.#lives.delete(transition.gate.nodeId);
    }
  }

  snapshot(): ReadonlyMap<string, NodeLifeClock> {
    return new Map(
      [...this.#lives].map(([id, life]): [string, NodeLifeClock] => [
        id,
        life.valid ? { kind: 'valid', startedAtMs: life.startedAtMs } : { kind: 'invalid' },
      ]),
    );
  }

  pendingBudgetContinuations(): readonly string[] {
    return [...this.#lives].filter(([, life]) => life.budgetContinuation).map(([id]) => id);
  }
}
