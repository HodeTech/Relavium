import type { ToolDef, ToolDispatchContext } from './types.js';

/**
 * The subset of a {@link ToolDispatchContext} that decides whether a delegate-backed tool can run (`CR-73`).
 *
 * A `Pick` rather than the whole context: the callers hold a context under construction (the run path builds
 * one line-by-line, the session path returns one from a builder), and asking for the whole shape would tie
 * this predicate to fields it has no business reading.
 */
export type ToolDelegates = Pick<ToolDispatchContext, 'invokeAgent' | 'mediaRead'>;

/**
 * Whether the dispatch-context DELEGATE a tool needs will actually be present (`CR-73`).
 *
 * `invoke_agent` dispatches through `ctx.invokeAgent` and `read_media` through `ctx.mediaRead`, and neither is
 * a {@link ToolHost} capability arm — so a filter that checks only arms cannot see them, and both were
 * advertised to every model that was granted them while the delegates are wired NOWHERE in the tree. The model
 * then chose a tool the engine had just offered and got `tool_unavailable` for it. The dispatch guard is still
 * authoritative and still throws; this exists so the offer is never made.
 *
 * **One home, called from both `buildLlmTools` implementations.** The run path (`agent-runner.ts`) and the
 * session path (`agent-session.ts`) each build their own model-visible tool list, and they have drifted before.
 * A predicate duplicated into both would be correct on the day it was written and wrong on the day one of them
 * gained a tool — which is the failure this item IS.
 *
 * A tool that declares no delegate is unaffected and returns `true`.
 */
export function delegateAvailable(def: ToolDef, ctx: ToolDelegates): boolean {
  const required = def.requiresDelegate;
  switch (required) {
    case undefined:
      return true;
    case 'invokeAgent':
      return ctx.invokeAgent !== undefined;
    case 'mediaRead':
      return ctx.mediaRead !== undefined;
    default: {
      // Exhaustiveness guard, not defensive padding: a new `ToolDelegateName` must fail to COMPILE here rather
      // than silently fall through to "available" and re-open `CR-73` for the tool that added it.
      const never: never = required;
      throw new Error(`unhandled tool delegate: ${String(never)}`);
    }
  }
}
