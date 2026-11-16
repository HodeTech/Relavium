/**
 * The transcript entry the host leaves when the person answers or skips an `ask_user` question
 * ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §6,
 * [ADR-0133](../../../../../docs/decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md)).
 *
 * Built from the answer the card already holds — never from an event — because the person's words must not ride the
 * observability stream. The same text is rebuilt from the session's stored question record when a session is resumed
 * ({@link askRecordTranscriptText}), so a restored transcript reads as the live one did.
 */

import type { AskUserAnswer, AskUserRequest } from '@relavium/core';
import type { SessionAskRecord } from '@relavium/shared';

interface Item {
  readonly header: string;
  /** Absent for a skipped call: the person may never have been shown it, so no entry quotes it. */
  readonly question?: string | undefined;
  readonly selected: readonly string[];
  readonly other?: string | undefined;
}

/**
 * The host's own row markers. The plain-text rules refuse `›` and every box-drawing glyph anywhere in a question, header or
 * option (`HOST_GLYPH` in the tool), so a row that STARTS with one of these was written by the host — never by the model —
 * however the transcript wrapper breaks a long model string. Without them the model's text, placed at a wrap boundary,
 * could begin a row that looks exactly like the host's `  → <answer>` line (the forged-row-at-a-wrap-boundary class the
 * card's gutter closes; there the model's rows are marked, here the host's are).
 */
const ASKED_ROW = '› ';
const ANSWER_ROW = '  └ ';

/** One quoted answer: the chosen labels, then the person's own text in quotes. */
function answerText(selected: readonly string[], other: string | undefined): string {
  const parts = [...selected, ...(other === undefined ? [] : [`“${other}”`])];
  return parts.join(', ');
}

function render(status: 'answered' | 'skipped', items: readonly Item[]): string {
  if (status === 'skipped') {
    const headers = items.map((item) => item.header).join(' · ');
    return `${ASKED_ROW}Skipped the agent's ${items.length === 1 ? 'question' : 'questions'}: ${headers}`;
  }
  return items
    .map(
      (item) =>
        `${ASKED_ROW}Asked: ${item.header}${item.question === undefined ? '' : ` — ${item.question}`}\n${ANSWER_ROW}${answerText(item.selected, item.other)}`,
    )
    .join('\n');
}

export function questionTranscriptText(request: AskUserRequest, answer: AskUserAnswer): string {
  if (answer.kind === 'skipped')
    return render(
      'skipped',
      request.questions.map(({ header }) => ({ header, selected: [] })),
    );
  return render(
    'answered',
    request.questions.map(({ header, question }, index) => ({
      header,
      question,
      selected: answer.answers[index]?.selected ?? [],
      other: answer.answers[index]?.other,
    })),
  );
}

/** The same entry, rebuilt from a stored question record (a resumed session). */
export function askRecordTranscriptText(record: SessionAskRecord): string {
  return render(
    record.status,
    record.items.map(({ header, question, selected, other }) => ({
      header,
      question,
      selected: selected ?? [],
      other,
    })),
  );
}
