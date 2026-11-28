/**
 * Whether a call THREW, told on the spot, for starting a piece of work that returns a promise ([MVP-11](../../../../docs/roadmap/phases/mvp-11.md)
 * unit 10). Work is admitted first (an owner that no longer admits throws on entry), and that synchronous refusal must be told apart from the
 * work's own later fault, which arrives as a rejection of the promise the call returns. The caller chains that promise itself; the `try` here
 * holds a call whose result type is open, so a rejection is never mistaken for something this block catches.
 */

/** What {@link tryCall} gives back: the value, or what the call threw. */
export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: unknown };

export function tryCall<T>(call: () => T): Attempt<T> {
  try {
    return { ok: true, value: call() };
  } catch (cause) {
    return { ok: false, cause };
  }
}
