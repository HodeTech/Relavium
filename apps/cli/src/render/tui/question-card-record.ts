/**
 * The transcript entry the host leaves when the person answers or skips an `ask_user` question
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §6).
 *
 * Built from the answer the card already holds — never from an event — because the person's words must not ride the event
 * stream. It lives in the live transcript (and the terminal's own scrollback) only: the durable session row keeps the
 * content-free tool structure, so a resumed session shows the bare tool row instead.
 */

import type { AskUserAnswer, AskUserRequest } from '@relavium/core';

/** One quoted answer: the chosen labels, then the person's own text in quotes. */
function answerText(selected: readonly string[], other: string | undefined): string {
  const parts = [...selected, ...(other === undefined ? [] : [`“${other}”`])];
  return parts.join(', ');
}

export function questionTranscriptText(request: AskUserRequest, answer: AskUserAnswer): string {
  if (answer.kind === 'skipped') {
    const headers = request.questions.map((question) => question.header).join(' · ');
    return `Skipped the agent's ${request.questions.length === 1 ? 'question' : 'questions'}: ${headers}`;
  }
  return request.questions
    .map((question, index) => {
      const given = answer.answers[index];
      return `Asked: ${question.header} — ${question.question}\n  → ${answerText(given?.selected ?? [], given?.other)}`;
    })
    .join('\n');
}
