/**
 * A hard deadline over one awaited step — the primitive behind
 * [ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §5–§7's per-attempt provider deadline and
 * [ADR-0085](../../../docs/decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md)
 * §2/§3's node deadline and post-abort grace window.
 *
 * **An `AbortSignal` is a request, not a guarantee.** A callee that ignores it —
 *
 * ```ts
 * generate(): Promise<LlmResult> { return new Promise(() => {}); }
 * ```
 *
 * — or whose iterator's `next()` never settles leaves the caller waiting forever, which is exactly the hang
 * this exists to remove. So the cooperative abort is raised AND the awaited promise is hard-raced against a
 * timer. The repo already works this way where it bounds outbound work: `safe-egress.ts` and the CLI's key
 * validation both race rather than trusting the signal alone.
 *
 * **The guarantee is CALLER liveness, not resource termination.** An uncooperative callee's work may
 * continue in the background; what is bounded is how long Relavium waits. Promising otherwise would be a
 * promise this design cannot keep, and ADR-0082 §5 says so in those words.
 *
 * **Why it lives in `@relavium/shared` and not beside its first caller.** It began in `@relavium/llm` for
 * the provider attempt. ADR-0085 needs the same primitive in `@relavium/core` for the node deadline, and
 * `@relavium/llm` exports neither the symbol nor a subpath that would reach it — so the choice was to widen
 * the LLM package's public surface for a mechanism that is not about LLMs, or to move it to the package
 * both already depend on. §9 chose the move. `AbortControllerLike` came with it: `@relavium/llm` and
 * `@relavium/core` had each declared their own byte-identical copy.
 *
 * **Its tests live beside it** (`deadline.test.ts`), except two. The move first left the whole suite in
 * `@relavium/llm`, reasoning that this package's `types: []` forbids the `process.on('unhandledRejection')`
 * two cases need. Two measurements retired that reasoning. The tests execute this package from `dist/`, so
 * V8 attributed **0%** to this file while the 90% floor that had guarded the code (`vitest.config.ts` covers
 * `packages/llm/src/**`, never `packages/shared/src/**`) was left holding a re-export shell scoring a
 * perfect 100 — the enforced number rose as the guarantee vanished. And `types: []` was not, at that moment,
 * doing the work claimed for it: `tsconfig.json` includes `*.test.ts`, whose `vitest` import pulls in
 * `@types/node` and defeats the gate for the whole program. That is now fixed by `tsconfig.purity.json`,
 * which excludes tests the way `packages/llm/tsconfig.seam.json` and `packages/core/tsconfig.purity.json`
 * already did — so the boundary is real, and the two `process`-dependent cases stay in `@relavium/llm`
 * because of a guard that now actually bites rather than one that merely read well.
 */

import type { AbortSignalLike } from './content.js';

/**
 * A controller the host supplies — a platform-free seam has no ambient `AbortController` (the strict base's
 * `lib: ["ES2023"]` does not carry one). A native `AbortController` structurally satisfies it, so a real
 * surface injects `() => new AbortController()` and its `signal` is a genuine `AbortSignal` that `fetch`
 * honours.
 */
export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort: (reason?: unknown) => void;
}

/**
 * A one-shot timer the host supplies; calling the returned function disarms it.
 *
 * Deliberately narrower than the engine's own `SetTimer`, which carries a third `TimerKind` argument
 * (ADR-0036). A `SetTimer` is assignable to this, so a host wires one port and both consumers accept it,
 * while this signature stays honest about the only two things a deadline needs. The assignability rests
 * specifically on that third parameter being OPTIONAL; making it required breaks it.
 *
 * **The narrowing is a one-way door, recorded rather than discovered later.** Because the kind cannot be
 * passed, `openDeadline` structurally cannot arm a `liveness` timer — one that must not hold the event loop
 * open and must not be swept by a test's `fireTimers()`. That is correct today: both implementations default
 * `kind = 'work'`, and ADR-0085's Consequences say both timers it adds ARE `work`. A future deadline that
 * genuinely needs `liveness` has to widen this signature here, not work around it at a call site.
 */
export type SetDeadlineTimer = (ms: number, fire: () => void) => () => void;

/** Why a deadline-scoped run ended. `caller` wins a same-tick tie — see {@link openDeadline}. */
export type DeadlineOutcome = 'settled' | 'deadline' | 'caller';

export interface DeadlineScope {
  /** The signal to hand the callee: aborts on EITHER the caller's abort or the deadline. */
  readonly signal: AbortSignalLike;
  /**
   * Race one awaited step against the ABSOLUTE deadline. Used per `next()` on a stream, deliberately: a
   * per-chunk reset would let a provider dribble one token per interval forever.
   */
  race: <T>(
    step: Promise<T>,
  ) => Promise<{ outcome: 'settled'; value: T } | { outcome: 'deadline' }>;
  /** Which side ended it, resolved at CLASSIFICATION time so the answer is a contract, not a race. */
  classify: () => DeadlineOutcome;
  /** Disarm the timer and detach the caller listener. Idempotent; safe on every exit path. */
  dispose: () => void;
}

/**
 * Open a deadline scope for one awaited step.
 *
 * **Precedence is decided at classification time, not by listener order.** If the caller's signal is aborted
 * when the failure is classified, the outcome is `caller` even if the deadline has also elapsed — the same
 * cancel-wins rule ADR-0036 uses for the run. Without a stated rule the answer would depend on which
 * listener the runtime happened to invoke first, and a test would be pinning a scheduler detail.
 */
export function openDeadline(
  timeoutMs: number,
  newController: () => AbortControllerLike,
  setTimer: SetDeadlineTimer,
  callerSignal?: AbortSignalLike,
): DeadlineScope {
  const controller = newController();
  let expired = false;
  let disposed = false;
  /**
   * Caller cancellation, LATCHED — not merely forwarded to the callee-facing controller.
   *
   * The state has to be readable by a `race` that has not been called yet. Aborting the controller and
   * registering a listener both act only on waiters that already exist, and a native signal does not re-emit
   * `abort` to a listener attached later — so a cancellation landing before the first `race` left nothing
   * for that race to observe. A review measured the consequence: with a provider that ignores its signal,
   * `race()` stayed pending until the ABSOLUTE deadline fired, which on the shipped default is 120 seconds
   * of a cancel that looks ignored. `classify()` said `caller` the whole time — the label was right and the
   * liveness was not.
   */
  let callerCancelled = callerSignal?.aborted === true;
  const waiters = new Set<() => void>();

  const trip = (): void => {
    expired = true;
    for (const wake of waiters) wake();
    controller.abort();
  };
  const disarm = setTimer(timeoutMs, trip);

  const onCallerAbort = (): void => {
    callerCancelled = true;
    for (const wake of waiters) wake();
    controller.abort();
  };
  // A caller that has ALREADY aborted never fires a listener (matching a native signal), so check first.
  if (callerCancelled) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort);
  }

  return {
    signal: controller.signal,
    race: async <T>(step: Promise<T>) => {
      if (expired || callerCancelled) {
        // **Discarded, but discarded HANDLED.** `step` is `iterator.next()`, already invoked by the caller —
        // argument evaluation happens before the call — so returning without attaching a handler leaves a
        // live promise nobody owns. The likeliest way to reach here is the well-behaved case: the deadline
        // trips while the chain is suspended handing a chunk to a slower consumer, the callee honours the
        // merged abort and REJECTS its in-flight `next()`, and the next pull finds `expired` already true.
        // Node's default is `--unhandled-rejections=throw`, so that killed the process mid-turn with a stack
        // trace instead of surfacing the `timeout` error the caller had just computed. A review reproduced
        // it: `unhandled= 1`.
        //
        // `callerCancelled` shares this arm because the disposal is identical — abandon the step, handle its
        // late rejection — and only the LABEL differs, which `classify()` owns and gives to the caller. The
        // outcome stays `'deadline'` here for exactly that reason: it means "this step was abandoned", not
        // "the timer fired", and every caller of `race` reads `classify()` for the reason.
        void step.catch(() => undefined);
        return { outcome: 'deadline' };
      }
      // The wake-up promise is settled by `trip`/`onCallerAbort` and by `dispose`, so it never outlives the
      // scope — a `race` against a permanently pending promise would itself be the leak this file is about.
      let wake: () => void = () => undefined;
      const tripped = new Promise<'tripped'>((resolve) => {
        wake = () => {
          resolve('tripped');
        };
        waiters.add(wake);
      });
      try {
        const settled = await Promise.race([step.then((value) => ({ value })), tripped]);
        // `expired` rather than "which promise won": the caller-abort path also wakes the race, and its
        // classification belongs to `classify`, not here.
        if (settled === 'tripped') return { outcome: 'deadline' };
        return { outcome: 'settled', value: settled.value };
      } finally {
        waiters.delete(wake);
      }
    },
    classify: () => {
      if (callerSignal?.aborted === true) return 'caller'; // cancel wins a same-tick tie
      return expired ? 'deadline' : 'settled';
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disarm();
      callerSignal?.removeEventListener('abort', onCallerAbort);
      // Wake anything still racing so no promise is left pending on a disposed scope.
      for (const wake of waiters) wake();
      waiters.clear();
    },
  };
}
