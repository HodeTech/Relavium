import { interruptionPhrase } from '@relavium/core';
import {
  projectSessionHistory,
  SESSION_ASK_TOOL_NAME,
  type Memory,
  type SessionAskRecord,
  type SessionInterruption,
  type SessionMessage,
} from '@relavium/shared';
import { stripTerminalControls } from '../render/sanitize.js';
import { askRecordTranscriptText } from '../render/tui/question-card-record.js';
import {
  INLINE_TRANSCRIPT_BOUND,
  type TranscriptBound,
  type TranscriptEntry,
  type ToolCallView,
} from '../render/tui/session-view-model.js';

export const LEGACY_USER_DISPLAY = 'Earlier user message — compact display was not recorded.';
export const LEGACY_DISPLAY_EXPLANATION =
  'Original earlier user text remains in history and may enter model context. Its compact display form was not recorded; it is not reconstructed on screen.';
export class RestoredDisplayReadError extends Error {
  constructor() {
    super('Saved display text could not be read.');
    this.name = 'RestoredDisplayReadError';
  }
}
interface Unit {
  readonly user: SessionMessage;
  readonly terminal?: SessionMessage;
  /** ADR-0119: set when the turn ended in an interruption row instead of an answer. */
  readonly interruption?: SessionInterruption;
  readonly tools?: readonly ToolCallView[];
  readonly omittedCalls?: number;
  /** ADR-0133: the stored question records of this turn's `ask_user` calls, in call order (at most {@link MAX_RESTORED_ASKS}). */
  readonly asks?: readonly SessionAskRecord[];
  readonly omittedAsks?: number;
}
/** The most question records one restored turn shows; the rest are counted, like omitted tool calls. */
const MAX_RESTORED_ASKS = 16;
/** Correlate only already-retained structural identities inside this completed turn. */
function structuralTools(
  messages: readonly SessionMessage[],
): Pick<Unit, 'tools' | 'omittedCalls' | 'asks' | 'omittedAsks'> {
  const calls = messages.flatMap((message) =>
    message.content.filter((part) => part.type === 'tool_call'),
  );
  const results = messages.flatMap((message) =>
    message.content.filter((part) => part.type === 'tool_result'),
  );
  const unique = [...new Map(calls.map((call) => [call.id, call])).values()];
  const tools = unique.slice(0, 16).map((call): ToolCallView => {
    const matching = results.filter((result) => result.toolCallId === call.id);
    const outcome = restoredToolOutcome(matching);
    return { id: call.id, toolId: call.name, resolved: true, outcome };
  });
  // ADR-0133: the question record of a successful `ask_user` call — read only from the result paired with an ask_user call.
  const records = unique.flatMap((call) => {
    if (call.name !== SESSION_ASK_TOOL_NAME) return [];
    const matching = results.filter((result) => result.toolCallId === call.id);
    const ask =
      matching.length === 1 && matching[0]?.outcome === 'ok' ? matching[0].ask : undefined;
    return ask === undefined ? [] : [ask];
  });
  return {
    tools,
    omittedCalls: Math.max(0, unique.length - tools.length),
    asks: records.slice(0, MAX_RESTORED_ASKS),
    omittedAsks: Math.max(0, records.length - MAX_RESTORED_ASKS),
  };
}
function restoredToolOutcome(
  matching: readonly { readonly outcome?: string }[],
): NonNullable<ToolCallView['outcome']> {
  if (matching.length !== 1) return 'unknown';
  switch (matching[0]?.outcome) {
    case 'ok':
      return 'success';
    case 'error':
      return 'failure';
    case 'denied':
      return 'denied';
    default:
      return 'unknown';
  }
}
type Region = 'summary' | 'trim' | 'retained';
const textOf = (message: SessionMessage): string =>
  message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');

/** Presentation projection only. Canonical user text is never used as a display fallback. */
export function restoreSessionTranscript(options: {
  readonly messages: readonly SessionMessage[];
  readonly memory: Readonly<Memory> | undefined;
  readonly transcriptBound: TranscriptBound;
  readonly readDisplay: (sequences: readonly number[]) => ReadonlyMap<number, string>;
}): readonly TranscriptEntry[] {
  const projection = projectSessionHistory(options.messages, false);
  const units: Unit[] = projection.turns.flatMap((turn) => [
    ...turn.legacyUserPrefix.map((user) => ({ user })),
    {
      user: turn.user,
      terminal: turn.terminal,
      ...(turn.interruption === undefined ? {} : { interruption: turn.interruption }),
      ...structuralTools(turn.messages),
    },
  ]);
  units.push(...projection.trailingLegacyUsers.map((user) => ({ user })));
  const conversationSize = (unit: Unit): number => (unit.terminal === undefined ? 1 : 2);
  const askEntries = (unit: Unit): number =>
    (unit.asks?.length ?? 0) + ((unit.omittedAsks ?? 0) > 0 ? 1 : 0);
  const size = (unit: Unit): number =>
    conversationSize(unit) + Math.ceil((unit.tools?.length ?? 0) / 4) + askEntries(unit);
  const total = units.reduce((count, unit) => count + conversationSize(unit), 0);
  const totalCalls = units.reduce(
    (count, unit) => count + (unit.tools?.length ?? 0) + (unit.omittedCalls ?? 0),
    0,
  );
  const cap = options.transcriptBound === INLINE_TRANSCRIPT_BOUND ? 200 : 500;
  let start = units.length,
    potential = 0;
  while (start > 0) {
    const unit = units[start - 1];
    if (unit === undefined || potential + size(unit) > cap - 1) break;
    potential += size(unit);
    start--;
  }
  const candidates = units.slice(start);
  const sequences = candidates.flatMap((unit) =>
    unit.terminal === undefined
      ? [unit.user.sequenceNumber]
      : [unit.user.sequenceNumber, unit.terminal.sequenceNumber],
  );
  const display = new Map<number, string>();
  if (sequences.length > 0) {
    try {
      const result = options.readDisplay(sequences);
      const users = new Set(candidates.map((unit) => unit.user.sequenceNumber));
      for (const sequence of sequences) {
        const value = result.get(sequence);
        if (value === undefined) continue;
        if (typeof value !== 'string' || !users.has(sequence)) throw new RestoredDisplayReadError();
        display.set(sequence, value);
      }
    } catch {
      throw new RestoredDisplayReadError();
    }
  }
  const markers = options.messages
    .filter((row) => row.compaction !== undefined)
    .toSorted((a, b) => a.sequenceNumber - b.sequenceNumber);
  const boundary = markers.reduce(
    (max, row) => Math.max(max, row.compaction?.droppedThroughSequence ?? -1),
    -1,
  );
  const summaryBoundary = markers.findLast((row) => textOf(row).length > 0)?.compaction
    ?.droppedThroughSequence;
  const regionOf = (unit: Unit): Region =>
    summaryBoundary !== undefined && unit.user.sequenceNumber <= summaryBoundary
      ? 'summary'
      : unit.user.sequenceNumber <= boundary
        ? 'trim'
        : 'retained';
  const policy =
    options.memory?.type === 'none'
      ? 'Memory policy: none — earlier conversation is excluded from the next request.'
      : options.memory?.type === 'window'
        ? `Memory policy: window — only the most recent ${options.memory.window_size} permitted turns enter the next request; earlier summaries are excluded.`
        : undefined;
  let budget = 1 + (policy === undefined ? 0 : 1),
    legacy = false,
    leadingRegion: Region | undefined,
    selectedStart = candidates.length;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const unit = candidates[index];
    if (unit === undefined) continue;
    const region = regionOf(unit);
    const missing = display.get(unit.user.sequenceNumber) === undefined;
    const next =
      budget + size(unit) + (region === leadingRegion ? 0 : 1) + (missing && !legacy ? 1 : 0);
    if (next > cap) break;
    budget = next;
    selectedStart = index;
    leadingRegion = region;
    legacy ||= missing;
  }
  const selected = candidates.slice(selectedStart);
  const visible = selected.reduce((count, unit) => count + conversationSize(unit), 0);
  const visibleCalls = selected.reduce((count, unit) => count + (unit.tools?.length ?? 0), 0);
  const omitted = total - visible;
  const retained = selected.some((unit) => regionOf(unit) === 'retained');
  const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });
  const omittedNotice = omitted === 0 ? '.' : `; ${omitted} earlier entries remain in history.`;
  const toolNotice =
    totalCalls === 0
      ? ''
      : `${visibleCalls} structural tool calls restored; ${totalCalls - visibleCalls} omitted tool calls. Targets, previews, results and diff statistics are unavailable. `;
  const entries: TranscriptEntry[] = [
    notice(
      `Restored ${visible} history entries${omittedNotice} ${toolNotice}Display limits do not change model context.${retained ? '' : ' No retained conversation text is visible.'}`,
    ),
  ];
  if (policy !== undefined) entries.push(notice(policy));
  if (legacy) entries.push(notice(LEGACY_DISPLAY_EXPLANATION));
  let previous: Region | undefined;
  for (const unit of selected) {
    const region = regionOf(unit);
    if (region !== previous) {
      entries.push(
        notice(
          region === 'summary'
            ? 'Archived history — compaction produced a saved summary. Summaries are lossy and may omit details or previously trimmed messages.'
            : region === 'trim'
              ? summaryBoundary === undefined
                ? 'Archived history removed by /trim.'
                : 'Later history removed by /trim — outside retained conversation text. A saved summary may still survive.'
              : 'Retained conversation text begins here.',
        ),
      );
      previous = region;
    }
    const recorded = display.get(unit.user.sequenceNumber);
    entries.push({
      role: 'user',
      text: recorded === undefined ? LEGACY_USER_DISPLAY : stripTerminalControls(recorded),
    });
    if ((unit.tools?.length ?? 0) > 0)
      entries.push({
        role: 'tools',
        text: '',
        calls: unit.tools ?? [],
        omitted: unit.omittedCalls ?? 0,
      });
    // ADR-0133: what the person was asked and answered, rebuilt from the stored record — where the live card left it.
    for (const ask of unit.asks ?? [])
      entries.push(notice(stripTerminalControls(askRecordTranscriptText(ask))));
    if ((unit.omittedAsks ?? 0) > 0)
      entries.push(notice(`${unit.omittedAsks} more saved questions are not shown.`));
    // ADR-0119: an interrupted turn has no answer. Show its fixed dim row where the answer would be, built from the
    // closed phrase table — never from stored text — so it restores no argument, target, diff or result.
    if (unit.interruption !== undefined)
      entries.push(notice(`Interrupted — ${interruptionPhrase(unit.interruption)}`));
    else if (unit.terminal !== undefined)
      entries.push({ role: 'assistant', text: stripTerminalControls(textOf(unit.terminal)) });
  }
  return entries;
}
