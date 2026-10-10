import { describe, expect, it } from 'vitest';
import { SessionEventSchema } from '@relavium/shared';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { makePlainPrinter } from '../commands/chat.js';
import { captureIo } from '../test-support.js';
import { compactionNotice, COMPACTION_UNKNOWN_WINDOW_NOTICE } from './repl-info.js';

const envelope = {
  sessionId: 'compaction-presentation',
  timestamp: '2026-10-10T00:00:00.000Z',
  sequenceNumber: 0,
};
const event = (body: Record<string, unknown>) => SessionEventSchema.parse({ ...envelope, ...body });
const started = event({
  type: 'session:started',
  model: 'claude-sonnet-4-6',
  agentRef: 'chat',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
});

describe('W7 compaction presentation and authoritative footer window', () => {
  for (const reason of ['manual', 'auto-threshold', 'pre-send', 'overflow-recovery'])
    it(`closes the visible admitted moment on failure for ${reason}`, () => {
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      store.apply(started);
      store.apply(event({ type: 'session:compacting', reason, sequenceNumber: 1 }));
      expect(store.getSnapshot().state.compacting).toBe(true);
      store.apply(
        event({
          type: 'session:compaction_failed',
          reason,
          sequenceNumber: 2,
          error: { code: 'budget_exceeded', message: 'safe cap', retryable: false },
        }),
      );
      expect(store.getSnapshot().state.compacting).toBe(false);
      const notices = store.getSnapshot().state.transcript.filter((item) => item.role === 'notice');
      expect(notices).toHaveLength(reason === 'manual' ? 0 : 1);
      if (reason !== 'manual') expect(notices[0]?.text).toContain('budget refused');
    });

  it('renders first-pass after-turn refusal once without opening a compaction moment', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.apply(started);
    store.apply(
      event({
        type: 'session:compaction_budget_refused',
        sequenceNumber: 1,
        reason: 'auto-threshold',
        error: { code: 'budget_exceeded', message: 'safe cap', retryable: false },
      }),
    );
    expect(store.getSnapshot().state.compacting).toBe(false);
    expect(store.getSnapshot().state.transcript).toEqual([
      {
        role: 'notice',
        text: 'Compaction budget refused — the completed reply and conversation are unchanged.',
      },
    ]);
  });

  it('uses the bound provider window and clears it on a custom/unknown reseat', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.setContextWindow?.(12345);
    store.apply(started);
    expect(store.getSnapshot().state.contextWindowTokens).toBe(12345);
    store.setContextWindow?.(undefined);
    store.apply(event({ ...started, sequenceNumber: 1 }));
    expect(store.getSnapshot().state.contextWindowTokens).toBeUndefined();
    expect(store.getSnapshot().state.contextWindowResolved).toBe(true);
  });

  it('never restores a catalog alias window after the bound custom endpoint is unknown', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.setContextWindow?.(undefined);
    store.apply(started);
    expect(store.getSnapshot().state.contextWindowTokens).toBeUndefined();
    expect(COMPACTION_UNKNOWN_WINDOW_NOTICE).toContain('fit cannot be guaranteed');
    expect(COMPACTION_UNKNOWN_WINDOW_NOTICE).not.toContain('16,384');
  });

  it('reports a manual budget outcome with the safe cap and no trim recommendation', () => {
    const notice = compactionNotice({
      kind: 'budget_refused',
      message: 'cap of 23 micro-cents',
      momentOpened: false,
    });
    expect(notice).toContain('cap of 23 micro-cents');
    expect(notice).toContain('unchanged');
    expect(notice).not.toContain('/trim');
  });

  it('routes plain compaction progress and refusal to stderr without polluting generated output', () => {
    const captured = captureIo();
    const print = makePlainPrinter(captured.io);
    print(event({ type: 'session:compacting', reason: 'pre-send' }));
    print(
      event({
        type: 'session:compaction_failed',
        reason: 'pre-send',
        sequenceNumber: 1,
        error: { code: 'budget_exceeded', message: 'safe cap', retryable: false },
      }),
    );
    print(
      event({
        type: 'session:compaction_budget_refused',
        reason: 'auto-threshold',
        sequenceNumber: 2,
        error: { code: 'budget_exceeded', message: 'safe cap', retryable: false },
      }),
    );
    expect(captured.out()).toBe('');
    expect(captured.err()).toContain('summarizing');
    expect(captured.err()).toContain('budget refused');
  });
});
