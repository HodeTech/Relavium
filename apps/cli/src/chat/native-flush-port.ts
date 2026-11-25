/**
 * The flush of the chat's native card, and when it can be had (MVP-11 step 5, correctness round 1).
 *
 * A stand-alone chat draws a native card (the `/mode` startup default's questions, the `/models` default's rewrite disclosure) through a host
 * that is mounted ONLY while a card is active, and that hands its renderer flush to the chat once, from an effect after it mounted
 * (`NativePromptHost`'s `onRendererReady`). Two things follow that a bare `let flush` got wrong:
 *
 * - a flow that begins a card and publishes at once (`/models` "New chats": no confirmation of its own, only the rewrite disclosure) asks for
 *   the flush in the same tick, before the host that holds it has mounted: it found none, and the chat ended with exit 9;
 * - the flush of a host that has since unmounted (an earlier card) is still in the variable, and a call to it rejects.
 *
 * This port keeps the flush of the host that is mounted for the card active NOW: it forgets it when the card ends, and {@link mounted} waits
 * for the next host to hand its own over (bounded, and cancelled with the flow). A host that never mounts is a refusal to show the card, not
 * a reason to publish without it: nothing is written.
 *
 * Pure of rendering; the timer is injected for a test.
 */

import type { NoticeFlush } from '../engine/effect-retention.js';
import type { NativePromptUi } from '../render/tui/native-prompt-channel.js';

/** How long a card's host may take to mount before the flow is refused: a render pass is milliseconds, so this is a wiring fault, not a slow machine. */
export const NATIVE_HOST_MOUNT_MS = 3000;

/** The card's host did not mount (or the flow was cancelled before it did): the card could not be shown, so nothing is published. */
export class NativeHostUnavailableError extends Error {
  constructor() {
    super('The card could not be displayed.');
    this.name = 'NativeHostUnavailableError';
  }
}

export interface NativeFlushPort {
  /** The host's `onRendererReady`: the flush of the host that has just mounted. */
  readonly ready: (flush: NoticeFlush) => void;
  /** The flush of the host mounted for the card active now, or `undefined` (no card, or its host has not mounted yet). */
  readonly current: () => NoticeFlush | undefined;
  /**
   * The flush of the host mounted for the card active now, waiting for it when the card has just begun. Rejects with
   * {@link NativeHostUnavailableError} when no host mounted within {@link NATIVE_HOST_MOUNT_MS} or `signal` aborted first (a flow cancelled).
   */
  readonly mounted: (signal?: AbortSignal) => Promise<NoticeFlush>;
  /** Stop listening to the channel (the chat's end). */
  readonly dispose: () => void;
}

export interface NativeFlushPortOptions {
  /** Start a timer that calls `fire` after `ms`; the returned function cancels it. Default: `setTimeout`. */
  readonly timer?: ((fire: () => void, ms: number) => () => void) | undefined;
}

function defaultTimer(fire: () => void, ms: number): () => void {
  const handle = setTimeout(fire, ms);
  return () => {
    clearTimeout(handle);
  };
}

export function createNativeFlushPort(
  ui: Pick<NativePromptUi, 'subscribe' | 'getSnapshot'>,
  options: NativeFlushPortOptions = {},
): NativeFlushPort {
  const timer = options.timer ?? defaultTimer;
  let flush: NoticeFlush | undefined;
  // Who is waiting for a host to mount: each is settled once, by the host, the timer, the flow's abort or the port's end.
  const waiting = new Set<{
    readonly resolve: (flush: NoticeFlush) => void;
    readonly fail: () => void;
  }>();
  // The host unmounts when the card ends, and its flush with it: forget it, so the next card's flow waits for its own host.
  const unsubscribe = ui.subscribe(() => {
    if (!ui.getSnapshot().active) flush = undefined;
  });
  const current = (): NoticeFlush | undefined => (ui.getSnapshot().active ? flush : undefined);
  return {
    ready: (given) => {
      flush = given;
      for (const waiter of [...waiting]) waiter.resolve(given);
    },
    current,
    mounted: (signal) =>
      new Promise<NoticeFlush>((resolve, reject) => {
        const already = current();
        if (already !== undefined) {
          resolve(already);
          return;
        }
        if (signal?.aborted === true) {
          reject(new NativeHostUnavailableError());
          return;
        }
        let cancelTimer: () => void = () => undefined;
        const settle = (): void => {
          cancelTimer();
          signal?.removeEventListener('abort', fail);
          waiting.delete(waiter);
        };
        const fail = (): void => {
          settle();
          reject(new NativeHostUnavailableError());
        };
        const waiter = {
          resolve: (given: NoticeFlush): void => {
            settle();
            resolve(given);
          },
          fail,
        };
        waiting.add(waiter);
        signal?.addEventListener('abort', fail, { once: true });
        cancelTimer = timer(fail, NATIVE_HOST_MOUNT_MS);
      }),
    dispose: () => {
      unsubscribe();
      flush = undefined;
      for (const waiter of [...waiting]) waiter.fail();
    },
  };
}
