import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildChatSession } from '../chat/session-host.js';
import { scriptedResolver } from '../chat/test-support.js';
import { resolveConfig } from '../config/resolve.js';
import { MODE_CHANGE_RUNNING_NOTICE } from '../render/tui/chat-input.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { createNotificationChannel } from '../popups/notifications.js';
import { TURN_COMPLETED, TURN_STARTED } from './chat-mode-control.test-support.js';
import { createChatModeControl, type ChatModeControl } from './chat.js';

/**
 * SE7-1 (the scoped security sitting of unit 7): a mode change refused while a turn runs says `Mode changes apply between turns · Esc stops the
 * running turn`. That is true only while the turn runs, so the refusal is WITHDRAWN when the turn ends (the control raised it, so the control
 * knows which turn it spoke about): it must not stay on the hint row for the rest of its three seconds, saying a turn runs when none does.
 * These tests run the production control over a real built session, a real store and the real notification channel.
 */
interface Rig {
  readonly store: ChatStoreController;
  readonly control: ChatModeControl;
  readonly channel: ReturnType<typeof createNotificationChannel>;
  /** Every call the control made on its announcer, in order: the text and the topic. */
  readonly calls: (readonly [string, string | undefined])[];
}

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function rig(): Promise<Rig> {
  const workspace = mkdtempSync(join(tmpdir(), 'relavium-refusal-withdrawal-'));
  dirs.push(workspace);
  const built = await buildChatSession({
    chat: resolveConfig({}).chat,
    operatorHomeDir: workspace,
    outputStoreFactory: () => Promise.resolve(undefined),
    agentRef: undefined,
    cwd: workspace,
    providers: scriptedResolver([]),
    projectConfigDir: undefined,
    now: Date.now,
    uuid: randomUUID,
  });
  closers.push(async () => {
    built.session.cancel();
    await built.whenHostSafeToClose();
    await built.closeOutputStore?.();
    await built.closeMcp?.();
  });
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const channel = createNotificationChannel();
  closers.push(() => {
    channel.dispose();
    return Promise.resolve();
  });
  const calls: (readonly [string, string | undefined])[] = [];
  const control = createChatModeControl(built, store, {
    announce: (text, topic) => {
      calls.push([text, topic]);
      channel.notify(text, undefined, topic);
    },
    commandPaths: undefined,
  });
  return { store, control, channel, calls };
}

describe('the refusal of a mode change while a turn runs is withdrawn when that turn ends (SE7-1)', () => {
  it('shows at once on the channel while the turn runs, and is gone from it the moment the turn ends', async () => {
    const r = await rig();
    r.store.apply(TURN_STARTED);
    expect(r.control.onModeChange('auto')).toBe(false);
    expect(r.channel.getSnapshot().current?.text).toBe(MODE_CHANGE_RUNNING_NOTICE);
    r.store.apply(TURN_COMPLETED);
    expect(
      r.channel.getSnapshot().current,
      'a refusal that says a turn runs must not outlive the turn',
    ).toBeUndefined();
    expect(r.calls.at(-1), 'withdrawn through its own topic, with no text').toEqual(['', 'mode']);
  });

  it('is withdrawn even while it waits behind another notification', async () => {
    const r = await rig();
    r.channel.notify('Something else');
    r.store.apply(TURN_STARTED);
    r.control.onModeChange('auto');
    expect(r.channel.getSnapshot().current?.text).toBe('Something else');
    expect(r.channel.getSnapshot().queued).toBe(1);
    r.store.apply(TURN_COMPLETED);
    expect(r.channel.getSnapshot().queued, 'the waiting refusal is gone').toBe(0);
    expect(r.channel.getSnapshot().current?.text, 'the other notification is untouched').toBe(
      'Something else',
    );
  });

  it('withdraws once however many times the key was pressed, and never when no refusal was raised', async () => {
    const r = await rig();
    r.store.apply(TURN_STARTED);
    r.control.onModeChange('auto');
    r.control.onModeChange('plan');
    r.control.onModeChange('auto');
    r.store.apply(TURN_COMPLETED);
    expect(r.calls.filter(([text]) => text === '')).toEqual([['', 'mode']]);
    r.calls.length = 0;
    r.store.apply({ ...TURN_STARTED, sequenceNumber: 10 });
    expect(r.store.getSnapshot().state.status).toBe('running');
    r.store.apply({ ...TURN_COMPLETED, sequenceNumber: 11 });
    expect(r.store.getSnapshot().state.status).toBe('idle');
    expect(r.calls, 'a turn with no refusal announces nothing').toEqual([]);
  });

  it('refuses and withdraws again on the next turn', async () => {
    const r = await rig();
    for (let turn = 0; turn < 2; turn += 1) {
      // a later turn's events carry later sequence numbers (the store drops a stale one)
      r.store.apply({ ...TURN_STARTED, sequenceNumber: 10 + turn * 2 });
      expect(r.store.getSnapshot().state.status).toBe('running');
      r.control.onModeChange('auto');
      expect(r.channel.getSnapshot().current?.text).toBe(MODE_CHANGE_RUNNING_NOTICE);
      r.store.apply({ ...TURN_COMPLETED, sequenceNumber: 11 + turn * 2 });
      expect(r.channel.getSnapshot().current).toBeUndefined();
    }
  });

  it('keeps the record-first outcome of the refusal: the mode stays, no policy is pushed, nothing reaches the transcript', async () => {
    const r = await rig();
    r.store.apply(TURN_STARTED);
    expect(r.control.onModeChange('auto')).toBe(false);
    expect(r.store.getSnapshot().mode).toBe('ask');
    expect(
      r.store.getSnapshot().state.transcript.filter((entry) => entry.role === 'notice'),
    ).toEqual([]);
  });

  it('a control with no channel still says the refusal in the transcript, and has nothing to withdraw', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'relavium-refusal-nochannel-'));
    dirs.push(workspace);
    const built = await buildChatSession({
      chat: resolveConfig({}).chat,
      operatorHomeDir: workspace,
      outputStoreFactory: () => Promise.resolve(undefined),
      agentRef: undefined,
      cwd: workspace,
      providers: scriptedResolver([]),
      projectConfigDir: undefined,
      now: Date.now,
      uuid: randomUUID,
    });
    closers.push(async () => {
      built.session.cancel();
      await built.whenHostSafeToClose();
      await built.closeOutputStore?.();
      await built.closeMcp?.();
    });
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const control = createChatModeControl(built, store, { commandPaths: undefined });
    store.apply(TURN_STARTED);
    control.onModeChange('auto');
    store.apply(TURN_COMPLETED);
    expect(
      store
        .getSnapshot()
        .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : [])),
    ).toEqual([MODE_CHANGE_RUNNING_NOTICE]);
  });
});
