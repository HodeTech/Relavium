import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  SessionStreamHandleEvent,
  ToolApprovalLiveContext,
  ToolApprovalRequest,
} from '@relavium/core';
import { vi } from 'vitest';

import type { CommandGrantsPort } from '../chat/chat-mode.js';
import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { resolveConfig } from '../config/resolve.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { createChatModeControl, type ChatModeControl } from './chat.js';

/** The two lifecycle events that put a store's turn status to `running` and back to `idle`. */
export const TURN_STARTED: SessionStreamHandleEvent = {
  type: 'session:turn_started',
  sessionId: 'mode-control',
  sequenceNumber: 1,
  timestamp: '2026-11-17T00:00:00.000Z',
};
export const TURN_COMPLETED: SessionStreamHandleEvent = {
  type: 'session:turn_completed',
  sessionId: 'mode-control',
  sequenceNumber: 2,
  timestamp: '2026-11-17T00:00:01.000Z',
  stopReason: 'stop',
  tokensUsed: { input: 1, output: 1 },
};

export interface RealModeControl {
  readonly store: ChatStoreController;
  /** The control `relavium chat` and the Home both receive: the one that owns the footer and the turn policy. */
  readonly control: ChatModeControl;
  /** How many turn policies the session was given: one for the initial mode, one more per mode that really applied. */
  readonly policyPushes: () => number;
  /** The turn policy the session holds now (the last one pushed), whose `confirm` is what decides a governed call. */
  readonly policy: () =>
    | {
        readonly confirm?: (
          request: ToolApprovalRequest,
          signal?: undefined,
          live?: ToolApprovalLiveContext,
        ) => Promise<unknown>;
      }
    | undefined;
  readonly workspace: string;
  readonly dispose: () => Promise<void>;
}

/**
 * The production mode control over a real built session and store (default `ask` start), so a surface test can press
 * Shift+Tab and observe the footer mode, the turn policy the session received and the notice — not a stub of them.
 */
export async function realModeControl(options?: {
  readonly commandGrants?: CommandGrantsPort;
}): Promise<RealModeControl> {
  const workspace = mkdtempSync(join(tmpdir(), 'relavium-mode-control-'));
  const built = await buildChatSession({
    chat: resolveConfig({}).chat,
    operatorHomeDir: workspace,
    outputStoreFactory: () => Promise.resolve(undefined),
    agentRef: undefined,
    cwd: workspace,
    projectConfigDir: undefined,
    providers: scriptedResolver([]),
    now: Date.now,
    uuid: randomUUID,
  });
  const pushes = vi.spyOn(built.session, 'setTurnPolicy');
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const control = createChatModeControl(
    built,
    store,
    options?.commandGrants === undefined ? undefined : { commandGrants: options.commandGrants },
  );
  return {
    store,
    control,
    policyPushes: () => pushes.mock.calls.length,
    policy: () => pushes.mock.calls.at(-1)?.[0],
    workspace,
    dispose: async () => {
      built.session.cancel();
      await built.whenHostSafeToClose();
      await built.closeOutputStore?.();
      await built.closeMcp?.();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
