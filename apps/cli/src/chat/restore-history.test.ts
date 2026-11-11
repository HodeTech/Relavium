import { describe, expect, it, vi } from 'vitest';
import { SessionMessageSchema } from '@relavium/shared';
import { prepareRestoredHistory } from './restore-history.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { resumeHint } from './resume-hint.js';

const messages = [
  SessionMessageSchema.parse({
    id: 'm',
    sessionId: 's',
    sequenceNumber: 0,
    role: 'user',
    content: [{ type: 'text', text: 'PRIVATE_CANONICAL' }],
    timestamp: '2026-11-10T00:00:00.000Z',
  }),
  SessionMessageSchema.parse({
    id: 'a',
    sessionId: 's',
    sequenceNumber: 1,
    role: 'assistant',
    content: [{ type: 'text', text: 'saved answer' }],
    timestamp: '2026-11-10T00:00:01.000Z',
  }),
];
describe('restored display read recovery', () => {
  it.each([true, false])(
    'offers retry without falling back to canonical bytes (retry=%s)',
    async (retry) => {
      const read = vi.fn(() => new Map([[0, 'visible form']]));
      read.mockImplementationOnce(() => {
        throw new Error('PRIVATE_SQL_FAILURE');
      });
      const decision = vi.fn(() => Promise.resolve(retry));
      const result = await prepareRestoredHistory({
        messages,
        memory: undefined,
        transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
        readDisplay: read,
        assertAdmitting: () => {},
        retry: decision,
      });
      expect(decision).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(retry ? 2 : 1);
      if (retry) expect(JSON.stringify(result)).toContain('visible form');
      else expect(result).toBeUndefined();
      expect(JSON.stringify(result) ?? '').not.toContain('PRIVATE');
    },
  );
  it('propagates stopped admission and never offers recovery after termination', async () => {
    const retry = vi.fn(() => Promise.resolve(true));
    await expect(
      prepareRestoredHistory({
        messages,
        memory: undefined,
        transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
        readDisplay: () => new Map(),
        assertAdmitting: () => {
          throw new Error('stopped');
        },
        retry,
      }),
    ).rejects.toThrow('stopped');
    expect(retry).not.toHaveBeenCalled();
  });
  it('only inserts shell-neutral saved ids into commands', () => {
    expect(resumeHint('safe-123')).toContain('chat resume safe-123');
    for (const id of [
      '$(touch /tmp/example)',
      '-option',
      'a b',
      'a;command',
      '\x1b[31m',
      'a\ncommand',
    ]) {
      expect(resumeHint(id)).not.toContain(id);
      expect(resumeHint(id)).toContain('picker');
    }
  });
});
