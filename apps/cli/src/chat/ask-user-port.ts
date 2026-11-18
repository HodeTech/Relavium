/**
 * The seam between a chat session and the view store that draws its `ask_user` card
 * ([ADR-0132](../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §1, §7).
 *
 * The session is built BEFORE its view store on every resumed and re-driven path (the store's seed needs the built
 * session's resume state), yet `SessionDeps.askUser` is fixed at construction. So the session is handed this port's stable
 * {@link AskUserPort.delegate}, and the surface binds the store once it exists. A question asked before the bind is a host
 * fault — fatal and not retryable — never a card that cannot be answered.
 *
 * **One boolean.** A surface that can answer passes {@link askUserOption} `true`; the SAME option feeds `SessionDeps.askUser`
 * and the `wiredToolIds` delegate list that `narrowToWired` applies, so the engine's gate and the CLI's gate cannot disagree
 * (the second gate dropped the tool from the effective grant even where the delegate was wired).
 */

import type { AskUserAnswer, AskUserDelegate, AskUserRequest } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

/** What draws the card: the chat view store. */
export interface QuestionHost {
  requestQuestion(request: AskUserRequest, signal?: AbortSignalLike): Promise<AskUserAnswer>;
}

export interface AskUserPort {
  /** Stable for the session's life; routes to whatever store is bound when a question is asked. */
  readonly delegate: AskUserDelegate;
  /** Attach the store that draws the card. Idempotent; the last bind wins. */
  bind(host: QuestionHost): void;
}

export function createAskUserPort(): AskUserPort {
  let host: QuestionHost | undefined;
  return {
    delegate: (request, signal) =>
      host === undefined
        ? Promise.reject(new Error('no question card is bound to this session'))
        : host.requestQuestion(request, signal),
    bind: (next) => {
      host = next;
    },
  };
}

/** The session-builder option for a surface: the delegate when someone can answer, nothing when no one can. */
export function askUserOption(
  port: AskUserPort,
  interactive: boolean,
): { readonly askUser?: AskUserDelegate } {
  return interactive ? { askUser: port.delegate } : {};
}
