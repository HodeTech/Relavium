/** Pure structural history projection shared by session reconstruction, export and durable effect attribution. */
import type { SessionMessage } from './session.js';
import type { SessionContentPart } from './session-content.js';

/** The concatenated `text` parts of a durable content array (non-text parts are dropped). */
function textOf(content: readonly SessionContentPart[]): string {
  return content
    .filter((part): part is Extract<SessionContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** The compaction/trim DROP BOUNDARY (ADR-0062): messages at/below the max `droppedThroughSequence` across all
 *  boundary markers are superseded (a later summary-less `/trim` advances it). `-1` ⇒ never compacted. */
function dropBoundaryOf(ordered: readonly SessionMessage[]): number {
  return ordered.reduce(
    (max, m) =>
      m.compaction === undefined ? max : Math.max(max, m.compaction.droppedThroughSequence),
    -1,
  );
}

/** A completed exchange, including its structural rows and an explicit final text part (even empty). */
export interface CompletedSessionTurn {
  readonly user: SessionMessage;
  readonly terminal: SessionMessage;
  readonly messages: readonly SessionMessage[];
  /** Nontrailing bare-user context written before explicit empty terminals existed. Not extra turns. */
  readonly legacyUserPrefix: readonly SessionMessage[];
}

/**
 * The one durable turn projection for resume, boundary mapping, export and effect disclosure.
 * A tool-call preamble is never a terminal. A new user abandons an unfinished structural exchange.
 * Consecutive bare-user rows preserve the old writer's nontrailing empty-final context, without
 * inventing terminal rows or completed-turn counts. A final bare user still rolls back.
 * Boundary filtering keeps WHOLE turns, never an orphaned structural row. Export/disclosure
 * pass `false` to include completed turns from the entire append-only history.
 */
export function completedSessionTurns(
  messages: readonly SessionMessage[],
  honorBoundary = true,
): CompletedSessionTurn[] {
  return projectSessionHistory(messages, honorBoundary).turns;
}

function projectSessionHistory(
  messages: readonly SessionMessage[],
  honorBoundary = true,
): { turns: CompletedSessionTurn[]; trailingLegacyUsers: SessionMessage[] } {
  const ordered = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const boundary = honorBoundary ? dropBoundaryOf(ordered) : -1;
  const turns: CompletedSessionTurn[] = [];
  let user: SessionMessage | undefined;
  let rows: SessionMessage[] = [];
  let legacyUsers: SessionMessage[] = [];
  for (const message of ordered) {
    if (message.compaction !== undefined || message.role === 'system') continue;
    if (message.role === 'user') {
      // The old atomic writer stored a successful empty final as a user row alone. Another user makes
      // it nontrailing, which the old resume retained. Structural rows instead identify an interrupted
      // exchange and must not be carried. Empty legacy text was omitted by the old text projection.
      if (user !== undefined && rows.length === 1 && textOf(user.content).length > 0)
        legacyUsers.push(user);
      user = message;
      rows = [message];
      continue;
    }
    if (user === undefined) continue;
    rows.push(message);
    const terminal =
      message.role === 'assistant' &&
      message.content.some((part) => part.type === 'text') &&
      !message.content.some((part) => part.type === 'tool_call');
    if (!terminal) continue;
    if (user.sequenceNumber > boundary)
      turns.push({
        user,
        terminal: message,
        messages: rows,
        legacyUserPrefix: legacyUsers.filter((row) => row.sequenceNumber > boundary),
      });
    user = undefined;
    rows = [];
    legacyUsers = [];
  }
  return {
    turns,
    trailingLegacyUsers: legacyUsers.filter((row) => row.sequenceNumber > boundary),
  };
}

export function resumableSessionMessages(messages: readonly SessionMessage[]): SessionMessage[] {
  const projection = projectSessionHistory(messages);
  return [
    ...projection.turns.flatMap((turn) => [
      ...turn.legacyUserPrefix,
      turn.user,
      ...(textOf(turn.terminal.content).length === 0 ? [] : [turn.terminal]),
    ]),
    ...projection.trailingLegacyUsers,
  ];
}

/** Durable sequences of the text-only rows the model sees, including completed empty-final users. */
export function resumableMessageSequences(messages: readonly SessionMessage[]): number[] {
  return resumableSessionMessages(messages).map((message) => message.sequenceNumber);
}

/**
 * Boundary slots for retained user exchanges. Legacy bare users have their own sequence slot so
 * compaction/trim can drop them independently; they do not increase the reconstructed hard turn cap.
 */
export function resumableTurnBoundarySequences(messages: readonly SessionMessage[]): number[] {
  const projection = projectSessionHistory(messages);
  return [
    ...projection.turns.flatMap((turn) => [
      ...turn.legacyUserPrefix.map((row) => row.sequenceNumber),
      turn.terminal.sequenceNumber,
    ]),
    ...projection.trailingLegacyUsers.map((row) => row.sequenceNumber),
  ];
}
