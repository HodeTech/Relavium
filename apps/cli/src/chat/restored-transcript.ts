import { projectSessionHistory, type Memory, type SessionMessage } from '@relavium/shared';
import { stripTerminalControls } from '../render/sanitize.js';
import {
  INLINE_TRANSCRIPT_BOUND,
  type TranscriptBound,
  type TranscriptEntry,
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
    { user: turn.user, terminal: turn.terminal },
  ]);
  units.push(...projection.trailingLegacyUsers.map((user) => ({ user })));
  const size = (unit: Unit): number => (unit.terminal === undefined ? 1 : 2);
  const total = units.reduce((count, unit) => count + size(unit), 0);
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
        ? `Memory policy: window — only the most recent ${options.memory.window_size} permitted completed turns enter the next request; earlier summaries are excluded.`
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
  const visible = selected.reduce((count, unit) => count + size(unit), 0);
  const omitted = total - visible;
  const retained = selected.some((unit) => regionOf(unit) === 'retained');
  const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });
  const entries: TranscriptEntry[] = [
    notice(
      `Restored ${visible} history entries${omitted === 0 ? '.' : `; ${omitted} earlier entries remain in history.`} Display limits do not change model context.${retained ? '' : ' No retained conversation text is visible.'}`,
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
    if (unit.terminal !== undefined)
      entries.push({ role: 'assistant', text: stripTerminalControls(textOf(unit.terminal)) });
  }
  return entries;
}
