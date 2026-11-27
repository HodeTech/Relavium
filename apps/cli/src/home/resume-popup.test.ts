/**
 * `/resume` as a popup (ADR-0148 §1, §3, §6; MVP-11 unit 6, 6.4): ONE frame from the picker to the restore it leads to (the picker's own
 * begin and end nest in it, so nothing closes between the stages and the opening settle runs once), the rail `Session · Restore`, the restore's
 * wait and its retry question on the second step, `Esc` at each stage, every word of a saved session scrubbed before it reaches the channel, and
 * the controller's side: the whole resume inside the host's frame, and everything it has to say on the Home's notification channel, never in
 * the Home's notice or the conversation. The restore itself (`resumeChat`) is `drive-home.test.ts`'s and `home-resume-cancellation.test.ts`'s.
 */
import type { SessionPage, SessionPageRow } from '@relavium/db';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { retryRestoredHistory } from '../chat/restore-history.js';
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import type { NativePickerResult } from '../render/tui/native-picker.js';
import { createChatStore } from '../render/tui/chat-store.js';
import {
  createHomeController,
  RESUME_ALREADY_OPEN,
  RESUME_CANCELLED,
  type HomeChatSession,
  type HomeControllerDeps,
} from '../render/tui/home-controller.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { RESUME_UNAVAILABLE as SESSIONS_RESUME_UNAVAILABLE } from '../render/tui/home-controller.js';
import {
  createSessionPickerSource,
  RESUME_RESTORING,
  RESUME_STEP,
  resumePopup,
  runSessionPicker,
} from './session-picker.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const ESC: Key = { ...none, escape: true };
const DOWN: Key = { ...none, downArrow: true };

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const ROWS: readonly SessionPageRow[] = [
  {
    id: 's1',
    title: 'Fix the flaky test',
    agentSlug: 'chat',
    updatedAt: '2026-11-25T11:00:00.000Z',
    workingDir: '/work/project',
  },
  {
    id: 's2',
    agentSlug: 'reviewer',
    updatedAt: '2026-11-24T11:00:00.000Z',
    workingDir: '/work/project',
  },
];

/** The real channel on a clock the test moves; the host's acknowledgement is `show`. */
function rig(rows: readonly SessionPageRow[] = ROWS) {
  let clock = 50_000;
  const channel = createNativePromptChannel({ now: () => clock });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
  const page: SessionPage = { sessions: rows };
  const picker = {
    store: { listSessionPage: () => page },
    cwd: '/work/project',
    now: () => NOW,
    assertAdmitting: () => {},
    runRead: (operation: () => Promise<NativePickerResult>) => operation(),
  };
  return {
    channel,
    published,
    picker,
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    advance: (ms: number): void => {
      clock += ms;
    },
    show: (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    },
    key: (key: Key): boolean => channel.ui.input('', key),
  };
}

async function until(
  r: ReturnType<typeof rig>,
  holds: (snapshot: NativePromptSnapshot) => boolean,
): Promise<void> {
  for (let turn = 0; turn < 50 && !holds(r.snapshot()); turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(holds(r.snapshot()), `${r.snapshot().kind}: ${r.snapshot().message}`).toBe(true);
}

describe('one frame from the picker to the restore', () => {
  it.each(['home', 'chat'] as const)(
    'from %s: the picker on the Session step, the wait and the retry question on the Restore step, and nothing closed between them',
    async (origin) => {
      const r = rig();
      const flow = resumePopup(r.channel.flow, origin);
      const signal = flow.begin();
      expect(r.snapshot().popup).toEqual({
        title: '/resume',
        origin,
        stepIndex: 0,
        stepCount: 2,
        stepNames: ['Session', 'Restore'],
        exitLabel: 'close',
        depth: 1,
      });
      const picked = runSessionPicker({ ...r.picker, flow });
      await until(r, (s) => s.kind === 'picker' && s.options.length === 2);
      expect(r.snapshot().popup?.stepIndex).toBe(RESUME_STEP.session);
      expect(r.snapshot().message).toBe('Resume a session');
      r.show();
      r.advance(POPUP_SELECT_SETTLE_MS + 1);
      r.key(DOWN);
      r.key(ENTER);
      expect(await picked).toBe('s2');
      const afterPick = r.published.length;
      // The restore, in the same frame.
      flow.at(RESUME_STEP.restore).busy(RESUME_RESTORING);
      expect(r.snapshot()).toMatchObject({
        kind: 'busy',
        message: 'Restoring session…',
        popup: { stepIndex: 1 },
      });
      const retry = retryRestoredHistory(flow);
      expect(r.snapshot()).toMatchObject({ kind: 'select', popup: { stepIndex: 1 } });
      expect(r.snapshot().options[r.snapshot().selected]?.label, 'the safe default').toBe('Return');
      // The opening settle is the frame's, once: the question takes its answer at once.
      r.show();
      r.key({ ...none, upArrow: true });
      r.key(ENTER);
      expect(await retry).toBe(true);
      expect(
        r.published.slice(afterPick).some((snapshot) => !snapshot.active),
        'no closed frame between the picker and the restore',
      ).toBe(false);
      expect(signal.aborted).toBe(false);
      await flow.end();
      expect(r.snapshot().active).toBe(false);
      expect(r.snapshot().popup).toBeUndefined();
    },
  );

  it('Esc on the picker closes its stage (the outer frame holds until the host ends it); Esc on the restore`s wait cancels it', async () => {
    const r = rig();
    const flow = resumePopup(r.channel.flow, 'home');
    const signal = flow.begin();
    const picked = runSessionPicker({ ...r.picker, flow });
    await until(r, (s) => s.kind === 'picker' && s.options.length === 2);
    r.key(ESC); // leaving acts at once, even inside the opening settle
    expect(await picked).toBeUndefined();
    expect(signal.aborted, 'the popup is closed: its flow is cancelled').toBe(true);
    await flow.end();

    const again = rig();
    const restore = resumePopup(again.channel.flow, 'home');
    const restoring = restore.begin();
    restore.at(RESUME_STEP.restore).busy(RESUME_RESTORING);
    again.key(ESC);
    expect(restoring.aborted, '`Esc cancels it`').toBe(true);
    await restore.end();
  });

  it('Esc on the retry question cancels the resume, and its legend says what Esc does', async () => {
    const r = rig();
    const flow = resumePopup(r.channel.flow, 'chat');
    flow.begin();
    flow.at(RESUME_STEP.restore).busy(RESUME_RESTORING);
    const retry = retryRestoredHistory(flow);
    expect(r.snapshot().escape).toBe('cancel');
    r.key(ESC);
    expect(await retry).toBe(false);
    await flow.end();
  });

  it('a picker answer that is not a pick (a cancel) is no resume', async () => {
    const r = rig();
    const flow = resumePopup(r.channel.flow, 'home');
    flow.begin();
    const picked = runSessionPicker({ ...r.picker, flow });
    await until(r, (s) => s.kind === 'picker');
    r.channel.flow.cancel();
    expect(await picked).toBeUndefined();
    expect(NATIVE_PROMPT_CANCEL).toBeTypeOf('symbol');
    await flow.end();
  });
});

describe('every word of a saved session is scrubbed before it reaches the channel', () => {
  const ESC_CHAR = String.fromCharCode(0x1b);
  const HOSTILE = [
    `${ESC_CHAR}[31mred${ESC_CHAR}[0m`,
    `${ESC_CHAR}]52;c;Zm9v${String.fromCharCode(0x07)}clip`,
    `c1${String.fromCharCode(0x85, 0x9b)}[2J`,
    `bidi${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x2066)}x`,
    `zero${String.fromCharCode(0x200b)}width${String.fromCharCode(0xfeff)}`,
    'Press Ctrl+Y now',
    '[Ctrl+Y] Resume · [d] withdraw · Esc close',
    String.fromCharCode(0xff3b, 0xff23, 0xff54, 0xff52, 0xff4c, 0xff0b, 0xff39, 0xff3d),
    `sk-ant-api03-${'B'.repeat(40)}`,
    'long '.repeat(80).trim(),
  ];
  const unsafe = (text: string): boolean =>
    Array.from(text).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x09) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0x200b ||
        code === 0xfeff
      );
    });

  it.each(HOSTILE.map((text, index) => [index, text] as const))(
    'hostile text %i as a title, an agent`s slug and a directory: no control, no key token, one separator of the picker`s own',
    async (_index, hostile) => {
      const rows: SessionPageRow[] = [
        {
          id: 'h1',
          title: hostile,
          agentSlug: 'chat',
          updatedAt: '2026-11-25T11:00:00.000Z',
          workingDir: `/elsewhere/${hostile}`,
        },
        {
          id: 'h2',
          agentSlug: hostile,
          updatedAt: '2026-11-25T10:00:00.000Z',
          workingDir: '/work/project',
        },
      ];
      const load = createSessionPickerSource({
        store: { listSessionPage: () => ({ sessions: rows }) },
        cwd: '/work/project',
        now: () => NOW,
        assertAdmitting: () => {},
        runRead: (operation) => operation(),
      });
      const result = await load('', true, new AbortController().signal);
      if ('unavailable' in result) throw new Error('the page was not read');
      for (const option of result.options)
        for (const text of [option.label, option.hint ?? '']) {
          expect(unsafe(text), JSON.stringify(text)).toBe(false);
          // No answer chord and no bracketed key token: a title cannot draw the popup's own legend.
          expect(text).not.toMatch(/Ctrl\+Y|\[d\]/u);
          expect(text).not.toContain('sk-ant-api03-BBBB');
        }
      // The picker's own separator before the age is the one ` · ` of the row: a title's is made inert.
      for (const option of result.options)
        expect(option.label.split(' · ').length, option.label).toBe(2);
    },
  );
});

describe('the Home runs the whole resume inside the frame, and says what it has to say in one notification', () => {
  function home(options: {
    readonly pick?: string | undefined;
    readonly resume?: HomeControllerDeps['resumeChat'];
    readonly withChat?: boolean;
    readonly frame?: boolean;
  }) {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const note = vi.spyOn(store, 'note');
    const session: HomeChatSession = {
      store,
      sessionId: 'open-chat',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const order: string[] = [];
    const announced: string[] = [];
    const frames: string[] = [];
    const controller = createHomeController({
      startChat: () => Promise.resolve(session),
      homeStore: {
        read: () => ({
          failedRuns: [],
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRuns: [],
          totals: { attention: 0, sessions: 0, runs: 0 },
          isEmpty: true,
        }),
      },
      onExit: vi.fn(),
      onError: (cause) => {
        throw cause;
      },
      announce: (text) => announced.push(text),
      pickSession: () => {
        order.push('pick');
        return Promise.resolve(options.pick);
      },
      ...(options.resume === undefined
        ? {}
        : {
            resumeChat: (id: string) => {
              order.push(`resume ${id}`);
              return options.resume?.(id) ?? Promise.resolve(undefined);
            },
          }),
      ...(options.frame === false
        ? {}
        : {
            resumeFrame: async (origin: 'home' | 'chat', run: () => Promise<void>) => {
              frames.push(origin);
              order.push('open');
              await run();
              order.push('close');
            },
          }),
    });
    return { controller, note, order, announced, frames, store };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const typeResume = async (controller: ReturnType<typeof home>['controller']): Promise<void> => {
    controller.handlePaste('/resume');
    controller.handleKey('', { return: true });
    await settle();
  };
  const toChat = async (h: ReturnType<typeof home>): Promise<void> => {
    h.controller.handlePaste('hello');
    h.controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(h.controller.getSnapshot().mode).toBe('chat'));
  };

  it('opens the frame once, from Home, around the picker and the restore', async () => {
    const h = home({ pick: 's1', resume: () => Promise.resolve(undefined) });
    await typeResume(h.controller);
    expect(h.frames).toEqual(['home']);
    expect(h.order).toEqual(['open', 'pick', 'resume s1', 'close']);
    expect(h.announced).toEqual([RESUME_CANCELLED]);
    expect(h.controller.getSnapshot().notice).toBeUndefined();
  });

  it('from the chat the Home hosts: the frame says so, and a refusal is a notification, never a line in the conversation', async () => {
    const h = home({
      pick: 's1',
      resume: () => Promise.resolve({ notice: 'This saved session is unavailable.' }),
    });
    await toChat(h);
    await typeResume(h.controller);
    expect(h.frames).toEqual(['chat']);
    expect(h.announced).toEqual(['This saved session is unavailable.']);
    expect(h.note).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().notice).toBeUndefined();
  });

  it('the conversation that is already open: one notification once the frame has closed, nothing restored, nothing in the conversation', async () => {
    const h = home({ pick: 'open-chat', resume: () => Promise.resolve(undefined) });
    await toChat(h);
    await typeResume(h.controller);
    expect(h.order).toEqual(['open', 'pick', 'close']);
    expect(h.announced).toEqual([RESUME_ALREADY_OPEN]);
    expect(h.note).not.toHaveBeenCalled();
  });

  it('a picker left with Esc says nothing; a Home that cannot resume says so in one notification and opens no frame', async () => {
    const left = home({ pick: undefined, resume: () => Promise.resolve(undefined) });
    await typeResume(left.controller);
    expect(left.order).toEqual(['open', 'pick', 'close']);
    expect(left.announced).toEqual([]);

    const unavailable = home({});
    await typeResume(unavailable.controller);
    expect(unavailable.frames).toEqual([]);
    expect(unavailable.announced).toEqual([SESSIONS_RESUME_UNAVAILABLE]);
    expect(unavailable.controller.getSnapshot().notice).toBeUndefined();
  });

  it('with no frame wired (a test`s Home) the stages run as they are', async () => {
    const h = home({ pick: 's1', resume: () => Promise.resolve(undefined), frame: false });
    await typeResume(h.controller);
    expect(h.order).toEqual(['pick', 'resume s1']);
    expect(h.announced).toEqual([RESUME_CANCELLED]);
  });
});
