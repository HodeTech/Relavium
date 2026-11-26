/**
 * What the Home's status line says about the NEXT chat
 * ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §2): the provider,
 * the model, the mode and the effort a chat started now would use, and the directory it would work in. The Home controller holds none of
 * these on its own; it reads them ONCE when it is built and again only when something that changes them was done (a provider run, a
 * `/models` default, a `/mode` default, a chat ending), never while it draws: a draw touches no keychain and no disk (the chat repaints every
 * 80 ms, and a key read blocks the event loop). A key or a config changed in another terminal leaves the line as it was until the next of
 * those events, and the reference page says so.
 *
 * **The line must be true.** Every field is derived by the rules a new chat is built by, not by rules of its own: {@link nextChatSettings} is
 * the rule `driveHome`'s `startChat` applies to the two `[chat]` snapshots it holds (it calls this very function), and {@link nextChatFacts}
 * resolves the model and the provider with `defaultChatModel`, the function the default agent is bound by (`chat/agent-source.ts`). A test
 * builds a chat and the facts from the same configuration and compares them.
 *
 * The values are NOT cleaned here: a provider or model id read from configuration, and a directory name, are untrusted text, and the status
 * line's own model (`render/tui/status-line.ts`) scrubs, bounds and measures every one of them before anything is drawn.
 */
export interface HomeStatusFacts {
  /** The provider's lowercase id (`anthropic`), as the line draws it; absent when none can be named (the line then says nothing of it). */
  readonly provider?: string | undefined;
  /** The model's id; absent only on a state with no model. */
  readonly model?: string | undefined;
  /** The starting mode's name (`ask`, `plan`, `accept-edits`, `auto`): the line writes it `<mode> mode`. */
  readonly mode: string;
  /** The reasoning effort a new chat starts at, when one is set. */
  readonly effort?: string | undefined;
  /** The working directory as a label (`directoryLabel` of `render/notation.ts`): project-relative or from `~`, never absolute. */
  readonly directory: string;
}

/** What the controller reads the facts through: synchronous, called at its refresh points only, and free to throw (the controller then drops the facts: the line is blank until a read succeeds, never stale). */
export interface HomeStatusReader {
  readonly read: () => HomeStatusFacts;
}

/** Whether two sets of facts say the same thing (so an unchanged re-read publishes nothing and repaints nothing). */
export function sameStatusFacts(
  a: HomeStatusFacts | undefined,
  b: HomeStatusFacts | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.effort === b.effort &&
    a.directory === b.directory
  );
}
