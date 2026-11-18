import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryEffectJournal, type ToolHost } from '@relavium/core';
import type { StreamChunk } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import { createChatModeControl } from '../commands/chat.js';
import { resolveConfig } from '../config/resolve.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { buildChatSession } from './session-host.js';
import { StartingModeAuthority, type StartingModePreference } from './starting-mode.js';
import {
  collectSubscribedSessionEvents,
  scriptedResolver,
  stop,
  textTurn,
} from './test-support.js';

const auto: StartingModePreference = {
  mode: 'auto',
  source: 'global',
  globalMode: 'auto',
  hintShown: true,
};
const write: StreamChunk[] = [
  { type: 'tool_call_start', id: 'write', name: 'write_file' },
  {
    type: 'tool_call_delta',
    id: 'write',
    argsJsonDelta: JSON.stringify({ path: 'file.txt', content: 'new' }),
  },
  { type: 'tool_call_end', id: 'write' },
  stop('tool_use'),
];

describe('starting auto at the real captured-turn final dispatch gate', () => {
  it.each([
    'narrower',
    'read-error',
    'explicit-next-turn',
    'explicit-before-turn',
    'not-revoked',
  ] as const)('%s while durable preparation is in flight', async (change) => {
    const workspace = mkdtempSync(join(tmpdir(), 'rlv-mode-dispatch-'));
    const authority = new StartingModeAuthority(true, auto);
    let release: () => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(() => Promise.resolve({ path: 'file.txt', bytesWritten: 3 }));
    const releaseFile = vi.fn();
    const host: ToolHost = {
      yieldControl: () => Promise.resolve(),
      fs: {
        readFile: () =>
          Promise.resolve({ content: '', mimeType: 'text/plain', sizeBytes: 0, lastModified: '' }),
        writeFile: execute,
        listDirectory: () => Promise.resolve({ entries: [] }),
        prepareWrite: (request) =>
          Promise.resolve({
            path: request.path,
            before: null,
            after: 'new',
            execute,
            release: releaseFile,
          }),
      },
    };
    let claims = 0;
    let discards = 0;
    const built = await buildChatSession({
      startingMode: authority.resolve(() => auto),
      chat: resolveConfig({}).chat,
      operatorHomeDir: workspace,
      outputStoreFactory: () => Promise.resolve(undefined),
      toolHost: host,
      agentRef: undefined,
      cwd: workspace,
      projectConfigDir: undefined,
      providers: scriptedResolver([write, textTurn('done')]),
      now: Date.now,
      uuid: randomUUID,
    });
    let ordinal = 0;
    built.attachUsageWriter({
      initialCoverage: () => ({
        coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
        models: [],
        started: true,
        highWater: 0,
      }),
      begin: (draft) =>
        Promise.resolve(
          Object.freeze({
            producerId: 'starting-mode-test',
            ordinal: ++ordinal,
            dispatchId: draft.nodeId,
            round: draft.round,
            chainAttempt: draft.chainAttempt,
          }),
        ),
      disposition: () => undefined,
      record: () => undefined,
    });
    let effectTurn = 0;
    built.attachEffectTurnAllocator(() => ++effectTurn);
    built.attachEffectJournal((correlation) => {
      const journal = createInMemoryEffectJournal(correlation);
      return {
        ...journal,
        prepare: async (...args) => {
          const result = await journal.prepare(...args);
          claims += 1;
          await preparing;
          return result;
        },
        discard: (...args) => {
          discards += 1;
          return journal.discard(...args);
        },
      };
    });
    const events = collectSubscribedSessionEvents(built.handle);
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const control = createChatModeControl(built, store);
    expect(store.getSnapshot().mode).toBe('auto');
    if (change === 'explicit-before-turn') {
      authority.revoke();
      control.onModeChange('auto');
    }
    try {
      built.session.start();
      const turn = built.session.sendMessage('create the file');
      await vi.waitFor(() => expect(claims).toBe(1));
      if (change === 'read-error')
        expect(() =>
          authority.resolve(() => {
            throw new Error('unreadable config');
          }),
        ).toThrow();
      else if (change !== 'not-revoked' && change !== 'explicit-before-turn')
        authority.resolve(() => ({ ...auto, mode: 'ask' }));
      if (change === 'explicit-next-turn') control.onModeChange('auto');
      release();
      await turn;
      built.session.cancel();
      const completed = (await events).find((event) => event.type === 'session:turn_completed');
      expect(completed?.type).toBe('session:turn_completed');
      if (completed?.type !== 'session:turn_completed') throw new Error('missing turn result');
      if (change === 'not-revoked' || change === 'explicit-before-turn') {
        expect(execute).toHaveBeenCalledOnce();
        expect(discards).toBe(0);
        expect(completed.error).toBeUndefined();
      } else {
        expect(execute, 'W2_STARTUP_AUTO_FINAL_DISPATCH').not.toHaveBeenCalled();
        expect(completed.error?.code).toBe('tool_denied');
        expect(completed.error?.retryable).toBe(false);
        expect(discards).toBe(1);
        expect(() => authority.resolve(() => auto)).toThrow('no longer admitted');
      }
      expect(releaseFile).toHaveBeenCalledOnce();
    } finally {
      release();
      built.session.cancel();
      await built.whenHostSafeToClose();
      await built.closeOutputStore?.();
      await built.closeMcp?.();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
