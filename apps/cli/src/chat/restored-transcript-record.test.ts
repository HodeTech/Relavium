/**
 * A restored chat draws its archive through the one history projection, which skips a record row
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): a mode change or a released
 * estimate is never drawn in the transcript, never asks for a display text, and does not change what the restored view shows.
 */
import type { SessionMessage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  type TranscriptBound,
} from '../render/tui/session-view-model.js';
import { restoreSessionTranscript } from './restored-transcript.js';

const timestamp = '2026-11-25T00:00:00.000Z';
const row = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  content: SessionMessage['content'],
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({
  id: `m${String(sequenceNumber)}`,
  sessionId: 's',
  sequenceNumber,
  role,
  content,
  timestamp,
  ...extra,
});
const text = (value: string): SessionMessage['content'] => [{ type: 'text', text: value }];

describe('a restored transcript skips record rows (ADR-0148 §6)', () => {
  it.each<TranscriptBound>([FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND])(
    'draws the same entries with and without them, and reads no display text for them (bound %#)',
    (transcriptBound) => {
      const id = 'session-tool:1:0';
      const messages = [
        row(0, 'system', [], { record: { kind: 'mode_change', from: 'ask', to: 'auto' } }),
        row(1, 'user', text('change the notes')),
        // Inside an open exchange: not a shape the writer produces, but no record row may end (or split) the exchange.
        row(2, 'system', [], { record: { kind: 'mode_change', from: 'auto', to: 'plan' } }),
        row(3, 'assistant', [{ type: 'tool_call', id, name: 'write_file', argsBytes: 2 }]),
        row(4, 'tool', [{ type: 'tool_result', toolCallId: id, resultBytes: 0, outcome: 'ok' }]),
        row(5, 'assistant', text('changed')),
        row(6, 'system', [], { record: { kind: 'cost_release', microcents: 4_200 } }),
        row(7, 'user', text('stop')),
        row(8, 'system', [], { interruption: { reason: 'aborted' } }),
        row(9, 'system', [], { record: { kind: 'mode_change', from: 'auto', to: 'ask' } }),
      ];
      const asked: number[][] = [];
      const restore = (from: readonly SessionMessage[]) =>
        restoreSessionTranscript({
          messages: from,
          memory: undefined,
          transcriptBound,
          readDisplay: (sequences) => {
            asked.push([...sequences]);
            // A display text exists for the user rows only (the store refuses one on any other role).
            return new Map(
              sequences
                .filter((sequence) => sequence === 1 || sequence === 7)
                .map((sequence) => [sequence, `shown ${String(sequence)}`]),
            );
          },
        });
      const entries = restore(messages);
      const plain = restore(messages.filter((message) => message.record === undefined));
      expect(entries).toEqual(plain);
      // No entry says anything a record row holds, and no record row's sequence was asked for a display text.
      expect(JSON.stringify(entries)).not.toMatch(/mode_change|cost_release|4200|auto/u);
      for (const sequences of asked)
        for (const sequence of [0, 2, 6, 9]) expect(sequences).not.toContain(sequence);
    },
  );
});
